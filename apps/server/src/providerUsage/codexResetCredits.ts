// Reads and explicitly confirmed redemptions use the installed Codex app-server protocol.
// The CLI owns its authentication lifecycle; no provider turn is started by this probe.
import type {
  CodexResetCreditOutcome,
  ServerCodexResetCredit,
  ServerCodexResetCreditStatus,
  ServerCodexResetCredits,
  ServerConsumeCodexResetCreditInput,
} from "@synara/contracts";
import { spawnProcess } from "@synara/shared/processRuntime";

import { CodexJsonlFramer, CodexJsonlWriter } from "../codexAppServerTransport";
import { createLogger } from "../logger";
import { noteSpawnedProcess, signalOwnedChildProcess } from "../platform/processTreeController";
import { asRecord, asString, isoFromUnixMillis, isoFromUnixSeconds } from "./parse";

const log = createLogger("provider-usage:codex-resets");
const APP_SERVER_TIMEOUT_MS = 20_000;

type Request = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export interface CodexResetCreditProbeInput {
  readonly binaryPath?: string | undefined;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
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
    root?.rateLimitResetCredits ??
    root?.rate_limit_reset_credits ??
    (root?.rateLimits ? null : json);
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
  const credits: ServerCodexResetCredit[] = creditsRaw.flatMap((entry) => {
    const credit = asRecord(entry);
    const id = asString(credit?.id);
    if (!credit || !id) return [];
    const statusRaw = asString(credit.status);
    const status: ServerCodexResetCreditStatus =
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

/** Only the ordinary Codex bucket can make a reset worthwhile; other model quotas cannot. */
export function canUseCodexResetCredit(json: unknown): boolean | undefined {
  const root = asRecord(json);
  const buckets = asRecord(root?.rateLimitsByLimitId);
  const core = buckets ? asRecord(buckets.codex) : asRecord(root?.rateLimits);
  const windows = [asRecord(core?.primary), asRecord(core?.secondary)]
    .map((window) => window?.usedPercent)
    .filter((used): used is number => typeof used === "number" && Number.isFinite(used));
  return windows.length === 0 ? undefined : windows.some((used) => used >= 90);
}

async function withAppServer<T>(
  input: CodexResetCreditProbeInput,
  run: (request: Request) => Promise<T>,
): Promise<T> {
  const child = spawnProcess(input.binaryPath?.trim() || "codex", ["app-server"], {
    cwd: input.cwd,
    env: input.env,
    stdio: "pipe",
  });
  noteSpawnedProcess(child.pid);
  const framer = new CodexJsonlFramer();
  const writer = new CodexJsonlWriter(child.stdin);
  let nextId = 0;
  let stopped = false;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const { promise: failed, reject: failSession } = Promise.withResolvers<never>();
  const fail = (cause: unknown) => {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
    failSession(error);
  };
  const request: Request = (method, params) => {
    if (stopped) return Promise.reject(new Error("Codex reset-credit probe is closed."));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      void writer.write({ id, method, params }).catch(fail);
    });
  };
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.stdout.on("error", fail);
  child.stderr.resume();
  child.on("exit", () => {
    if (!stopped) fail(new Error("Codex app-server exited during the reset-credit request."));
  });
  child.stdout.on("data", (chunk: Buffer) => {
    if (stopped) return;
    try {
      for (const line of framer.push(chunk)) {
        if (!line.trim()) continue;
        const message = asRecord(JSON.parse(line));
        if (!message) continue;
        if (typeof message.method === "string" && message.id !== undefined) {
          // Account probes cannot approve tools or service interactive authentication requests.
          void writer
            .write({
              id: message.id,
              error: {
                code: -32601,
                message: "Interactive requests are unsupported by this usage probe.",
              },
            })
            .catch(fail);
          continue;
        }
        const waiter = typeof message.id === "number" ? pending.get(message.id) : undefined;
        if (!waiter) continue;
        pending.delete(message.id as number);
        if (message.error !== undefined)
          waiter.reject(new Error("Codex rejected the reset-credit request."));
        else waiter.resolve(message.result);
      }
    } catch (cause) {
      fail(cause);
    }
  });
  const timer = setTimeout(
    () => fail(new Error("Codex reset-credit request timed out. Retry the same attempt.")),
    APP_SERVER_TIMEOUT_MS,
  );
  try {
    return await Promise.race([
      failed,
      (async () => {
        await request("initialize", {
          clientInfo: { name: "synara", title: "Synara", version: "0.1.0" },
          capabilities: { experimentalApi: true },
        });
        await writer.write({ method: "initialized" });
        return run(request);
      })(),
    ]);
  } finally {
    stopped = true;
    clearTimeout(timer);
    const closed = new Error("Codex reset-credit probe closed.");
    writer.close(closed);
    for (const waiter of pending.values()) waiter.reject(closed);
    pending.clear();
    framer.reset();
    try {
      signalOwnedChildProcess(child, "SIGTERM");
    } catch {
      /* Already exited. */
    }
    // A CLI/shim ignoring SIGTERM must not linger after a short-lived probe.
    const killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          signalOwnedChildProcess(child, "SIGKILL");
        } catch {
          /* Already exited. */
        }
      }
    }, 1_000);
    killTimer.unref();
    child.once("exit", () => clearTimeout(killTimer));
  }
}

/** Optional enrichment: a missing CLI or account mismatch must not break ordinary usage. */
export async function fetchCodexResetCredits(
  input: CodexResetCreditProbeInput & { readonly expectedAccountId?: string | undefined },
): Promise<ServerCodexResetCredits | undefined> {
  if (!input.expectedAccountId) return undefined;
  try {
    return await withAppServer(input, async (request) => {
      const response = await request("account/rateLimits/read", {});
      const accountId = asString(asRecord(response)?.accountId);
      if (accountId !== input.expectedAccountId) return undefined;
      const credits = parseCodexResetCredits(response);
      return credits
        ? { ...credits, accountId, canUse: canUseCodexResetCredit(response) }
        : undefined;
    });
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

const activeResets = new Map<string, { key: string; promise: Promise<CodexResetCreditOutcome> }>();

/** The client persists one key per confirmed attempt, including transport failures/reconnects. */
export async function consumeCodexResetCredit(
  input: CodexResetCreditProbeInput & ServerConsumeCodexResetCreditInput,
): Promise<CodexResetCreditOutcome> {
  const active = activeResets.get(input.accountId);
  if (active) {
    if (active.key === input.idempotencyKey) return active.promise;
    throw new Error("A reset is already in progress for this Codex account.");
  }
  const promise = withAppServer(input, async (request) => {
    const usage = await request("account/rateLimits/read", {});
    if (asString(asRecord(usage)?.accountId) !== input.accountId) {
      throw new Error("The Codex account changed. Refresh usage before using a reset.");
    }
    const canUse = canUseCodexResetCredit(usage);
    if (canUse === undefined)
      throw new Error(
        "Current Codex usage is unavailable. Retry the same attempt when it returns.",
      );
    if (!canUse) return "nothingToReset";
    const result = await request("account/rateLimitResetCredit/consume", {
      idempotencyKey: input.idempotencyKey,
      ...(input.creditId ? { creditId: input.creditId } : {}),
    });
    const outcome = asRecord(result)?.outcome;
    if (typeof outcome === "string" && RESET_OUTCOMES.has(outcome))
      return outcome as CodexResetCreditOutcome;
    throw new Error("Codex returned an unknown reset result. Retry the same attempt.");
  });
  activeResets.set(input.accountId, { key: input.idempotencyKey, promise });
  try {
    return await promise;
  } finally {
    activeResets.delete(input.accountId);
  }
}
