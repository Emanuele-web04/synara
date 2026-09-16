// FILE: providerUsage/codexResetCredits.ts
// Purpose: Banked Codex rate-limit resets. The ChatGPT `wham/usage` endpoint Synara polls for
// quota windows does not report reset credits, so reads and consumes go through a short-lived
// `codex app-server` probe instead (`account/rateLimits/read` /
// `account/rateLimitResetCredit/consume`) — the same methods third-party Codex UIs use.
// Reads never throw (undefined = not reported); consumes throw only on transport failure or an
// unrecognized outcome. Spawning app-server never touches the CLI's credential store, so there
// is no refresh-token rotation risk here.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import type {
  CodexResetCreditOutcome,
  ServerCodexResetCredits,
} from "@synara/contracts";

import { createLogger } from "../logger";
import { asRecord, asString, isoFromUnixMillis, isoFromUnixSeconds } from "./parse";

const log = createLogger("provider-usage:codex-resets");

const APP_SERVER_TIMEOUT_MS = 20_000;
const APP_SERVER_REQUEST_TIMEOUT_MS = 15_000;

export interface CodexResetCreditProbeInput {
  /** Codex CLI binary (settings.providers.codex.binaryPath); defaults to "codex". */
  readonly binaryPath?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
}

function resolveBinary(binaryPath: string | undefined): string {
  const trimmed = binaryPath?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "codex";
}

function epochToIso(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) return epochToIso(parsed);
    }
    return undefined;
  }
  // Millisecond epochs passed 1e11 in 1973; second epochs stay below 1e10 until 2286.
  return value > 100_000_000_000 ? isoFromUnixMillis(value) : isoFromUnixSeconds(value);
}

/** Pure parse of the `rateLimitResetCredits` payload from `account/rateLimits/read`. */
export function parseCodexResetCredits(json: unknown): ServerCodexResetCredits | undefined {
  const root = asRecord(json);
  const raw =
    root?.rateLimitResetCredits ?? root?.rate_limit_reset_credits ?? (root?.rateLimits ? null : json);
  const rec = asRecord(raw);
  if (!rec) return undefined;
  const count =
    typeof rec.availableCount === "number" && Number.isFinite(rec.availableCount)
      ? Math.max(0, Math.floor(rec.availableCount))
      : typeof rec.available_count === "number" && Number.isFinite(rec.available_count)
        ? Math.max(0, Math.floor(rec.available_count))
        : undefined;
  if (count === undefined) return undefined;
  const creditsRaw = rec.credits;
  if (!Array.isArray(creditsRaw)) {
    return { availableCount: count };
  }
  const credits = creditsRaw.flatMap((entry) => {
    const credit = asRecord(entry);
    const id = asString(credit?.id);
    if (!credit || !id) return [];
    const statusRaw = asString(credit.status);
    const status =
      statusRaw === "available" || statusRaw === "redeeming" || statusRaw === "redeemed"
        ? statusRaw
        : ("unknown" as const);
    return [
      {
        id,
        status,
        ...(epochToIso(credit.grantedAt ?? credit.granted_at)
          ? { grantedAt: epochToIso(credit.grantedAt ?? credit.granted_at) as string }
          : {}),
        ...(epochToIso(credit.expiresAt ?? credit.expires_at)
          ? { expiresAt: epochToIso(credit.expiresAt ?? credit.expires_at) as string }
          : {}),
        ...(asString(credit.title) ? { title: asString(credit.title) as string } : {}),
        ...(asString(credit.description)
          ? { description: asString(credit.description) as string }
          : {}),
      },
    ];
  });
  return { availableCount: count, credits };
}

interface JsonRpcResult {
  result?: unknown;
  error?: unknown;
}

