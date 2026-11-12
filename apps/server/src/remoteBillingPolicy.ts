/** Public deployment policy survives account logout; it never grants paid access. */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { createAccountClient } from "@synara/shared/account";
import { Effect } from "effect";

import { accountApiIssuer } from "./accountAuth";
import { writeFileStringAtomically } from "./atomicWrite";
import { jitterMs } from "./backoff";
import type { RemoteSessionRegistry } from "./remoteSessions/sessionRegistry";

const MAX_FALSE_POLICY_AGE_MS = 60_000;
const REFRESH_TIMEOUT_MS = 2_000;

interface PolicyHint {
  readonly apiIssuer: string;
  readonly enforced: boolean;
  readonly checkedAt: number;
}

const pendingWrites = new Map<string, Promise<void>>();
/** Running policies by hint file, so an authenticated snapshot can stand in for a public read. */
const livePolicies = new Map<
  string,
  (hint: PolicyHint, requestedAt: number, persist: () => Promise<void>) => Promise<void>
>();

/** Monotonic time since an attempt started; never started counts as forever. */
function elapsed(startedAt: number | undefined): number {
  return startedAt === undefined ? Number.POSITIVE_INFINITY : performance.now() - startedAt;
}

function policyFilePath(stateDir: string, accountUrl: string): string {
  const authorityHash = createHash("sha256").update(accountApiIssuer(accountUrl)).digest("hex");
  return path.join(stateDir, `remote-billing-policy-${authorityHash}.json`);
}

async function withPolicyWrite(filePath: string, write: () => Promise<void>): Promise<void> {
  const previous = pendingWrites.get(filePath) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(write);
  pendingWrites.set(filePath, pending);
  try {
    await pending;
  } finally {
    if (pendingWrites.get(filePath) === pending) pendingWrites.delete(filePath);
  }
}

/**
 * Authenticated host snapshots also persist deployment policy independently of
 * login. With `requestedAt` (the monotonic start of that snapshot request) a
 * running policy also adopts it as its latest read.
 */
export async function recordRemoteBillingPolicyHint(
  stateDir: string,
  accountUrl: string,
  enforced: boolean,
  checkedAt = Date.now(),
  requestedAt?: number,
): Promise<void> {
  if (!Number.isFinite(checkedAt) || checkedAt < 0) {
    if (!enforced) throw new Error("A disabled remote billing policy requires a valid clock");
    checkedAt = 0;
  }
  const filePath = policyFilePath(stateDir, accountUrl);
  const hint: PolicyHint = { apiIssuer: accountApiIssuer(accountUrl), enforced, checkedAt };
  const persist = () =>
    Effect.runPromise(
      writeFileStringAtomically({
        filePath,
        contents: JSON.stringify(hint),
      }),
    );
  const adopt = livePolicies.get(filePath);
  await withPolicyWrite(filePath, () =>
    adopt && requestedAt !== undefined ? adopt(hint, requestedAt, persist) : persist(),
  );
}

export interface RemoteBillingPolicyOptions {
  readonly stateDir: string;
  readonly accountUrl: string;
  readonly required: boolean;
  readonly remoteSessions: RemoteSessionRegistry;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly pollIntervalMs?: number;
  /**
   * Keep polling while no remote access is active. Hosts whose unauthenticated
   * local access is itself decided by this policy need it; every other host
   * polls only while remote access is active and refreshes before admitting.
   */
  readonly pollWhileIdle?: boolean;
}

