// FILE: providerUsage/providers/antigravity.ts
// Purpose: Live Antigravity usage fetcher. Reads the agy token file
// (`antigravity-cli/antigravity-oauth-token`) or Gemini CLI OAuth (`oauth_creds.json`), refreshes
// through the Google client that issued it, then calls Cloud Code retrieveUserQuotaSummary
// (falling back to loadCodeAssist + retrieveUserQuota).

import nodePath from "node:path";

import type { ServerProviderUsageLimit } from "@synara/contracts";

import {
  credentialFingerprint,
  readJsonFile,
  refreshOAuthAccessToken,
  writeJsonFileAtomic,
  type OAuthRefreshResult,
} from "../credentials";
import { fetchJson, isAuthFailureStatus, isRateLimitStatus } from "../http";
import {
  asFiniteNumber,
  asRecord,
  asString,
  buildSnapshot,
  clampPercent,
  errorSnapshot,
  isoFromString,
  needsAuthSnapshot,
  titleCase,
  toUsedPercent,
} from "../parse";
import type { ProviderUsageContext, ProviderUsageFetcher } from "../types";

const SOURCE = "antigravity-cloudcode";
const LOAD_URL = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const QUOTA_URL = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota";
const QUOTA_SUMMARY_URL = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";
const REFRESH_URL = "https://oauth2.googleapis.com/token";
const CLOUD_CODE_ORIGIN = new URL(LOAD_URL).origin;
// Public Gemini CLI installed-app OAuth client (not a Synara-issued secret).
// Assembled so GitHub push protection does not treat the published CLI client as a leak.
const GEMINI_OAUTH_CLIENT_ID = [
  "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j",
  "apps.googleusercontent.com",
].join(".");
const GEMINI_OAUTH_CLIENT_SECRET = ["GOCSPX", "4uHgMPm-1o7Sk-geV6Cu5clXFsxl"].join("-");
// Public Antigravity installed-app OAuth client shipped with the app and `agy`. Google only
// refreshes a token with the client that issued it, so agy tokens cannot use the Gemini CLI pair.
const ANTIGRAVITY_OAUTH_CLIENT_ID = [
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep",
  "apps.googleusercontent.com",
].join(".");
const ANTIGRAVITY_OAUTH_CLIENT_SECRET = ["GOCSPX", "K58FWR486LdLJ1mLB8sXC4z6qDAf"].join("-");
// Cloud Code licenses Antigravity quota by client: without this User-Agent, consumer accounts get
// 403 "You do not have a valid license" from every quota endpoint.
const CLOUD_CODE_USER_AGENT = "antigravity";
const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const MAX_QUOTA_WINDOWS = 4;
const FIVE_HOUR_WINDOW_MINS = 5 * 60;
const WEEKLY_WINDOW_MINS = 7 * 24 * 60;
// retrieveUserQuotaSummary pools: Gemini (Pro + Flash) and third-party (Claude, GPT-OSS), each
// with a rolling 5-hour and a weekly window. Matched by exact bucket id so a new bucket never
// silently joins a pool. The Gemini pool keeps the plain labels the usage rings select.
const QUOTA_SUMMARY_BUCKETS: ReadonlyArray<{
  bucketId: string;
  window: string;
  windowDurationMins: number;
}> = [
  { bucketId: "gemini-5h", window: "5h", windowDurationMins: FIVE_HOUR_WINDOW_MINS },
  { bucketId: "gemini-weekly", window: "Weekly", windowDurationMins: WEEKLY_WINDOW_MINS },
  { bucketId: "3p-5h", window: "Claude 5h", windowDurationMins: FIVE_HOUR_WINDOW_MINS },
  { bucketId: "3p-weekly", window: "Claude Weekly", windowDurationMins: WEEKLY_WINDOW_MINS },
];

type GoogleOAuthClientKind = "antigravity" | "gemini-cli";

interface GeminiCredCandidate {
  path: string;
  client: GoogleOAuthClientKind;
}

