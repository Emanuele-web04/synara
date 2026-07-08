// FILE: providerUsage/providers/claude.ts
// Purpose: Live Claude (Anthropic) usage fetcher. Reads the Claude Code OAuth token from
// ~/.claude/.credentials.json or the macOS keychain ("Claude Code-credentials", possibly
// hex-encoded) read-only, and calls the OAuth usage endpoint, mapping the 5h/weekly/sonnet
// utilization windows + extra-usage credits. Reference: openusage plugins/claude/plugin.js.

import { createHash } from "node:crypto";
import nodePath from "node:path";

import type {
  ServerProviderUsageLimit,
  ServerProviderUsageLine,
  ServerProviderUsageSnapshot,
} from "@t3tools/contracts";

import {
  decodeKeychainJson,
  readJsonFile,
  readKeychainPassword,
  refreshOAuthAccessToken,
} from "../credentials";
import { fetchJson, isAuthFailureStatus, isRateLimitStatus, parseRetryAfterMs } from "../http";
import {
  asFiniteNumber,
  asRecord,
  asString,
  buildSnapshot,
  clampPercent,
  errorSnapshot,
  formatUsd,
  isoFromString,
  needsAuthSnapshot,
  titleCase,
} from "../parse";
import { createRateLimitResilience } from "../rateLimitResilience";
import type { ProviderUsageContext, ProviderUsageFetcher } from "../types";

const SOURCE = "claude-oauth-usage";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const REFRESH_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const SCOPES =
  "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

interface ClaudeCreds {
  accessToken: string;
  refreshToken: string | undefined;
  expiresAtMs: number | undefined;
  subscriptionType: string | undefined;
  rateLimitTier: string | undefined;
  scopes: ReadonlyArray<string>;
}

function readScopes(oauth: Record<string, unknown> | null): ReadonlyArray<string> {
  if (Array.isArray(oauth?.scopes)) {
    return oauth.scopes.filter((scope): scope is string => typeof scope === "string");
  }
  const scopeText = asString(oauth?.scope);
  return scopeText ? scopeText.split(/\s+/u).filter((scope) => scope.length > 0) : [];
}

function readClaudeCreds(record: Record<string, unknown> | null): ClaudeCreds | null {
  const oauth = asRecord(record?.claudeAiOauth);
  const accessToken = asString(oauth?.accessToken);
  if (!accessToken) {
    return null;
  }
  return {
    accessToken,
    refreshToken: asString(oauth?.refreshToken),
    expiresAtMs: asFiniteNumber(oauth?.expiresAt),
    subscriptionType: asString(oauth?.subscriptionType),
    rateLimitTier: asString(oauth?.rateLimitTier),
    scopes: readScopes(oauth),
  };
}

async function resolveClaudeCredCandidates(ctx: ProviderUsageContext): Promise<ClaudeCreds[]> {
  const candidates: ClaudeCreds[] = [];
  const paths: string[] = [];
  if (ctx.env.CLAUDE_CONFIG_DIR) {
    paths.push(nodePath.join(ctx.env.CLAUDE_CONFIG_DIR, ".credentials.json"));
  }
  paths.push(nodePath.join(ctx.homeDir, ".claude", ".credentials.json"));

  for (const path of paths) {
    const record = asRecord(await readJsonFile(path));
    const creds = readClaudeCreds(record);
    if (creds) {
      candidates.push(creds);
    }
  }

  // Claude Code may store the same service under the current macOS account; try that before
  // the legacy service-only lookup so file-less installs still resolve like OpenUsage.
  const keychainAccount = asString(ctx.env.USER) ?? asString(ctx.env.LOGNAME);
  const keychain =
    keychainAccount !== undefined
      ? await readKeychainPassword({
          service: KEYCHAIN_SERVICE,
          account: keychainAccount,
          platform: ctx.platform,
        })
      : null;
  const keychainFallback =
    keychain ??
    (await readKeychainPassword({
      service: KEYCHAIN_SERVICE,
      platform: ctx.platform,
    }));
  if (keychainFallback) {
    const creds = readClaudeCreds(asRecord(decodeKeychainJson(keychainFallback)));
    if (creds) {
      candidates.push(creds);
    }
  }
  return candidates;
}

