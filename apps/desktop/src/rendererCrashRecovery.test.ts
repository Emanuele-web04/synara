import { describe, expect, it } from "vitest";

import {
  RENDERER_CRASH_STREAK_WINDOW_MS,
  RENDERER_MAX_AUTOMATIC_RELOADS,
  RendererCrashPolicy,
} from "./rendererCrashRecovery";

const crash = (
  policy: RendererCrashPolicy,
  reason: string,
  nowMs: number,
  quitting = false,
): ReturnType<RendererCrashPolicy["respondToCrash"]> =>
  policy.respondToCrash({ reason, nowMs, quitting });

describe("RendererCrashPolicy", () => {
  it("reloads an OOM kill with a growing backoff", () => {
    const policy = new RendererCrashPolicy();

    expect(crash(policy, "oom", 0)).toEqual({ kind: "reload", delayMs: 500, attempt: 1 });
    expect(crash(policy, "oom", 1_000)).toEqual({
      kind: "reload",
      delayMs: 1_000,
      attempt: 2,
    });
  });

  it("stops reloading after the cap and asks the user instead", () => {
    const policy = new RendererCrashPolicy();

    for (const [index, delayMs] of [500, 1_000, 2_000].entries()) {
      const attempt = index + 1;
      expect(crash(policy, "crashed", attempt * 100)).toEqual({
        kind: "reload",
        delayMs,
        attempt,
      });
    }

    // the reload budget is a cap, not a throttle — further crashes in the same streak must never schedule another reload
    for (let extra = 0; extra < 5; extra += 1) {
      const response = crash(policy, "crashed", 1_000 + extra * 100);
      expect(response).toEqual({
        kind: "prompt",
        cause: "reload-budget-exhausted",
        crashes: 4 + extra,
      });
    }
  });

  it("prompts immediately for reasons that would repeat on reload", () => {
    for (const reason of [
      "abnormal-exit",
      "killed",
      "launch-failed",
      "integrity-failure",
      "unknown-reason",
    ]) {
      expect(crash(new RendererCrashPolicy(), reason, 0)).toEqual({
        kind: "prompt",
        cause: "unrecoverable",
        crashes: 1,
      });
    }
  });

  it("ignores a clean exit and any crash observed while quitting", () => {
    const policy = new RendererCrashPolicy();

    expect(crash(policy, "clean-exit", 0)).toEqual({ kind: "ignore" });
    expect(crash(policy, "killed", 10, true)).toEqual({ kind: "ignore" });
    expect(policy.crashStreak).toBe(0);
  });

  it("starts a fresh streak once crashes stop arriving inside the window", () => {
    const policy = new RendererCrashPolicy();
    for (let attempt = 1; attempt <= RENDERER_MAX_AUTOMATIC_RELOADS; attempt += 1) {
      crash(policy, "oom", attempt * 100);
    }
    expect(crash(policy, "oom", 1_000).kind).toBe("prompt");

    const laterCrash = 1_000 + RENDERER_CRASH_STREAK_WINDOW_MS + 1;
    expect(crash(policy, "oom", laterCrash)).toEqual({
      kind: "reload",
      delayMs: 500,
      attempt: 1,
    });
  });

  it("keeps the streak alive for crashes right at the window boundary", () => {
    const policy = new RendererCrashPolicy();
    crash(policy, "oom", 0);

    expect(crash(policy, "oom", RENDERER_CRASH_STREAK_WINDOW_MS)).toEqual({
      kind: "reload",
      delayMs: 1_000,
      attempt: 2,
    });
  });

  it("gives a user-driven reload a full budget again", () => {
    const policy = new RendererCrashPolicy();
    for (let attempt = 1; attempt <= RENDERER_MAX_AUTOMATIC_RELOADS + 1; attempt += 1) {
      crash(policy, "crashed", attempt * 100);
    }

    policy.reset();

    expect(crash(policy, "crashed", 900)).toEqual({ kind: "reload", delayMs: 500, attempt: 1 });
  });
});