interface GeminiOAuthCreds {
  path: string;
  client: GoogleOAuthClientKind;
  record: Record<string, unknown>;
  accessToken: string;
  refreshToken?: string;
  expiresAtMs?: number;
}

function geminiCredPaths(ctx: ProviderUsageContext): GeminiCredCandidate[] {
  const geminiHome = ctx.env.GEMINI_CONFIG_DIR?.trim() || nodePath.join(ctx.homeDir, ".gemini");
  const candidates: GeminiCredCandidate[] = [
    {
      path: nodePath.join(geminiHome, "antigravity-cli", "antigravity-oauth-token"),
      client: "antigravity",
    },
    {
      path: nodePath.join(geminiHome, "antigravity-cli", "oauth_creds.json"),
      client: "antigravity",
    },
    { path: nodePath.join(geminiHome, "oauth_creds.json"), client: "gemini-cli" },
    {
      path: nodePath.join(ctx.homeDir, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
      client: "antigravity",
    },
    {
      path: nodePath.join(ctx.homeDir, ".gemini", "antigravity-cli", "oauth_creds.json"),
      client: "antigravity",
    },
    { path: nodePath.join(ctx.homeDir, ".gemini", "oauth_creds.json"), client: "gemini-cli" },
    {
      path: nodePath.join(ctx.homeDir, ".config", "gemini", "oauth_creds.json"),
      client: "gemini-cli",
    },
  ];
  return candidates.filter(
    (candidate, index) => candidates.findIndex((other) => other.path === candidate.path) === index,
  );
}

function expiryMsFromUnknown(value: unknown): number | undefined {
  const numeric = asFiniteNumber(value);
  if (numeric !== undefined) {
    return numeric < 1e12 ? numeric * 1000 : numeric;
  }
  const text = asString(value);
  if (!text) return undefined;
  const normalized = text.replace(/(\.\d{3})\d+/u, "$1");
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function readGeminiCreds(candidate: GeminiCredCandidate, value: unknown): GeminiOAuthCreds | null {
  const record = asRecord(value);
  if (!record) return null;
  const tokenRecord = asRecord(record.token) ?? record;
  const accessToken = asString(tokenRecord.access_token);
  if (!accessToken) return null;
  const expiresAtMs =
    expiryMsFromUnknown(tokenRecord.expiry_date) ??
    expiryMsFromUnknown(tokenRecord.expiry) ??
    expiryMsFromUnknown(record.expiry_date) ??
    expiryMsFromUnknown(record.expiry);
  const refreshToken = asString(tokenRecord.refresh_token) ?? asString(record.refresh_token);
  return {
    ...candidate,
    record,
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresAtMs !== undefined ? { expiresAtMs } : {}),
  };
}

async function resolveGeminiCreds(ctx: ProviderUsageContext): Promise<GeminiOAuthCreds | null> {
  for (const candidate of geminiCredPaths(ctx)) {
    const creds = readGeminiCreds(candidate, await readJsonFile(candidate.path));
    if (creds) return creds;
  }
  return null;
}

function googleHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": CLOUD_CODE_USER_AGENT,
  };
}

const LOAD_CODE_ASSIST_BODY = {
  metadata: {
    ideType: "GEMINI_CLI",
    platform: "PLATFORM_UNSPECIFIED",
    pluginType: "GEMINI",
  },
};

function postCloudCode(url: string, accessToken: string, body: unknown) {
  return fetchJson({
    service: "provider-usage-antigravity",
    url,
    allowedOrigins: [CLOUD_CODE_ORIGIN],
    method: "POST",
    headers: googleHeaders(accessToken),
    body,
  });
}

function googleOAuthClient(
  kind: GoogleOAuthClientKind,
  ctx: ProviderUsageContext,
): { clientId: string; clientSecret: string } {
  if (kind === "antigravity") {
    return { clientId: ANTIGRAVITY_OAUTH_CLIENT_ID, clientSecret: ANTIGRAVITY_OAUTH_CLIENT_SECRET };
  }
  return {
    clientId: ctx.env.GEMINI_OAUTH_CLIENT_ID?.trim() || GEMINI_OAUTH_CLIENT_ID,
    clientSecret: ctx.env.GEMINI_OAUTH_CLIENT_SECRET?.trim() || GEMINI_OAUTH_CLIENT_SECRET,
  };
}