export async function startRemoteBillingPolicy(options: RemoteBillingPolicyOptions): Promise<{
  stop(): Promise<void>;
  refresh(): Promise<void>;
}> {
  const apiIssuer = accountApiIssuer(options.accountUrl);
  // Separate authorities retain their own hints across switching and signing out.
  const policyPath = policyFilePath(options.stateDir, options.accountUrl);
  const now = options.now ?? Date.now;
  let hint: PolicyHint | undefined;
  try {
    const value: unknown = JSON.parse(await fs.readFile(policyPath, "utf8"));
    if (
      typeof value === "object" &&
      value !== null &&
      "apiIssuer" in value &&
      value.apiIssuer === apiIssuer &&
      "enforced" in value &&
      typeof value.enforced === "boolean" &&
      "checkedAt" in value &&
      typeof value.checkedAt === "number" &&
      Number.isFinite(value.checkedAt) &&
      value.checkedAt >= 0
    )
      hint = { apiIssuer, enforced: value.enforced, checkedAt: value.checkedAt };
  } catch {
    // Missing/corrupt state supplies no proof that enforcement is disabled.
  }

  let falseDeadline = 0;
  let lastClock = now();
  const resetFalseDeadline = () => {
    lastClock = now();
    const age = hint === undefined ? NaN : lastClock - hint.checkedAt;
    falseDeadline =
      Number.isFinite(age) && age >= 0 && age < MAX_FALSE_POLICY_AGE_MS
        ? performance.now() + MAX_FALSE_POLICY_AGE_MS - age
        : 0;
  };
  resetFalseDeadline();
  const enforced = () => {
    if (hint?.enforced === true) return true;
    if (!options.required) return false;
    const clock = now();
    const age = hint === undefined ? NaN : clock - hint.checkedAt;
    const invalid =
      !Number.isFinite(age) ||
      age < 0 ||
      age >= MAX_FALSE_POLICY_AGE_MS ||
      clock < lastClock ||
      performance.now() >= falseDeadline;
    lastClock = clock;
    if (invalid) falseDeadline = 0;
    return invalid;
  };
  const pollIntervalMs = Math.min(
    MAX_FALSE_POLICY_AGE_MS,
    Math.max(100, options.pollIntervalMs ?? 15_000),
  );
  let stopped = false;
  let inFlight: Promise<void> | undefined;
  let requestAbort: AbortController | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  // Monotonic start of the newest attempt, and of the newest settled one.
  let attemptStartedAt: number | undefined;
  let settledAttemptStartedAt: number | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  // Jittered only downwards: the interval also bounds how old a decision's policy may be.
  let nextPollAfterMs = pollIntervalMs;
  // A false answer requested before the newest true one is stale.
  let newestTrueRequestedAt = Number.NEGATIVE_INFINITY;
  // Every read arms the next one an interval later. While remote connections
  // are open this keeps the fixed cadence; an idle host stops polling here.
  const armPoll = () => {
    if (stopped || pollTimer) return;
    const due =
      attemptStartedAt === undefined
        ? 0
        : Math.max(0, attemptStartedAt + nextPollAfterMs - performance.now());
    pollTimer = setTimeout(() => {
      pollTimer = undefined;
      if (options.pollWhileIdle === true || options.remoteSessions.remoteConnectionsOpen)
        void refresh();
    }, due);
    pollTimer.unref();
  };
  const rearmFrom = (startedAt: number) => {
    nextPollAfterMs = jitterMs(pollIntervalMs, { towards: "shorter" });
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = undefined;
    attemptStartedAt = Math.max(attemptStartedAt ?? startedAt, startedAt);
    armPoll();
  };
  // A decision may use a policy no older than the polling cadence allows: one
  // interval since the newest attempt, or one interval plus one bounded request
  // while that attempt is still in flight.
  const ensureFresh = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (inFlight)
      return elapsed(settledAttemptStartedAt) < pollIntervalMs + REFRESH_TIMEOUT_MS
        ? Promise.resolve()
        : inFlight;
    return elapsed(attemptStartedAt) < pollIntervalMs ? Promise.resolve() : refresh();
  };
  const unregister = options.remoteSessions.registerGlobalBillingPolicy({
    authority: apiIssuer,
    enforced,
    ensureFresh,
  });
  // Covers a connection admitted just as the idle timer lapsed.
  const stopWatchingConnections = options.remoteSessions.onRemoteConnectionOpened(armPoll);
  const enforceAdmission = () => {
    if (stopped) return;
    if (!options.remoteSessions.canAdmitRemoteSession()) {
      options.remoteSessions.closeAll("Remote billing policy requires authorization");
    }
    if (expiryTimer) clearTimeout(expiryTimer);
    expiryTimer = undefined;
    if (options.required && hint?.enforced === false && !enforced()) {
      expiryTimer = setTimeout(
        enforceAdmission,
        Math.max(
          1,
          Math.min(
            hint.checkedAt + MAX_FALSE_POLICY_AGE_MS - now(),
            falseDeadline - performance.now(),
          ),
        ),
      );
      expiryTimer.unref();
    }
  };
  enforceAdmission();

  const refresh = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (inFlight) return inFlight;
    enforceAdmission();
    const policyRevision = options.remoteSessions.billingPolicyRevision;
    const startedAt = performance.now();
    rearmFrom(startedAt);
    inFlight = (async () => {
      const controller = new AbortController();
      requestAbort = controller;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const client = createAccountClient({
          baseUrl: options.accountUrl,
          fetch: ((input, init) =>
            (options.fetch ?? fetch)(input, {
              ...init,
              cache: "no-store",
              redirect: "error",
              signal: init?.signal
                ? AbortSignal.any([init.signal, controller.signal])
                : controller.signal,
            })) as typeof fetch,
        });
        const instance = await Promise.race([
          client.instance(),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => {
              controller.abort();
              reject(new Error("Remote billing policy request timed out"));
            }, REFRESH_TIMEOUT_MS);
          }),
        ]);
        if (stopped || typeof instance.remoteBillingEnforced !== "boolean") return;
        const clock = now();
        if ((!Number.isFinite(clock) || clock < 0) && !instance.remoteBillingEnforced) return;
        const checkedAt = Number.isFinite(clock) && clock >= 0 ? clock : 0;
        const next: PolicyHint = { apiIssuer, enforced: instance.remoteBillingEnforced, checkedAt };
        // A live true response closes unpaid sockets before waiting for disk I/O.
        if (next.enforced) {
          newestTrueRequestedAt = Math.max(newestTrueRequestedAt, startedAt);
          hint = next;
          enforceAdmission();
        }
        let saved = false;
        await withPolicyWrite(policyPath, async () => {
          if (
            stopped ||
            (!next.enforced &&
              (options.remoteSessions.billingPolicyRevision !== policyRevision ||
                startedAt < newestTrueRequestedAt))
          )
            return;
          await Effect.runPromise(
            writeFileStringAtomically({
              filePath: policyPath,
              contents: JSON.stringify(next),
            }),
          );
          saved = true;
        });
        if (
          !saved ||
          (!next.enforced &&
            (options.remoteSessions.billingPolicyRevision !== policyRevision ||
              startedAt < newestTrueRequestedAt))
        )
          return;
        if (stopped) return;
        hint = next;
        resetFalseDeadline();
        if (!next.enforced) options.remoteSessions.setRemoteBillingEnforced(false);
      } catch {
        // Outages and older servers cannot refresh a false proof or erase true.
      } finally {
        if (timeout) clearTimeout(timeout);
        requestAbort = undefined;
        enforceAdmission();
      }
    })().finally(() => {
      inFlight = undefined;
      settledAttemptStartedAt = Math.max(settledAttemptStartedAt ?? startedAt, startedAt);
      // A timer that lapsed during a slow attempt found it in flight and started nothing.
      armPoll();
    });
    return inFlight;
  };

  // An authenticated snapshot carries the same deployment flag. Adopting it as a
  // read keeps the policy fresh without a public request while snapshots flow.
  const adopt = async (next: PolicyHint, requestedAt: number, persist: () => Promise<void>) => {
    if (stopped || next.apiIssuer !== apiIssuer) return;
    // Check while holding the write slot so a rejected snapshot cannot survive a restart.
    if (!next.enforced && requestedAt < newestTrueRequestedAt) return;
    await persist();
    if (stopped) return;
    if (next.enforced) {
      newestTrueRequestedAt = Math.max(newestTrueRequestedAt, requestedAt);
      hint = next;
      enforceAdmission();
    } else {
      if (requestedAt < newestTrueRequestedAt) return;
      hint = next;
      resetFalseDeadline();
      enforceAdmission();
    }
    settledAttemptStartedAt = Math.max(settledAttemptStartedAt ?? requestedAt, requestedAt);
    rearmFrom(requestedAt);
  };
  livePolicies.set(policyPath, adopt);

  // Only disk restoration precedes startup; the first public read is asynchronous.
  void refresh();
  return {
    refresh,
    async stop() {
      if (options.remoteSessions.remoteBillingEnforced)
        options.remoteSessions.setRemoteBillingEnforced(true);
      stopped = true;
      if (livePolicies.get(policyPath) === adopt) livePolicies.delete(policyPath);
      stopWatchingConnections();
      if (pollTimer) clearTimeout(pollTimer);
      if (expiryTimer) clearTimeout(expiryTimer);
      requestAbort?.abort();
      await inFlight;
      unregister();
    },
  };
}
