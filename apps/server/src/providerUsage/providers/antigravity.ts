// FILE: providerUsage/providers/antigravity.ts
// Purpose: Live Antigravity quota fetcher. When the local `agy` CLI (or the
// Antigravity language server) is running, it exposes gRPC-web JSON endpoints on
// a loopback port. This fetcher discovers the listening ports of a matching
// process (lsof, read-only), probes `GetUserStatus` and
// `RetrieveUserQuotaSummary`, and maps the returned quota groups/buckets into
// Synara's account-limit plane. No credentials are read: the local server does
// the authenticated fetch on the user's behalf. Requests are pinned to
// 127.0.0.1 and self-signed TLS is accepted only on loopback.

import { execFile } from "node:child_process";
import https from "node:https";
import nodePath from "node:path";

import type { ServerProviderUsageLimit, ServerProviderUsageLine } from "@synara/contracts";

import {
  asFiniteNumber,
  asRecord,
  asString,
  buildSnapshot,
  clampPercent,
  errorSnapshot,
  isoFromString,
  toUsedPercent,
} from "../parse";
import type { ProviderUsageContext, ProviderUsageFetcher } from "../types";

const SOURCE = "antigravity-local-server";
const GET_USER_STATUS_PATH = "/exa.language_server_pb.LanguageServerService/GetUserStatus";
const QUOTA_SUMMARY_PATH = "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary";
const REQUEST_BODY = {
  metadata: {
    ideName: "antigravity",
    extensionName: "antigravity",
    ideVersion: "unknown",
    locale: "en",
  },
};
const MAX_PORTS = 8;
const REQUEST_TIMEOUT_MS = 5_000;

interface LoopbackEndpoint {
  port: number;
  scheme: "http" | "https";
}

export interface AntigravityProcessDiscovery {
  detectPids(ctx: ProviderUsageContext): Promise<number[]>;
  listeningPorts(pid: number): Promise<number[]>;
}

const defaultDiscovery: AntigravityProcessDiscovery = {
  detectPids: (ctx) => detectAgyPids(ctx),
  listeningPorts,
};

let discovery: AntigravityProcessDiscovery = defaultDiscovery;

/** Test-only: inject a fake process/port discovery so tests never run lsof. */
export function __setAntigravityDiscoveryForTests(next: AntigravityProcessDiscovery | null): void {
  discovery = next ?? defaultDiscovery;
}