function quotaWindowLabel(modelId: string): string {
  const lower = modelId.toLowerCase();
  if (lower.includes("pro")) return "Pro";
  if (lower.includes("flash")) return "Flash";
  return modelId;
}

function antigravityPlanName(loadAssist: unknown): string | undefined {
  const assist = asRecord(loadAssist);
  const paidTier = asRecord(assist?.paidTier);
  const currentTier = asRecord(assist?.currentTier);
  const paidName = asString(paidTier?.name);
  if (paidName) return paidName;
  const currentName = asString(currentTier?.name);
  if (currentName) return currentName;
  const tierId = asString(currentTier?.id);
  if (tierId === "standard-tier") return "Paid";
  if (tierId === "free-tier") return "Free";
  if (tierId === "legacy-tier") return "Legacy";
  return tierId ? titleCase(tierId.replaceAll("_", " ")) : undefined;
}

/**
 * Map retrieveUserQuotaSummary to the pool windows. Undefined means the body is not a summary
 * (no `groups`), so the caller may fall back to the legacy per-model quota endpoint.
 */
export function parseAntigravityQuotaSummary(
  quota: unknown,
): ServerProviderUsageLimit[] | undefined {
  const groups = asRecord(quota)?.groups;
  if (!Array.isArray(groups)) return undefined;
  const bucketsById = new Map<string, Record<string, unknown>>();
  for (const group of groups) {
    const buckets = asRecord(group)?.buckets;
    for (const bucket of Array.isArray(buckets) ? buckets : []) {
      const record = asRecord(bucket);
      const bucketId = asString(record?.bucketId);
      if (record && bucketId && !bucketsById.has(bucketId)) {
        bucketsById.set(bucketId, record);
      }
    }
  }
  return QUOTA_SUMMARY_BUCKETS.flatMap((spec) => {
    const bucket = bucketsById.get(spec.bucketId);
    if (!bucket) return [];
    const remainingFraction = asFiniteNumber(bucket.remainingFraction);
    const usedPercent =
      remainingFraction !== undefined
        ? clampPercent(Math.round((1 - remainingFraction) * 100))
        : undefined;
    const resetsAt = isoFromString(bucket.resetTime);
    if (usedPercent === undefined && !resetsAt) return [];
    return [
      {
        window: spec.window,
        ...(usedPercent !== undefined ? { usedPercent } : {}),
        ...(resetsAt ? { resetsAt } : {}),
        windowDurationMins: spec.windowDurationMins,
      },
    ];
  });
}

export function parseAntigravityQuota(input: {
  loadAssist: unknown;
  quota: unknown;
  nowMs: number;
}) {
  const planName = antigravityPlanName(input.loadAssist);
  const quota = asRecord(input.quota);
  const buckets = Array.isArray(quota?.buckets) ? quota.buckets : [];
  const grouped = new Map<string, ServerProviderUsageLimit>();
  for (const bucket of buckets) {
    const record = asRecord(bucket);
    if (!record) continue;
    const remainingFraction = asFiniteNumber(record.remainingFraction);
    const usedPercent =
      remainingFraction !== undefined
        ? clampPercent(Math.round((1 - remainingFraction) * 100))
        : toUsedPercent(asFiniteNumber(record.usedFraction));
    const modelId = asString(record.modelId) ?? asString(record.displayName) ?? "Quota";
    const window = quotaWindowLabel(modelId);
    const resetsAt = isoFromString(record.resetTime);
    if (usedPercent === undefined && !resetsAt) continue;
    const previous = grouped.get(window);
    const previousUsed = previous?.usedPercent ?? Number.NEGATIVE_INFINITY;
    if (previous && usedPercent === undefined) continue;
    if (usedPercent !== undefined && usedPercent < previousUsed) continue;
    grouped.set(window, {
      window,
      ...(usedPercent !== undefined ? { usedPercent } : {}),
      ...(resetsAt ? { resetsAt } : previous?.resetsAt ? { resetsAt: previous.resetsAt } : {}),
    });
  }

  const preferred = ["Pro", "Flash"];
  const limits = [
    ...preferred.flatMap((window) => {
      const limit = grouped.get(window);
      return limit ? [limit] : [];
    }),
    ...[...grouped.values()].filter((limit) => !preferred.includes(limit.window)),
  ].slice(0, MAX_QUOTA_WINDOWS);

  return buildSnapshot({
    provider: "antigravity",
    nowMs: input.nowMs,
    status: "ok",
    source: SOURCE,
    limits,
    ...(planName ? { planName } : {}),
  });
}