async function requestAppServer(
  input: CodexResetCreditProbeInput,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
): Promise<JsonRpcResult> {
  const binary = resolveBinary(input.binaryPath);
  return new Promise<JsonRpcResult>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binary, ["app-server"], {
        cwd: input.cwd,
        env: input.env,
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch (cause) {
      reject(cause instanceof Error ? cause : new Error(String(cause)));
      return;
    }
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        // Already exited; nothing to clean up.
      }
      fn();
    };
    const timer = setTimeout(() => {
      done(() => reject(new Error(`Codex app-server ${method} timed out`)));
    }, timeoutMs);
    timer.unref?.();

    let buffer = "";
    let nextId = 0;
    const pending = new Map<number, (result: JsonRpcResult) => void>();
    const send = (message: Record<string, unknown>) => {
      if (!child.stdin || child.stdin.destroyed) return;
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const request = (rpcMethod: string, rpcParams: unknown): Promise<JsonRpcResult> =>
      new Promise<JsonRpcResult>((resolveRequest) => {
        nextId += 1;
        pending.set(nextId, resolveRequest);
        send({ id: nextId, method: rpcMethod, params: rpcParams });
      });

    child.on("error", (cause) => {
      done(() => reject(cause instanceof Error ? cause : new Error(String(cause))));
    });
    child.on("exit", () => {
      done(() => reject(new Error(`Codex app-server exited during ${method}`)));
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line) continue;
        let parsed: Record<string, unknown> | null = null;
        try {
          const value: unknown = JSON.parse(line);
          parsed = asRecord(value);
        } catch {
          continue;
        }
        if (!parsed) continue;
        // Server-to-client requests (e.g. auth prompts): acknowledge minimally so the
        // probe is never wedged waiting on an interaction we cannot complete.
        if (typeof parsed.method === "string" && parsed.id !== undefined) {
          send({ id: parsed.id, result: {} });
          continue;
        }
        if (parsed.id !== undefined) {
          const waiter = pending.get(Number(parsed.id));
          if (waiter) {
            pending.delete(Number(parsed.id));
            waiter(parsed as JsonRpcResult);
          }
        }
      }
    });

    void (async () => {
      try {
        await request("initialize", {
          clientInfo: { name: "synara", title: "Synara", version: "0.1.0" },
          capabilities: { experimentalApi: true },
        });
        send({ method: "initialized" });
        // Give the server a beat to settle before the account call.
        await new Promise((wake) => setTimeout(wake, 300));
        const result = await request(method, params);
        done(() => resolve(result));
      } catch (cause) {
        done(() => reject(cause instanceof Error ? cause : new Error(String(cause))));
      }
    })();
  });
}

/**
 * Read banked reset credits via `account/rateLimits/read`. Never throws — any transport or
 * parse failure resolves to undefined so the quota fetch it rides along with stays healthy.
 */
export async function fetchCodexResetCredits(
  input: CodexResetCreditProbeInput,
): Promise<ServerCodexResetCredits | undefined> {
  try {
    const response = await requestAppServer(
      input,
      "account/rateLimits/read",
      {},
      APP_SERVER_TIMEOUT_MS,
    );
    if (response.error !== undefined) {
      log.warn("codex reset-credit read rejected", {});
      return undefined;
    }
    return parseCodexResetCredits(response.result);
  } catch (cause) {
    log.warn("codex reset-credit probe unavailable", {
      message: cause instanceof Error ? cause.message : String(cause),
    });
    return undefined;
  }
}

const RESET_OUTCOMES: ReadonlySet<string> = new Set([
  "reset",
  "nothingToReset",
  "noCredit",
  "alreadyRedeemed",
]);

/** Spend one banked reset via `account/rateLimitResetCredit/consume`. */
export async function consumeCodexResetCredit(
  input: CodexResetCreditProbeInput & { readonly creditId?: string },
): Promise<CodexResetCreditOutcome> {
  const response = await requestAppServer(
    input,
    "account/rateLimitResetCredit/consume",
    {
      idempotencyKey: randomUUID(),
      ...(input.creditId ? { creditId: input.creditId } : {}),
    },
    APP_SERVER_REQUEST_TIMEOUT_MS,
  );
  if (response.error !== undefined) {
    throw new Error("Codex rejected the reset request.");
  }
  const outcome = asRecord(response.result)?.outcome;
  if (typeof outcome === "string" && RESET_OUTCOMES.has(outcome)) {
    return outcome as CodexResetCreditOutcome;
  }
  throw new Error("Codex returned an unknown reset result.");
}