function execFileText(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve("");
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function agyProcessPatterns(ctx: ProviderUsageContext): string[] {
  const binary = ctx.antigravityBinaryPath?.trim() || "agy";
  const basename = nodePath.basename(binary);
  // Match both the configured binary path and the bare basename so a running
  // `agy` spawned via PATH is found even when the setting is an absolute path.
  return [binary, basename];
}

export async function detectAgyPids(ctx: ProviderUsageContext): Promise<number[]> {
  const pids = new Set<number>();
  for (const pattern of agyProcessPatterns(ctx)) {
    const output = await execFileText("pgrep", ["-f", pattern], 3_000);
    for (const line of output.split("\n")) {
      const pid = Number(line.trim());
      if (Number.isInteger(pid) && pid > 0) {
        pids.add(pid);
      }
    }
  }
  // pgrep -f can match this process's own command line when the test runner
  // embeds the binary name; require the process to own a listening TCP port so
  // false positives are dropped before any request is attempted.
  const withPorts: number[] = [];
  for (const pid of pids) {
    const ports = await listeningPorts(pid);
    if (ports.length > 0) {
      withPorts.push(pid);
    }
  }
  return withPorts;
}

export async function listeningPorts(pid: number): Promise<number[]> {
  const output = await execFileText(
    "lsof",
    ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", String(pid)],
    3_000,
  );
  const ports = new Set<number>();
  for (const line of output.split("\n")) {
    const match = line.match(/:(\d+)\s+\(LISTEN\)$/u);
    const port = match ? Number(match[1]) : undefined;
    if (port !== undefined && Number.isInteger(port) && port > 0 && port <= 65535) {
      ports.add(port);
    }
  }
  return [...ports].slice(0, MAX_PORTS);
}

function endpointOrder(ports: number[]): LoopbackEndpoint[] {
  // Prefer the CLI's own HTTP language-server port; fall back to HTTPS (used by
  // the desktop language server) and to remaining ports under both schemes.
  const endpoints: LoopbackEndpoint[] = [];
  for (const scheme of ["http", "https"] as const) {
    for (const port of ports) {
      endpoints.push({ port, scheme });
    }
  }
  return endpoints;
}

function postJson(input: {
  endpoint: LoopbackEndpoint;
  path: string;
  body: unknown;
  timeoutMs: number;
}): Promise<{ ok: boolean; json: unknown; status: number }> {
  const body = JSON.stringify(input.body);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Connect-Protocol-Version": "1",
    "Content-Length": String(Buffer.byteLength(body)),
  };
  const options: https.RequestOptions = {
    hostname: "127.0.0.1",
    port: input.endpoint.port,
    path: input.path,
    method: "POST",
    headers,
    timeout: input.timeoutMs,
  };
  if (input.endpoint.scheme === "https") {
    // The Antigravity language server uses a self-signed loopback cert. Accept
    // it only for 127.0.0.1; anything else is rejected before this path runs.
    options.rejectUnauthorized = false;
  }
  if (input.endpoint.scheme !== "https") {
    return fetch(`http://127.0.0.1:${input.endpoint.port}${input.path}`, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(input.timeoutMs),
    })
      .then(async (response) => {
        let json: unknown = null;
        try {
          json = await response.json();
        } catch {
          json = null;
        }
        return { ok: response.ok, json, status: response.status };
      })
      .catch(() => ({ ok: false, json: null, status: 0 }));
  }
  return new Promise((resolve) => {
    const request = https.request(options, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let json: unknown = null;
        try {
          json = JSON.parse(raw);
        } catch {
          json = null;
        }
        resolve({
          ok: (response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300,
          json,
          status: response.statusCode ?? 0,
        });
      });
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve({ ok: false, json: null, status: 0 }));
    request.end(body);
  });
}

function asCodeOk(value: unknown): boolean {
  // The live agy server omits `code` entirely on success; absence is success.
  if (value === undefined || value === null) {
    return true;
  }
  if (typeof value === "number") {
    return value === 0;
  }
  if (typeof value === "string") {
    return value.toLowerCase() === "ok" || value.toLowerCase() === "success" || value === "0";
  }
  return false;
}

interface AntigravityStatus {
  planName?: string;
  monthlyPromptCredits?: number;
  monthlyFlowCredits?: number;
  availablePromptCredits?: number;
  availableFlowCredits?: number;
  modelQuotas: ReadonlyArray<{ label: string; remainingFraction: number; resetAt?: string }>;
}