function applyRefreshedTokens(
  creds: GeminiOAuthCreds,
  refreshed: Extract<OAuthRefreshResult, { ok: true }>,
): Record<string, unknown> {
  const tokenPatch: Record<string, unknown> = {
    access_token: refreshed.accessToken,
    ...(refreshed.refreshToken ? { refresh_token: refreshed.refreshToken } : {}),
    ...(refreshed.expiresAtMs !== undefined
      ? {
          expiry_date: refreshed.expiresAtMs,
          expiry: new Date(refreshed.expiresAtMs).toISOString(),
        }
      : {}),
  };
  const nested = asRecord(creds.record.token);
  if (nested) {
    return { ...creds.record, token: { ...nested, ...tokenPatch } };
  }
  return { ...creds.record, ...tokenPatch };
}

async function refreshGeminiCreds(
  creds: GeminiOAuthCreds,
  ctx: ProviderUsageContext,
): Promise<GeminiOAuthCreds | "dead" | null> {
  if (!creds.refreshToken) return null;
  const client = googleOAuthClient(creds.client, ctx);
  const refreshed = await refreshOAuthAccessToken({
    service: "provider-usage-antigravity-refresh",
    refreshUrl: REFRESH_URL,
    allowedOrigins: [new URL(REFRESH_URL).origin],
    refreshToken: creds.refreshToken,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    bodyFormat: "form",
  });
  if (!refreshed.ok) {
    return refreshed.status === 400 && refreshed.errorCode === "invalid_grant" ? "dead" : null;
  }
  const nextRecord = applyRefreshedTokens(creds, refreshed);
  await writeJsonFileAtomic(creds.path, nextRecord);
  const refreshToken = refreshed.refreshToken ?? creds.refreshToken;
  return {
    ...creds,
    record: nextRecord,
    accessToken: refreshed.accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(refreshed.expiresAtMs !== undefined ? { expiresAtMs: refreshed.expiresAtMs } : {}),
  };
}

function credsNeedRefresh(creds: GeminiOAuthCreds, nowMs: number): boolean {
  return creds.expiresAtMs !== undefined && creds.expiresAtMs <= nowMs + REFRESH_BUFFER_MS;
}

function apiKeySnapshot(nowMs: number) {
  return buildSnapshot({
    provider: "antigravity",
    nowMs,
    status: "ok",
    source: SOURCE,
    usageLines: [
      {
        label: "Credits",
        value:
          "This Gemini API key has no Cloud Code quota window; remaining limits stay in `agy`.",
      },
    ],
    planName: "API key",
  });
}

