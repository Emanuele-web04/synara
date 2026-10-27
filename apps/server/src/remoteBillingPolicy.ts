/** Public deployment policy survives account logout; it never grants paid access. */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { createAccountClient } from "@synara/shared/account";
import { Effect } from "effect";

import { accountApiIssuer } from "./accountAuth";
import { writeFileStringAtomically } from "./atomicWrite";
import type { RemoteSessionRegistry } from "./remoteSessions/sessionRegistry";

const MAX_FALSE_POLICY_AGE_MS = 60_000;
const REFRESH_TIMEOUT_MS = 2_000;

interface PolicyHint {
  readonly apiIssuer: string;
  readonly enforced: boolean;
  readonly checkedAt: number;
}

const pendingWrites = new Map<string, Promise<void>>();

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

/** Authenticated host snapshots also persist deployment policy independently of login. */
export async function recordRemoteBillingPolicyHint(
  stateDir: string,
  accountUrl: string,
  enforced: boolean,
  checkedAt = Date.now(),
): Promise<void> {
  if (!Number.isFinite(checkedAt) || checkedAt < 0) {
    if (!enforced) throw new Error("A disabled remote billing policy requires a valid clock");
    checkedAt = 0;
  }
  const filePath = policyFilePath(stateDir, accountUrl);
  const hint: PolicyHint = { apiIssuer: accountApiIssuer(accountUrl), enforced, checkedAt };
  await withPolicyWrite(filePath, () =>
    Effect.runPromise(
      writeFileStringAtomically({
        filePath,
        contents: JSON.stringify(hint),
      }),
    ),
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
  const unregister = options.remoteSessions.registerGlobalBillingPolicy({
    authority: apiIssuer,
    enforced,
  });
  let stopped = false;
  let inFlight: Promise<void> | undefined;
  let requestAbort: AbortController | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
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
          hint = next;
          enforceAdmission();
        }
        let saved = false;
        await withPolicyWrite(policyPath, async () => {
          if (
            stopped ||
            (!next.enforced && options.remoteSessions.billingPolicyRevision !== policyRevision)
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
          (!next.enforced && options.remoteSessions.billingPolicyRevision !== policyRevision)
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
    });
    return inFlight;
  };

  const interval = setInterval(
    () => {
      void refresh();
    },
    Math.min(MAX_FALSE_POLICY_AGE_MS, Math.max(100, options.pollIntervalMs ?? 15_000)),
  );
  interval.unref();
  // Only disk restoration precedes startup; the first public read is asynchronous.
  void refresh();
  return {
    refresh,
    async stop() {
      if (options.remoteSessions.remoteBillingEnforced)
        options.remoteSessions.setRemoteBillingEnforced(true);
      stopped = true;
      clearInterval(interval);
      if (expiryTimer) clearTimeout(expiryTimer);
      requestAbort?.abort();
      await inFlight;
      unregister();
    },
  };
}
