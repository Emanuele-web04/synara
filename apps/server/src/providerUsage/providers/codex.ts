// FILE: providerUsage/providers/codex.ts
// Purpose: Live Codex (ChatGPT/OpenAI) usage fetcher. Reads the OAuth access token from the
// Codex CLI auth.json (or the macOS keychain) read-only and calls the ChatGPT backend usage
// endpoint, mapping rate-limit windows + credit balance into the shared snapshot shape.
// Reference: openusage plugins/codex/plugin.js.

import nodePath from "node:path";

import type { ServerProviderUsageLimit, ServerProviderUsageLine } from "@synara/contracts";

import { decodeKeychainJson, readJsonFile, readKeychainPassword } from "../credentials";
import { fetchJson, isAuthFailureStatus } from "../http";
import {
  asFiniteNumber,
  asRecord,
  asString,
  buildSnapshot,
  clampPercent,
  errorSnapshot,
  formatUsd,
  isoFromUnixSeconds,
  needsAuthSnapshot,
  titleCase,
  unsupportedSnapshot,
} from "../parse";
import type { ProviderUsageContext, ProviderUsageFetcher } from "../types";

const SOURCE = "codex-wham-usage";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

type CodexAuth = { kind: "oauth"; accessToken: string; accountId?: string } | { kind: "api-key" };

function authFilePaths(ctx: ProviderUsageContext): string[] {
  const paths: string[] = [];
  if (ctx.env.CODEX_HOME) {
    paths.push(nodePath.join(ctx.env.CODEX_HOME, "auth.json"));
  }
  paths.push(nodePath.join(ctx.homeDir, ".config", "codex", "auth.json"));
  paths.push(nodePath.join(ctx.homeDir, ".codex", "auth.json"));
  return paths;
}

function readCodexAuthRecord(
  record: Record<string, unknown> | null,
): CodexAuth | "api-key-only" | null {
  if (!record) {
    return null;
  }
  const tokens = asRecord(record.tokens);
  const accessToken = asString(tokens?.access_token);
  if (accessToken) {
    const accountId = asString(tokens?.account_id);
    return { kind: "oauth", accessToken, ...(accountId ? { accountId } : {}) };
  }
  return asString(record.OPENAI_API_KEY) ? "api-key-only" : null;
}

async function resolveCodexAuth(ctx: ProviderUsageContext): Promise<CodexAuth | null> {
  let sawApiKeyOnly = false;

  for (const path of authFilePaths(ctx)) {
    const parsed = readCodexAuthRecord(asRecord(await readJsonFile(path)));
    if (parsed && parsed !== "api-key-only") {
      return parsed;
    }
    if (parsed === "api-key-only") {
      sawApiKeyOnly = true;
    }
  }

  const keychain = await readKeychainPassword({ service: "Codex Auth", platform: ctx.platform });
  if (keychain) {
    const parsed = readCodexAuthRecord(asRecord(decodeKeychainJson(keychain)));
    if (parsed && parsed !== "api-key-only") {
      return parsed;
    }
    if (parsed === "api-key-only") {
      sawApiKeyOnly = true;
    }
  }

  return sawApiKeyOnly ? { kind: "api-key" } : null;
}

function resetFromWindow(
  window: Record<string, unknown> | null,
  nowMs: number,
): string | undefined {
  const explicit = isoFromUnixSeconds(window?.reset_at);
  if (explicit) {
    return explicit;
  }
  const after = asFiniteNumber(window?.reset_after_seconds);
  if (after !== undefined && after > 0) {
    return new Date(nowMs + after * 1000).toISOString();
  }
  return undefined;
}

export function parseCodexUsage(input: {
  json: unknown;
  headers?: Record<string, string>;
  nowMs: number;
}) {
  const root = asRecord(input.json);
  const headers = input.headers ?? {};
  const rateLimit = asRecord(root?.rate_limit);
  const limits: ServerProviderUsageLimit[] = [];
  const usageLines: ServerProviderUsageLine[] = [];

  const pushWindow = (
    label: string,
    windowValue: unknown,
    headerName: string,
    fallbackDurationMins: number,
  ): void => {
    const window = asRecord(windowValue);
    if (!window) {
      return;
    }
    const usedPercent =
      clampPercent(asFiniteNumber(headers[headerName])) ??
      clampPercent(asFiniteNumber(window.used_percent));
    const resetsAt = resetFromWindow(window, input.nowMs);
    const windowSeconds = asFiniteNumber(window.limit_window_seconds);
    const windowDurationMins =
      windowSeconds !== undefined ? Math.round(windowSeconds / 60) : fallbackDurationMins;
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

  pushWindow("5h", rateLimit?.primary_window, "x-codex-primary-used-percent", 300);
  pushWindow("Weekly", rateLimit?.secondary_window, "x-codex-secondary-used-percent", 10_080);

  const credits = asRecord(root?.credits);
  const balance =
    asFiniteNumber(headers["x-codex-credits-balance"]) ?? asFiniteNumber(credits?.balance);
  if (balance !== undefined && (credits?.has_credits !== false || balance > 0)) {
    usageLines.push({ label: "Credits", value: `${formatUsd(balance)} remaining` });
  }

  const planType = asString(root?.plan_type);
  return buildSnapshot({
    provider: "codex",
    nowMs: input.nowMs,
    status: "ok",
    source: SOURCE,
    limits,
    usageLines,
    ...(planType ? { planName: titleCase(planType) } : {}),
  });
}

export const codexUsageFetcher: ProviderUsageFetcher = {
  provider: "codex",
  async fetch(ctx) {
    const auth = await resolveCodexAuth(ctx);
    if (!auth) {
      return needsAuthSnapshot("codex", ctx.nowMs, SOURCE);
    }
    if (auth.kind === "api-key") {
      return unsupportedSnapshot(
        "codex",
        ctx.nowMs,
        SOURCE,
        "Codex API-key auth has no usage endpoint. Sign in with ChatGPT to see usage.",
      );
    }

    try {
      const result = await fetchJson({
        url: USAGE_URL,
        headers: {
          Authorization: `Bearer ${auth.accessToken}`,
          Accept: "application/json",
          "User-Agent": "Synara",
          ...(auth.accountId ? { "ChatGPT-Account-Id": auth.accountId } : {}),
        },
      });
      if (isAuthFailureStatus(result.status)) {
        return needsAuthSnapshot("codex", ctx.nowMs, SOURCE);
      }
      if (!result.ok) {
        return errorSnapshot(
          "codex",
          ctx.nowMs,
          SOURCE,
          `Codex usage request failed (${result.status}).`,
        );
      }
      return parseCodexUsage({
        json: result.json,
        headers: Object.fromEntries(result.headers),
        nowMs: ctx.nowMs,
      });
    } catch {
      return errorSnapshot("codex", ctx.nowMs, SOURCE, "Could not reach the Codex usage endpoint.");
    }
  },
};