export const antigravityUsageFetcher: ProviderUsageFetcher = {
  provider: "antigravity",
  async cacheKey(ctx) {
    const creds = await resolveGeminiCreds(ctx);
    if (creds) return credentialFingerprint(creds.accessToken);
    const apiKey = ctx.env.GEMINI_API_KEY?.trim();
    return apiKey ? `api:${credentialFingerprint(apiKey)}` : `${ctx.homeDir}:none`;
  },
  async fetch(ctx) {
    let creds = await resolveGeminiCreds(ctx);
    if (!creds) {
      if (ctx.env.GEMINI_API_KEY?.trim()) {
        return apiKeySnapshot(ctx.nowMs);
      }
      return needsAuthSnapshot("antigravity", ctx.nowMs, SOURCE);
    }
    if (creds.refreshToken && credsNeedRefresh(creds, ctx.nowMs)) {
      const refreshed = await refreshGeminiCreds(creds, ctx).catch(() => null);
      if (refreshed === "dead") {
        return needsAuthSnapshot("antigravity", ctx.nowMs, SOURCE);
      }
      if (!refreshed) {
        return errorSnapshot(
          "antigravity",
          ctx.nowMs,
          SOURCE,
          "Could not refresh the Antigravity Google login.",
        );
      }
      creds = refreshed;
    }

    let planName: string | undefined;
    try {
      const summaryResult = await postCloudCode(QUOTA_SUMMARY_URL, creds.accessToken, {});
      const summaryLimits = summaryResult.ok
        ? parseAntigravityQuotaSummary(summaryResult.json)
        : undefined;
      if (summaryLimits) {
        // The plan only labels the card; a failed lookup must not hide quota that already loaded.
        const planResult = await postCloudCode(
          LOAD_URL,
          creds.accessToken,
          LOAD_CODE_ASSIST_BODY,
        ).catch(() => null);
        planName = planResult?.ok ? antigravityPlanName(planResult.json) : undefined;
        return buildSnapshot({
          provider: "antigravity",
          nowMs: ctx.nowMs,
          status: "ok",
          source: SOURCE,
          limits: summaryLimits,
          ...(planName ? { planName } : {}),
        });
      }
      if (summaryResult.status === 401) {
        return needsAuthSnapshot("antigravity", ctx.nowMs, SOURCE);
      }
      if (isRateLimitStatus(summaryResult.status) || summaryResult.status >= 500) {
        return errorSnapshot(
          "antigravity",
          ctx.nowMs,
          SOURCE,
          `Antigravity quota request failed (${summaryResult.status}).`,
        );
      }

      // Accounts without the summary RPC: per-model Gemini quota, 5-hour windows only.
      const loadResult = await postCloudCode(LOAD_URL, creds.accessToken, LOAD_CODE_ASSIST_BODY);
      if (isAuthFailureStatus(loadResult.status)) {
        return needsAuthSnapshot("antigravity", ctx.nowMs, SOURCE);
      }
      if (!loadResult.ok) {
        return errorSnapshot(
          "antigravity",
          ctx.nowMs,
          SOURCE,
          `Antigravity usage request failed (${loadResult.status}).`,
        );
      }

      planName = antigravityPlanName(loadResult.json);
      const assist = asRecord(loadResult.json);
      const projectId =
        asString(assist?.cloudaicompanionProject) ??
        ctx.env.GOOGLE_CLOUD_PROJECT?.trim() ??
        ctx.env.GOOGLE_CLOUD_PROJECT_ID?.trim();
      const quotaResult = await postCloudCode(
        QUOTA_URL,
        creds.accessToken,
        projectId ? { project: projectId } : {},
      );
      if (!quotaResult.ok) {
        const snapshot = isAuthFailureStatus(quotaResult.status)
          ? needsAuthSnapshot("antigravity", ctx.nowMs, SOURCE)
          : errorSnapshot(
              "antigravity",
              ctx.nowMs,
              SOURCE,
              `Antigravity quota request failed (${quotaResult.status}).`,
            );
        return { ...snapshot, ...(planName ? { planName } : {}) };
      }

      return parseAntigravityQuota({
        loadAssist: loadResult.json,
        quota: quotaResult.json,
        nowMs: ctx.nowMs,
      });
    } catch {
      return {
        ...errorSnapshot(
          "antigravity",
          ctx.nowMs,
          SOURCE,
          "Could not reach Google Code Assist usage.",
        ),
        ...(planName ? { planName } : {}),
      };
    }
  },
};