export function parseUserStatus(json: unknown): AntigravityStatus | null {
  const root = asRecord(json);
  if (!root || !asCodeOk(root.code)) {
    return null;
  }
  const userStatus = asRecord(root.userStatus);
  if (!userStatus) {
    return null;
  }
  const planStatus = asRecord(userStatus.planStatus);
  const planInfo = asRecord(planStatus?.planInfo);
  const modelConfigs = asRecord(userStatus.cascadeModelConfigData);
  const modelQuotas = (
    Array.isArray(modelConfigs?.clientModelConfigs) ? modelConfigs.clientModelConfigs : []
  ).flatMap((entry): Array<{ label: string; remainingFraction: number; resetAt?: string }> => {
    const model = asRecord(entry);
    const label = asString(model?.label);
    const quotaInfo = asRecord(model?.quotaInfo);
    const remainingFraction = asFiniteNumber(quotaInfo?.remainingFraction);
    if (!label || remainingFraction === undefined) {
      return [];
    }
    const resetAt = isoFromString(quotaInfo?.resetTime);
    return resetAt !== undefined
      ? [{ label, remainingFraction, resetAt }]
      : [{ label, remainingFraction }];
  });

  const planName = asString(planInfo?.planName);
  const monthlyPromptCredits = asFiniteNumber(planInfo?.monthlyPromptCredits);
  const monthlyFlowCredits = asFiniteNumber(planInfo?.monthlyFlowCredits);
  // The live server reports the remaining monthly credits on `planStatus`
  // (sibling of `planInfo`), not on the top-level `userStatus`.
  const availablePromptCredits = asFiniteNumber(
    planStatus?.availablePromptCredits ?? userStatus.availablePromptCredits,
  );
  const availableFlowCredits = asFiniteNumber(
    planStatus?.availableFlowCredits ?? userStatus.availableFlowCredits,
  );
  return {
    ...(planName !== undefined ? { planName } : {}),
    ...(monthlyPromptCredits !== undefined ? { monthlyPromptCredits } : {}),
    ...(monthlyFlowCredits !== undefined ? { monthlyFlowCredits } : {}),
    ...(availablePromptCredits !== undefined ? { availablePromptCredits } : {}),
    ...(availableFlowCredits !== undefined ? { availableFlowCredits } : {}),
    modelQuotas,
  };
}

interface AntigravityQuotaGroup {
  displayName: string;
  buckets: ReadonlyArray<{
    displayName: string;
    window?: string;
    remainingFraction: number;
    resetAt?: string;
  }>;
}

export function parseQuotaSummary(json: unknown): ReadonlyArray<AntigravityQuotaGroup> {
  const root = asRecord(json);
  if (!root || !asCodeOk(root.code)) {
    return [];
  }
  const response = asRecord(root.response ?? root.summary);
  const groups = Array.isArray(response?.groups) ? response.groups : [];
  return groups.flatMap((group): AntigravityQuotaGroup[] => {
    const record = asRecord(group);
    const displayName = asString(record?.displayName);
    const buckets = Array.isArray(record?.buckets) ? record.buckets : [];
    const parsedBuckets = buckets.flatMap(
      (bucket): Array<AntigravityQuotaGroup["buckets"][number]> => {
        const item = asRecord(bucket);
        const name = asString(item?.displayName);
        const remainingFraction = asFiniteNumber(item?.remainingFraction);
        if (!name || remainingFraction === undefined) {
          return [];
        }
        const resetAt = isoFromString(item?.resetTime);
        const window = asString(item?.window);
        return [
          window !== undefined && resetAt !== undefined
            ? { displayName: name, window, remainingFraction, resetAt }
            : window !== undefined
              ? { displayName: name, window, remainingFraction }
              : resetAt !== undefined
                ? { displayName: name, remainingFraction, resetAt }
                : {
                    displayName: name,
                    remainingFraction,
                  },
        ];
      },
    );
    if (parsedBuckets.length === 0) {
      return [];
    }
    return [{ displayName: displayName ?? "Quota", buckets: parsedBuckets }];
  });
}

