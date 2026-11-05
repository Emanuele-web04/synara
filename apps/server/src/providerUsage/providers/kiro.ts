// FILE: providerUsage/providers/kiro.ts
// Purpose: Live Kiro usage fetcher. Reads the `kiro-cli login` access token and CodeWhisperer
// profile from kiro-cli's data.sqlite3 read-only, then calls Kiro's getUsageLimits endpoint
// (the source behind Kiro's own /usage). Never redeems the refresh token: kiro-cli rotates its
// own tokens whenever it runs, and a rotated pair Synara did not persist would sign Kiro out.

import nodePath from "node:path";

import type { ServerProviderUsageLimit, ServerProviderUsageLine } from "@synara/contracts";

import { credentialFingerprint } from "../credentials";
import { fetchJson, isAuthFailureStatus } from "../http";
import {
  asFiniteNumber,
  asRecord,
  asString,
  buildSnapshot,
  clampPercent,
  errorSnapshot,
  formatUsd,
  isoFromString,
  isoFromUnixSeconds,
  needsAuthSnapshot,
  titleCase,
} from "../parse";
import { readItemTableValues } from "../sqlite";
import type { ProviderUsageContext, ProviderUsageFetcher } from "../types";

const SOURCE = "kiro-usage-limits";
// IAM Identity Center / Builder ID logins and social logins use separate keys.
const TOKEN_KEYS = ["kirocli:odic:token", "kirocli:social:token"] as const;
const PROFILE_KEY = "api.codewhisperer.profile";
const DEFAULT_REGION = "us-east-1";
const AWS_REGION_PATTERN = /^[a-z]{2}(?:-[a-z]+)+-\d+$/u;
// Kiro credits reset monthly; the duration lets the usage rail label the window.
const MONTHLY_MINS = 30 * 24 * 60;

interface KiroAuth {
  readonly accessToken: string;
  readonly expiresAtMs?: number;
  readonly profileArn?: string;
  readonly region: string;
}

export function kiroDataDbPaths(
  ctx: Pick<ProviderUsageContext, "homeDir" | "env" | "platform">,
): string[] {
  if (ctx.platform === "darwin") {
    return [
      nodePath.join(ctx.homeDir, "Library", "Application Support", "kiro-cli", "data.sqlite3"),
    ];
  }
  if (ctx.platform === "win32") {
    // kiro-cli ships for macOS and Linux; Windows users run it inside WSL.
    return [];
  }
  const dataHome = ctx.env.XDG_DATA_HOME?.trim() || nodePath.join(ctx.homeDir, ".local", "share");
  return [nodePath.join(dataHome, "kiro-cli", "data.sqlite3")];
}

