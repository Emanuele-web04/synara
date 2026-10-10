import { describe, expect, it } from "vitest";

import {
  BACKEND_MAX_CONSECUTIVE_START_FAILURES,
  BACKEND_RESTART_MAX_DELAY_MS,
  BackendOutputTailDetector,
  BackendSupervisionPolicy,
  backendRestartDelayMs,
  summarizeBackendFailureOutput,
} from "./backendSupervisionPolicy";

const failure = (
  policy: BackendSupervisionPolicy,
  overrides?: { readonly migrationRecoveryMarkerPresent?: boolean; readonly quitting?: boolean },
) =>
  policy.respondToStartFailure({
    quitting: overrides?.quitting ?? false,
    restartPending: false,
    migrationRecoveryMarkerPresent: overrides?.migrationRecoveryMarkerPresent ?? false,
  });

describe("backendRestartDelayMs", () => {
  it("doubles per attempt and saturates at the ceiling", () => {
    expect(backendRestartDelayMs(1)).toBe(500);
    expect(backendRestartDelayMs(2)).toBe(1_000);
    expect(backendRestartDelayMs(3)).toBe(2_000);
    expect(backendRestartDelayMs(30)).toBe(BACKEND_RESTART_MAX_DELAY_MS);
  });
});

describe("BackendSupervisionPolicy backoff", () => {
  it("grows the delay across consecutive failures instead of staying flat", () => {
    const policy = new BackendSupervisionPolicy();

    const delays: number[] = [];
    for (let index = 0; index < BACKEND_MAX_CONSECUTIVE_START_FAILURES - 1; index += 1) {
      const response = failure(policy);
      expect(response.kind).toBe("retry");
      if (response.kind === "retry") {
        delays.push(response.delayMs);
      }
    }

    expect(delays).toEqual([500, 1_000, 2_000, 4_000]);
  });

  it("restarts the backoff only after the backend reaches readiness", () => {
    const policy = new BackendSupervisionPolicy();

    expect(failure(policy)).toMatchObject({ kind: "retry", delayMs: 500 });
    expect(failure(policy)).toMatchObject({ kind: "retry", delayMs: 1_000 });

    policy.recordReadiness();

    expect(policy.consecutiveFailures).toBe(0);
    expect(failure(policy)).toMatchObject({ kind: "retry", delayMs: 500 });
  });

  it("does nothing while quitting or while a restart is already armed", () => {
    const policy = new BackendSupervisionPolicy();

    expect(failure(policy, { quitting: true })).toEqual({ kind: "ignore" });
    expect(
      policy.respondToStartFailure({
        quitting: false,
        restartPending: true,
        migrationRecoveryMarkerPresent: false,
      }),
    ).toEqual({ kind: "ignore" });
    expect(policy.consecutiveFailures).toBe(0);
  });
});

describe("BackendSupervisionPolicy circuit breaker", () => {
  it("stops respawning after the configured consecutive failures", () => {
    const policy = new BackendSupervisionPolicy();

    for (let index = 0; index < BACKEND_MAX_CONSECUTIVE_START_FAILURES - 1; index += 1) {
      expect(failure(policy).kind).toBe("retry");
    }

    expect(failure(policy)).toEqual({
      kind: "give-up",
      failures: BACKEND_MAX_CONSECUTIVE_START_FAILURES,
    });
    expect(policy.hasGivenUp).toBe(true);
  });

  it("keeps giving up — and stops counting — once tripped", () => {
    const policy = new BackendSupervisionPolicy();

    for (let index = 0; index < BACKEND_MAX_CONSECUTIVE_START_FAILURES; index += 1) {
      failure(policy);
    }

    expect(failure(policy)).toEqual({
      kind: "give-up",
      failures: BACKEND_MAX_CONSECUTIVE_START_FAILURES,
    });
    expect(failure(policy)).toEqual({
      kind: "give-up",
      failures: BACKEND_MAX_CONSECUTIVE_START_FAILURES,
    });
    expect(policy.consecutiveFailures).toBe(BACKEND_MAX_CONSECUTIVE_START_FAILURES);
  });

  it("re-arms for a legitimate restart", () => {
    const policy = new BackendSupervisionPolicy();

    for (let index = 0; index < BACKEND_MAX_CONSECUTIVE_START_FAILURES; index += 1) {
      failure(policy);
    }
    expect(policy.hasGivenUp).toBe(true);

    policy.reset();

    expect(policy.hasGivenUp).toBe(false);
    expect(failure(policy)).toMatchObject({ kind: "retry", delayMs: 500 });
  });

  it("re-arms when the backend becomes ready after a trip", () => {
    const policy = new BackendSupervisionPolicy();

    for (let index = 0; index < BACKEND_MAX_CONSECUTIVE_START_FAILURES; index += 1) {
      failure(policy);
    }

    policy.recordReadiness();

    expect(policy.hasGivenUp).toBe(false);
    expect(policy.consecutiveFailures).toBe(0);
  });
});

