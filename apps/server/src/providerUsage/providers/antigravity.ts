// FILE: providerUsage/providers/antigravity.ts
// Purpose: Convert the native Antigravity `/usage` report into Synara's live usage snapshot.
// The CLI owns Google sign-in, credential storage, and refresh.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ServerProviderUsageLimit } from "@synara/contracts";

import { runAntigravityHelperProcess } from "../../provider/antigravityCli";
import {
  asRecord,
  asString,
  buildSnapshot,
  errorSnapshot,
  isoFromString,
  needsAuthSnapshot,
} from "../parse";
import type { ProviderUsageFetcher } from "../types";

const PROVIDER = "antigravity";
const SOURCE = "antigravity-cli";
const SIGN_IN_PROMPT = "Authentication required. Please visit the URL to log in";
const WINDOW_MINUTES = { "5h": 300, weekly: 10_080 } as const;

// Preserve the primary Gemini window labels selected by the existing usage rings.
function readLimit(value: unknown, groupName: string): ServerProviderUsageLimit | undefined {
  const bucket = asRecord(value);
  const fraction = bucket?.remaining_fraction;
  if (bucket?.disabled === true || typeof fraction !== "number" || !Number.isFinite(fraction)) {
    return undefined;
  }
  const rawWindow = bucket?.window;
  const window = rawWindow === "5h" ? "5h" : rawWindow === "weekly" ? "Weekly" : undefined;
  const id = bucket?.id;
  const primary = id === "gemini-5h" || id === "gemini-weekly";
  const label = window ? (primary ? window : `${groupName} ${window}`) : asString(bucket?.name);
  if (!label) return undefined;
  const resetsAt = isoFromString(bucket?.reset_time);
  return {
    window: label,
    usedPercent: Math.min(100, Math.max(0, (1 - fraction) * 100)),
    ...(resetsAt ? { resetsAt } : {}),
    // The usage panel normalizes standard durations to bare labels, so retain the names of other pools.
    ...(primary && (rawWindow === "5h" || rawWindow === "weekly")
      ? { windowDurationMins: WINDOW_MINUTES[rawWindow] }
      : {}),
  };
}

// Only accept the CLI-owned command result. A model response is never a quota report.
function readLimits(stdout: string): ServerProviderUsageLimit[] | undefined {
  const report = asRecord(JSON.parse(stdout));
  const command = asRecord(report?.command);
  const groups = asRecord(command?.data)?.groups;
  if (
    report?.status !== "SUCCESS" ||
    report.num_turns !== 0 ||
    command?.name !== "usage" ||
    !Array.isArray(groups)
  ) {
    return undefined;
  }
  const limits: ServerProviderUsageLimit[] = [];
  for (const value of groups) {
    const group = asRecord(value);
    const groupName = asString(group?.name);
    if (!groupName || !Array.isArray(group?.buckets)) continue;
    for (const bucket of group.buckets) {
      const limit = readLimit(bucket, groupName);
      if (limit) limits.push(limit);
    }
  }
  return limits;
}

export const antigravityUsageFetcher: ProviderUsageFetcher = {
  provider: PROVIDER,
  async fetch(ctx) {
    let cwd: string | undefined;
    try {
      // A neutral cwd keeps the quota query outside projects and their local settings.
      cwd = await mkdtemp(join(tmpdir(), "synara-agy-usage-"));
      const result = await runAntigravityHelperProcess(
        ctx.antigravityBinaryPath?.trim() || "agy",
        [
          "--print",
          "/usage",
          "--output-format",
          "json",
          "--print-timeout",
          "10s",
          "--settings",
          '{"disableSlashCommands":false}',
          "--disable-slash-commands=false",
          "--log-file",
          join(cwd, "agy.log"),
        ],
        {
          cwd,
          baseEnvironment: { HOME: ctx.homeDir, ...ctx.env, AGY_CLI_DISABLE_AUTO_UPDATE: "true" },
          timeoutMs: 12_000,
          stopOnStderr: SIGN_IN_PROMPT,
        },
      );
      if (result.stderr.includes(SIGN_IN_PROMPT))
        return needsAuthSnapshot(PROVIDER, ctx.nowMs, SOURCE);
      if (result.code === 0) {
        const limits = readLimits(result.stdout);
        if (limits)
          return buildSnapshot({
            provider: PROVIDER,
            nowMs: ctx.nowMs,
            source: SOURCE,
            status: "ok",
            limits,
          });
      }
    } catch {
      // Native output can contain login URLs and account metadata. Keep it out of snapshots.
    } finally {
      if (cwd) await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
    }
    return errorSnapshot(
      PROVIDER,
      ctx.nowMs,
      SOURCE,
      "Could not read limits from Antigravity. Check that the Antigravity CLI is installed and up to date.",
    );
  },
};