function hasProfileScope(creds: ClaudeCreds): boolean {
  return creds.scopes.length === 0 || creds.scopes.includes("user:profile");
}

function shouldRefreshClaudeCreds(creds: ClaudeCreds, nowMs: number): boolean {
  return creds.expiresAtMs !== undefined && creds.expiresAtMs <= nowMs + REFRESH_BUFFER_MS;
}

function claudePlanName(creds: ClaudeCreds): string | undefined {
  if (!creds.subscriptionType) {
    return undefined;
  }
  let name = titleCase(creds.subscriptionType);
  const tier = creds.rateLimitTier?.match(/(\d+x)/iu)?.[1];
  if (tier) {
    name += ` (${tier.toLowerCase()})`;
  }
  return name;
}

// Builds a non-secret cooldown key tied to the credential currently resolved from disk/keychain.
function claudeCredentialCacheKey(ctx: ProviderUsageContext, creds: ClaudeCreds): string {
  const stableSecret = creds.refreshToken ?? creds.accessToken;
  const digest = createHash("sha256").update(stableSecret).digest("base64url").slice(0, 18);
  return `${ctx.homeDir}:${digest}`;
}

function applyRefreshedClaudeCreds(
  creds: ClaudeCreds,
  refreshed: { accessToken: string; refreshToken?: string; expiresAtMs?: number },
): ClaudeCreds {
  return {
    ...creds,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken ?? creds.refreshToken,
    expiresAtMs: refreshed.expiresAtMs ?? creds.expiresAtMs,
  };
}

async function refreshClaudeCreds(creds: ClaudeCreds): Promise<ClaudeCreds | null> {
  if (!creds.refreshToken) {
    return null;
  }
  const refreshed = await refreshOAuthAccessToken({
    refreshUrl: REFRESH_URL,
    refreshToken: creds.refreshToken,
    clientId: CLIENT_ID,
    scope: SCOPES,
  });
  return refreshed ? applyRefreshedClaudeCreds(creds, refreshed) : null;
}

export function parseClaudeUsage(input: { json: unknown; nowMs: number; planName?: string }) {
  const root = asRecord(input.json);
  const limits: ServerProviderUsageLimit[] = [];
  const usageLines: ServerProviderUsageLine[] = [];

  const pushWindow = (label: string, windowValue: unknown, windowDurationMins: number): void => {
    const window = asRecord(windowValue);
    if (!window) {
      return;
    }
    const usedPercent = clampPercent(asFiniteNumber(window.utilization));
    const resetsAt = isoFromString(window.resets_at);
    if (usedPercent === undefined && !resetsAt) {
      return;
    }
    limits.push({
      window: label,
      ...(usedPercent !== undefined ? { usedPercent } : {}),
      ...(resetsAt ? { resetsAt } : {}),
      windowDurationMins,
    });
  };

  pushWindow("5h", root?.five_hour, 300);
  pushWindow("Weekly", root?.seven_day, 10_080);
  pushWindow("Sonnet", root?.seven_day_sonnet, 10_080);
  pushWindow("Opus", root?.seven_day_opus, 10_080);

  const extra = asRecord(root?.extra_usage);
  if (extra && extra.is_enabled !== false) {
    const usedCredits = asFiniteNumber(extra.used_credits);
    const monthlyLimit = asFiniteNumber(extra.monthly_limit);
    if (usedCredits !== undefined) {
      const usedUsd = formatUsd(usedCredits / 100);
      const value =
        monthlyLimit && monthlyLimit > 0
          ? `${usedUsd} of ${formatUsd(monthlyLimit / 100)}`
          : `${usedUsd} spent`;
      usageLines.push({ label: "Extra usage", value });
    }
  }

  return buildSnapshot({
    provider: "claudeAgent",
    nowMs: input.nowMs,
    status: "ok",
    source: SOURCE,
    limits,
    usageLines,
    ...(input.planName ? { planName: input.planName } : {}),
  });
}