describe("BackendSupervisionPolicy mid-session migration recovery", () => {
  it("hands a crash to recovery when the marker appears mid-session", () => {
    const policy = new BackendSupervisionPolicy();

    expect(failure(policy)).toMatchObject({ kind: "retry" });
    expect(failure(policy, { migrationRecoveryMarkerPresent: true })).toEqual({
      kind: "recover-migration",
    });
  });

  it("prompts once per app run and falls back to supervised restarts afterwards", () => {
    const policy = new BackendSupervisionPolicy();

    expect(failure(policy, { migrationRecoveryMarkerPresent: true })).toEqual({
      kind: "recover-migration",
    });
    expect(policy.hasPromptedMigrationRecovery).toBe(true);
    // The marker is still on disk, but the prompt must not be shown again.
    expect(failure(policy, { migrationRecoveryMarkerPresent: true })).toMatchObject({
      kind: "retry",
      delayMs: 500,
    });
  });

  it("does not consume a restart attempt when recovery takes over", () => {
    const policy = new BackendSupervisionPolicy();

    failure(policy, { migrationRecoveryMarkerPresent: true });

    expect(policy.consecutiveFailures).toBe(0);
  });

  it("keeps the once-per-run latch across legitimate restarts", () => {
    const policy = new BackendSupervisionPolicy();

    failure(policy, { migrationRecoveryMarkerPresent: true });
    policy.reset();
    policy.recordReadiness();

    expect(failure(policy, { migrationRecoveryMarkerPresent: true })).toMatchObject({
      kind: "retry",
    });
  });
});

describe("BackendOutputTailDetector", () => {
  it("keeps the tail of the output across chunks", () => {
    const detector = new BackendOutputTailDetector();

    detector.push(Buffer.from("first line\r\n", "utf8"));
    detector.push("MigrationRecoveryRequiredError: backup verification failed\n");

    expect(detector.read()).toBe(
      "first line\nMigrationRecoveryRequiredError: backup verification failed\n",
    );
  });

  it("bounds retained output so a crash loop cannot grow it", () => {
    const detector = new BackendOutputTailDetector();

    for (let index = 0; index < 50; index += 1) {
      detector.push("x".repeat(1_000));
    }

    expect(detector.read().length).toBeLessThanOrEqual(8_192);
  });
});

describe("summarizeBackendFailureOutput", () => {
  it("quotes the last reported error and what followed it", () => {
    const summary = summarizeBackendFailureOutput(
      [
        "starting server",
        "running migrations",
        "MigrationRecoveryRequiredError: migration 0007 aborted",
        "    at applyMigration (index.mjs:1:1)",
        "",
      ].join("\n"),
    );

    expect(summary).toBe(
      "MigrationRecoveryRequiredError: migration 0007 aborted\n    at applyMigration (index.mjs:1:1)",
    );
  });

  it("falls back to the final lines when nothing looks like an error", () => {
    expect(summarizeBackendFailureOutput("one\ntwo\nthree\n", 2)).toBe("two\nthree");
  });

  it("returns an empty string for empty output", () => {
    expect(summarizeBackendFailureOutput("   \n\n")).toBe("");
  });
});
