// FILE: providerUsage/providers/gemini.ts
// Purpose: Live Gemini (Google Code Assist) usage fetcher. Reads the OAuth access token from
// ~/.gemini/oauth_creds.json read-only, resolves the tier/project via loadCodeAssist, then reads
// per-model remaining quota via retrieveUserQuota. Read-only: Gemini access tokens are short-lived,
// so an expired token reports needs-auth. Reference: openusage plugins/gemini/plugin.js.

import nodePath from "node:path";

import type { ServerProviderUsageLimit } from "@synara/contracts";

import { readJsonFile } from "../credentials";
import { fetchJson, isAuthFailureStatus } from "../http";
import {
  asFiniteNumber,
  asRecord,
  asString,
  buildSnapshot,
  clampPercent,
  collectRecordsWithKey,
  errorSnapshot,
  isoFromString,
  needsAuthSnapshot,
} from "../parse";
import type { ProviderUsageContext, ProviderUsageFetcher } from "../types";

const SOURCE = "gemini-code-assist";
const LOAD_URL = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const QUOTA_URL = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota";

interface GeminiCreds {
  accessToken: string;
  expiryMs: number | undefined;
}

function normalizeExpiryMs(value: unknown): number | undefined {
  const parsed = asFiniteNumber(value);
  if (parsed === undefined) {
    return undefined;
  }
  // expiry_date may be seconds or milliseconds depending on CLI version.
  return parsed < 1e12 ? parsed * 1000 : parsed;
}

async function resolveGeminiCreds(ctx: ProviderUsageContext): Promise<GeminiCreds | null> {
  const credsPath = nodePath.join(ctx.homeDir, ".gemini", "oauth_creds.json");
  const record = asRecord(await readJsonFile(credsPath));
  const accessToken = asString(record?.access_token);
  if (!accessToken) {
    return null;
  }
  return { accessToken, expiryMs: normalizeExpiryMs(record?.expiry_date) };
}

function geminiPlanName(tierId: string | undefined): string | undefined {
  switch (tierId) {
    case "standard-tier":
      return "Paid";
    case "free-tier":
      return "Free";
    case "legacy-tier":
      return "Legacy";
    default:
      return undefined;
  }
}

function geminiHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

export function parseGeminiQuota(input: { json: unknown; nowMs: number; planName?: string }) {
  const records = collectRecordsWithKey(input.json, "remainingFraction");

  // Track the lowest remaining fraction (worst case) per model family.
  const groups = new Map<string, { fraction: number; resetsAt?: string }>();
  const consider = (label: string, fraction: number, resetsAt: string | undefined): void => {
    const existing = groups.get(label);
    if (!existing || fraction < existing.fraction) {
      groups.set(label, { fraction, ...(resetsAt ? { resetsAt } : {}) });
    }
  };

  for (const record of records) {
    const fraction = asFiniteNumber(record.remainingFraction);
    if (fraction === undefined) {
      continue;
    }
    const modelId = (asString(record.modelId) ?? asString(record.model) ?? "").toLowerCase();
    const resetsAt = isoFromString(record.resetTime);
    if (modelId.includes("gemini") && modelId.includes("pro")) {
      consider("Pro", fraction, resetsAt);
    } else if (modelId.includes("gemini") && modelId.includes("flash")) {
      consider("Flash", fraction, resetsAt);
    } else {
      consider("Current", fraction, resetsAt);
    }
  }

  // Prefer the per-family rows; only fall back to the generic row when nothing matched.
  const orderedLabels = groups.has("Pro") || groups.has("Flash") ? ["Pro", "Flash"] : ["Current"];
  const limits: ServerProviderUsageLimit[] = [];
  for (const label of orderedLabels) {
    const group = groups.get(label);
    if (!group) {
      continue;
    }
    const usedPercent = clampPercent((1 - group.fraction) * 100);
    if (usedPercent === undefined) {
      continue;
    }
    limits.push({
      window: label,
      usedPercent,
      ...(group.resetsAt ? { resetsAt: group.resetsAt } : {}),
    });
  }

  return buildSnapshot({
    provider: "gemini",
    nowMs: input.nowMs,
    status: "ok",
    source: SOURCE,
    limits,
    ...(input.planName ? { planName: input.planName } : {}),
  });
}

export const geminiUsageFetcher: ProviderUsageFetcher = {
  provider: "gemini",
  async fetch(ctx) {
    const creds = await resolveGeminiCreds(ctx);
    if (!creds) {
      return needsAuthSnapshot("gemini", ctx.nowMs, SOURCE);
    }
    if (creds.expiryMs !== undefined && creds.expiryMs <= ctx.nowMs) {
      return needsAuthSnapshot("gemini", ctx.nowMs, SOURCE);
    }

    try {
      const loadResult = await fetchJson({
        url: LOAD_URL,
        method: "POST",
        headers: geminiHeaders(creds.accessToken),
        body: {
          metadata: {
            ideType: "IDE_UNSPECIFIED",
            platform: "PLATFORM_UNSPECIFIED",
            pluginType: "GEMINI",
            duetProject: "default",
          },
        },
      });
      if (isAuthFailureStatus(loadResult.status)) {
        return needsAuthSnapshot("gemini", ctx.nowMs, SOURCE);
      }
      if (!loadResult.ok) {
        return errorSnapshot(
          "gemini",
          ctx.nowMs,
          SOURCE,
          `Gemini loadCodeAssist failed (${loadResult.status}).`,
        );
      }

      const loadRoot = asRecord(loadResult.json);
      const tierId =
        asString(asRecord(loadRoot?.currentTier)?.id) ??
        asString(loadRoot?.tier) ??
        asString(loadRoot?.userTier) ??
        asString(loadRoot?.subscriptionTier);
      const project =
        asString(loadRoot?.cloudaicompanionProject) ?? asString(asRecord(loadRoot?.project)?.id);

      const quotaResult = await fetchJson({
        url: QUOTA_URL,
        method: "POST",
        headers: geminiHeaders(creds.accessToken),
        body: project ? { project } : {},
      });
      if (isAuthFailureStatus(quotaResult.status)) {
        return needsAuthSnapshot("gemini", ctx.nowMs, SOURCE);
      }
      if (!quotaResult.ok) {
        return errorSnapshot(
          "gemini",
          ctx.nowMs,
          SOURCE,
          `Gemini retrieveUserQuota failed (${quotaResult.status}).`,
        );
      }

      const planName = geminiPlanName(tierId);
      return parseGeminiQuota({
        json: quotaResult.json,
        nowMs: ctx.nowMs,
        ...(planName ? { planName } : {}),
      });
    } catch {
      return errorSnapshot(
        "gemini",
        ctx.nowMs,
        SOURCE,
        "Could not reach the Gemini quota service.",
      );
    }
  },
};