// --- Rate-limit resilience (mirrors OpenUsage's ClaudeProvider, PR #849) --------------------------
// Anthropic throttles the usage endpoint for heavy Claude Code users; a bare 429 (or a transient
// blip) must not blank the usage panel. The shared helper remembers the last clean fetch per account
// and keeps serving it — with a staleness note — while backing off. Keyed by a credential fingerprint
// so a removed or switched Claude login can't be served another account's cached numbers.
const claudeRateLimit = createRateLimitResilience({
  provider: "claudeAgent",
  source: SOURCE,
  detail: (retryMins) =>
    `Anthropic is rate-limiting usage checks — showing your last values, retrying in ~${retryMins}m. Manual refreshes only extend the limit.`,
});

/** Test-only: clear the cross-call last-good/cooldown memory so cases start from a cold state. */
export function __resetClaudeUsageRateLimitState(): void {
  claudeRateLimit.reset();
}

export const claudeUsageFetcher: ProviderUsageFetcher = {
  provider: "claudeAgent",
  async fetch(ctx) {
    const candidates = await resolveClaudeCredCandidates(ctx);
    if (candidates.length === 0) {
      return needsAuthSnapshot("claudeAgent", ctx.nowMs, SOURCE);
    }

    let inferenceOnlySnapshot: ReturnType<typeof buildSnapshot> | null = null;
    let lastErrorSnapshot: ServerProviderUsageSnapshot | null = null;

    for (const creds of candidates) {
      if (!hasProfileScope(creds)) {
        const planName = claudePlanName(creds);
        inferenceOnlySnapshot = buildSnapshot({
          provider: "claudeAgent",
          nowMs: ctx.nowMs,
          status: "ok",
          source: SOURCE,
          ...(planName ? { planName } : {}),
        });
        continue;
      }

      const rateLimitKey = claudeCredentialCacheKey(ctx, creds);
      let activeCreds = creds;
      if (shouldRefreshClaudeCreds(activeCreds, ctx.nowMs)) {
        const refreshed = await refreshClaudeCreds(activeCreds);
        if (refreshed) {
          activeCreds = refreshed;
        } else if (activeCreds.expiresAtMs !== undefined && activeCreds.expiresAtMs <= ctx.nowMs) {
          continue;
        }
      }

      // Inside an active rate-limit cooldown, skip only for the credential that originally hit it.
      const cooldownSnapshot = claudeRateLimit.serveDuringCooldown(rateLimitKey, ctx.nowMs);
      if (cooldownSnapshot) {
        return cooldownSnapshot;
      }

      try {
        let result = await fetchClaudeUsage(activeCreds.accessToken);
        if (isAuthFailureStatus(result.status) && activeCreds.refreshToken) {
          const refreshed = await refreshClaudeCreds(activeCreds);
          if (refreshed) {
            activeCreds = refreshed;
            result = await fetchClaudeUsage(activeCreds.accessToken);
          }
        }
        if (isAuthFailureStatus(result.status)) {
          continue;
        }
        if (isRateLimitStatus(result.status)) {
          // Account/IP-level throttle: back off (respecting Retry-After) and keep the last values
          // instead of blanking. Trying the next credential would only earn more 429s.
          return claudeRateLimit.enterCooldown(
            rateLimitKey,
            ctx.nowMs,
            parseRetryAfterMs(result.headers, ctx.nowMs),
          );
        }
        if (!result.ok) {
          lastErrorSnapshot = errorSnapshot(
            "claudeAgent",
            ctx.nowMs,
            SOURCE,
            `Claude usage request failed (${result.status}).`,
          );
          continue;
        }
        const planName = claudePlanName(activeCreds);
        const snapshot = parseClaudeUsage({
          json: result.json,
          nowMs: ctx.nowMs,
          ...(planName ? { planName } : {}),
        });
        claudeRateLimit.rememberLastGood(rateLimitKey, snapshot);
        return snapshot;
      } catch {
        lastErrorSnapshot = errorSnapshot(
          "claudeAgent",
          ctx.nowMs,
          SOURCE,
          "Could not reach the Claude usage endpoint.",
        );
        continue;
      }
    }

    return (
      inferenceOnlySnapshot ??
      lastErrorSnapshot ??
      needsAuthSnapshot("claudeAgent", ctx.nowMs, SOURCE)
    );
  },
};

function fetchClaudeUsage(accessToken: string) {
  return fetchJson({
    url: USAGE_URL,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": "claude-code/2.1.69",
    },
  });
}