export function buildAntigravitySnapshot(input: {
  status: AntigravityStatus;
  quotaGroups: ReadonlyArray<AntigravityQuotaGroup>;
  nowMs: number;
}): ReturnType<typeof buildSnapshot> {
  const limits: ServerProviderUsageLimit[] = [];
  const usageLines: ServerProviderUsageLine[] = [];

  // The quota summary is the authoritative limit surface: one limit row per
  // bucket that reports a remaining fraction. Only windows with an explicit
  // reset time get a resetsAt so we never guess a cadence.
  for (const group of input.quotaGroups) {
    for (const bucket of group.buckets) {
      limits.push({
        window: `${group.displayName} · ${bucket.displayName}`,
        usedPercent: clampPercent(toUsedPercent(1 - bucket.remainingFraction)),
        ...(bucket.resetAt ? { resetsAt: bucket.resetAt } : {}),
      });
    }
  }

  const monthlyPrompt = input.status.monthlyPromptCredits;
  const availablePrompt = input.status.availablePromptCredits;
  if (monthlyPrompt !== undefined && monthlyPrompt > 0) {
    const remaining =
      availablePrompt !== undefined ? Math.min(monthlyPrompt, availablePrompt) : monthlyPrompt;
    usageLines.push({
      label: "Prompt credits",
      value: `${new Intl.NumberFormat(undefined, { notation: "compact" }).format(remaining)} of ${new Intl.NumberFormat(undefined, { notation: "compact" }).format(monthlyPrompt)} remaining`,
    });
  }
  const monthlyFlow = input.status.monthlyFlowCredits;
  const availableFlow = input.status.availableFlowCredits;
  if (monthlyFlow !== undefined && monthlyFlow > 0) {
    const remaining =
      availableFlow !== undefined ? Math.min(monthlyFlow, availableFlow) : monthlyFlow;
    usageLines.push({
      label: "Flow credits",
      value: `${new Intl.NumberFormat(undefined, { notation: "compact" }).format(remaining)} of ${new Intl.NumberFormat(undefined, { notation: "compact" }).format(monthlyFlow)} remaining`,
    });
  }

  return buildSnapshot({
    provider: "antigravity",
    nowMs: input.nowMs,
    status: "ok",
    source: SOURCE,
    limits,
    usageLines,
    ...(input.status.planName ? { planName: input.status.planName } : {}),
  });
}

async function fetchFromEndpoints(endpoints: ReadonlyArray<LoopbackEndpoint>): Promise<{
  status: AntigravityStatus | null;
  quotaGroups: ReadonlyArray<AntigravityQuotaGroup>;
}> {
  for (const endpoint of endpoints) {
    const statusResult = await postJson({
      endpoint,
      path: GET_USER_STATUS_PATH,
      body: REQUEST_BODY,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    const status = parseUserStatus(statusResult.json);
    if (!status) {
      continue;
    }
    const quotaResult = await postJson({
      endpoint,
      path: QUOTA_SUMMARY_PATH,
      body: REQUEST_BODY,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    const quotaGroups = parseQuotaSummary(quotaResult.json);
    return { status, quotaGroups };
  }
  return { status: null, quotaGroups: [] };
}

/** Test-only: run discovery against a fixed pid set/port list. */
export function __endpointOrderForTests(ports: number[]): LoopbackEndpoint[] {
  return endpointOrder(ports);
}

export const antigravityUsageFetcher: ProviderUsageFetcher = {
  provider: "antigravity",
  // No credential identity is read, so caching is keyed by the binary path only.
  cacheKey: async (ctx) => `antigravity:${ctx.antigravityBinaryPath?.trim() || "agy"}`,
  fetch: async (ctx) => {
    try {
      const pids = await discovery.detectPids(ctx);
      if (pids.length === 0) {
        return buildSnapshot({
          provider: "antigravity",
          nowMs: ctx.nowMs,
          status: "unsupported",
          source: SOURCE,
          detail:
            "No local Antigravity process is running. Launch Antigravity or `agy` to see account limits.",
        });
      }
      const allPorts = [
        ...new Set((await Promise.all(pids.map((pid) => discovery.listeningPorts(pid)))).flat()),
      ].slice(0, MAX_PORTS);
      const endpoints = endpointOrder(allPorts);
      const result = await fetchFromEndpoints(endpoints);
      if (!result.status) {
        return errorSnapshot(
          "antigravity",
          ctx.nowMs,
          SOURCE,
          "The local Antigravity server did not answer the quota probe.",
        );
      }
      return buildAntigravitySnapshot({
        status: result.status,
        quotaGroups: result.quotaGroups,
        nowMs: ctx.nowMs,
      });
    } catch {
      return errorSnapshot(
        "antigravity",
        ctx.nowMs,
        SOURCE,
        "Antigravity usage is temporarily unavailable.",
      );
    }
  },
};
