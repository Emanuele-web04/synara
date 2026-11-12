// FILE: accountSignInTiming.ts
// Purpose: One server log line per sign-in with how long each step took, so a
//          report of a slow sign-in says which account request was slow.
// Layer: Server account session (logging only)

import { logAccountSession } from "./accountAuth";

/** The requests a sign-in waits on, in the order they normally run. */
export type SignInStep =
  | "instance"
  /** SSO only: the browser leg, from the authorize URL to the loopback callback. */
  | "browser"
  | "code_exchange"
  | "workspace_probe"
  | "workspace_refresh"
  | "credentials"
  | "device_registration"
  | "host_link"
  | "final_me";

export type SignInOutcome = "signed_in" | "signed_out" | "failed";

export interface SignInTiming {
  /** Runs `run`, recording its duration under `step` whether it resolves or throws. */
  measure<A>(step: SignInStep, run: () => Promise<A>): Promise<A>;
  /**
   * Passes `result` through unchanged and writes the log line once it has
   * settled and every measured step has finished.
   */
  settle<A extends { readonly state: string }>(result: Promise<A>): Promise<A>;
}

/**
 * Durations and step names only: never the code, tokens, email, ids or URLs.
 * `logAccountSession` keeps the line non-secret by contract; this adds nothing
 * but numbers and fixed names to it.
 */
export function createSignInTiming(
  baseDir: string,
  path: "otp" | "sso",
  now: () => number = () => performance.now(),
): SignInTiming {
  const startedAt = now();
  const durations: Partial<Record<SignInStep, number>> = {};
  let running = 0;
  let settled: { outcome: SignInOutcome; returnedMs: number } | undefined;
  let logged = false;

  function logWhenDone(): void {
    if (logged || !settled || running > 0) return;
    logged = true;
    const detail: Record<string, string | number> = {
      path,
      outcome: settled.outcome,
    };
    for (const [step, ms] of Object.entries(durations)) detail[`${step}_ms`] = ms;
    detail.returned_ms = settled.returnedMs;
    logAccountSession(baseDir, "sign_in_timing", detail);
  }

  return {
    async measure(step, run) {
      const stepStartedAt = now();
      running += 1;
      try {
        return await run();
      } finally {
        durations[step] = Math.round(now() - stepStartedAt);
        running -= 1;
        logWhenDone();
      }
    },
    settle(result) {
      const finish = (outcome: SignInOutcome) => {
        settled = { outcome, returnedMs: Math.round(now() - startedAt) };
        logWhenDone();
      };
      return result.then(
        (value) => {
          finish(value.state === "signed-in" ? "signed_in" : "signed_out");
          return value;
        },
        (error: unknown) => {
          finish("failed");
          throw error;
        },
      );
    },
  };
}