function parseJsonRecord(value: string | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function regionFromArn(arn: string | undefined): string | undefined {
  const region = arn?.split(":")[3];
  return region && AWS_REGION_PATTERN.test(region) ? region : undefined;
}

export async function readKiroStoredAuth(ctx: ProviderUsageContext): Promise<KiroAuth | null> {
  for (const dbPath of kiroDataDbPaths(ctx)) {
    const tokens = await readItemTableValues({ dbPath, keys: TOKEN_KEYS, table: "auth_kv" });
    const token = TOKEN_KEYS.map((key) => parseJsonRecord(tokens[key])).find(
      (record) => asString(record?.access_token) !== undefined,
    );
    const accessToken = asString(token?.access_token);
    if (!token || !accessToken) {
      continue;
    }
    const profile = parseJsonRecord(
      (await readItemTableValues({ dbPath, keys: [PROFILE_KEY], table: "state" }))[PROFILE_KEY],
    );
    const profileArn = asString(profile?.arn);
    const tokenRegion = asString(token.region);
    const expiresAt = isoFromString(token.expires_at);
    return {
      accessToken,
      ...(expiresAt ? { expiresAtMs: Date.parse(expiresAt) } : {}),
      ...(profileArn ? { profileArn } : {}),
      region:
        regionFromArn(profileArn) ??
        (tokenRegion && AWS_REGION_PATTERN.test(tokenRegion) ? tokenRegion : DEFAULT_REGION),
    };
  }
  return null;
}

function formatCredits(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function pickPrecise(record: Record<string, unknown> | null, key: string): number | undefined {
  return asFiniteNumber(record?.[`${key}WithPrecision`]) ?? asFiniteNumber(record?.[key]);
}

export function parseKiroUsage(input: { readonly json: unknown; readonly nowMs: number }) {
  const root = asRecord(input.json);
  const breakdowns = Array.isArray(root?.usageBreakdownList) ? root.usageBreakdownList : [];
  const credit =
    breakdowns.map(asRecord).find((entry) => asString(entry?.resourceType) === "CREDIT") ??
    asRecord(breakdowns[0]);
  const limits: ServerProviderUsageLimit[] = [];
  const usageLines: ServerProviderUsageLine[] = [];
  const unit = asString(credit?.displayNamePlural) ?? "Credits";

  const used = pickPrecise(credit, "currentUsage");
  const limit = pickPrecise(credit, "usageLimit");
  const resetsAt = isoFromUnixSeconds(credit?.nextDateReset ?? root?.nextDateReset);
  if (limit !== undefined && limit > 0) {
    const usedPercent = clampPercent(((used ?? 0) / limit) * 100);
    limits.push({
      window: "Monthly",
      windowDurationMins: MONTHLY_MINS,
      ...(usedPercent !== undefined ? { usedPercent } : {}),
      ...(resetsAt ? { resetsAt } : {}),
    });
    usageLines.push({
      label: unit,
      value: `${formatCredits(used ?? 0)} of ${formatCredits(limit)}`,
    });
  } else if (used !== undefined) {
    usageLines.push({ label: unit, value: `${formatCredits(used)} used` });
  }

  const trial = asRecord(credit?.freeTrialInfo);
  const trialLimit = pickPrecise(trial, "usageLimit");
  if (asString(trial?.freeTrialStatus) === "ACTIVE" && trialLimit !== undefined && trialLimit > 0) {
    const trialExpiry = isoFromUnixSeconds(trial?.freeTrialExpiry);
    usageLines.push({
      label: "Free trial",
      value: `${formatCredits(pickPrecise(trial, "currentUsage") ?? 0)} of ${formatCredits(trialLimit)}`,
      ...(trialExpiry ? { subtitle: `Expires ${trialExpiry.slice(0, 10)}` } : {}),
    });
  }

  const bonuses = (Array.isArray(credit?.bonuses) ? credit.bonuses : []).map(asRecord);
  const bonusLimit = bonuses.reduce(
    (sum, bonus) => sum + (pickPrecise(bonus, "usageLimit") ?? 0),
    0,
  );
  if (bonusLimit > 0) {
    const bonusUsed = bonuses.reduce(
      (sum, bonus) => sum + (pickPrecise(bonus, "currentUsage") ?? 0),
      0,
    );
    usageLines.push({
      label: "Bonus credits",
      value: `${formatCredits(bonusUsed)} of ${formatCredits(bonusLimit)}`,
    });
  }

  const overageStatus = asString(asRecord(root?.overageConfiguration)?.overageStatus);
  const overageCharges = asFiniteNumber(credit?.overageCharges);
  if (overageStatus === "ENABLED" || (overageCharges !== undefined && overageCharges > 0)) {
    usageLines.push({
      label: "Overage",
      value: overageCharges !== undefined ? formatUsd(overageCharges) : "Enabled",
      ...(overageStatus === "ENABLED" ? {} : { subtitle: "Overage is off" }),
    });
  }

  const planTitle = asString(asRecord(root?.subscriptionInfo)?.subscriptionTitle);
  return buildSnapshot({
    provider: "kiro",
    nowMs: input.nowMs,
    status: "ok",
    source: SOURCE,
    limits,
    usageLines,
    ...(planTitle ? { planName: titleCase(planTitle) } : {}),
  });
}

export const kiroUsageFetcher: ProviderUsageFetcher = {
  provider: "kiro",
  async cacheKey(ctx) {
    const auth = await readKiroStoredAuth(ctx);
    return auth
      ? `${ctx.homeDir}:${credentialFingerprint(auth.accessToken)}`
      : `${ctx.homeDir}:none`;
  },
  async fetch(ctx) {
    const auth = await readKiroStoredAuth(ctx);
    if (!auth) {
      return needsAuthSnapshot("kiro", ctx.nowMs, SOURCE);
    }
    if (auth.expiresAtMs !== undefined && auth.expiresAtMs <= ctx.nowMs) {
      return buildSnapshot({
        provider: "kiro",
        nowMs: ctx.nowMs,
        status: "needs-auth",
        source: SOURCE,
        detail: "Kiro's sign-in token expired. It renews the next time Kiro runs.",
      });
    }

    const origin = `https://q.${auth.region}.amazonaws.com`;
    const query = new URLSearchParams({ origin: "AI_EDITOR", resourceType: "AGENTIC_REQUEST" });
    if (auth.profileArn) {
      query.set("profileArn", auth.profileArn);
    }
    try {
      const result = await fetchJson({
        service: "provider-usage-kiro",
        url: `${origin}/getUsageLimits?${query.toString()}`,
        allowedOrigins: [origin],
        headers: { Authorization: `Bearer ${auth.accessToken}`, Accept: "application/json" },
      });
      if (isAuthFailureStatus(result.status)) {
        return needsAuthSnapshot("kiro", ctx.nowMs, SOURCE);
      }
      if (!result.ok) {
        return errorSnapshot(
          "kiro",
          ctx.nowMs,
          SOURCE,
          `Kiro usage request failed (${result.status}).`,
        );
      }
      return parseKiroUsage({ json: result.json, nowMs: ctx.nowMs });
    } catch {
      return errorSnapshot("kiro", ctx.nowMs, SOURCE, "Could not reach the Kiro usage service.");
    }
  },
};
