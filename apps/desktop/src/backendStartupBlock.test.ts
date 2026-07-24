import { describe, expect, it } from "vitest";

import { BackendStartupBlockDetector } from "./backendStartupBlock";

describe("BackendStartupBlockDetector", () => {
  it("recognizes a live database owner across output chunks", () => {
    const detector = new BackendStartupBlockDetector();

    detector.push("[13:46:08.637] ERROR: DatabaseLifecycle");
    detector.push(
      "LockedError: Database lifecycle is locked: owner pid 21610 is live (state.sqlite.lifecycle-lock)\n",
    );

    expect(detector.read()).toEqual({ kind: "database-locked", ownerPid: 21610 });
  });

  it("still classifies a database lock when owner metadata is unavailable", () => {
    const detector = new BackendStartupBlockDetector();

    detector.push("DatabaseLifecycleLockedError: refusing concurrent database access\n");

    expect(detector.read()).toEqual({ kind: "database-locked", ownerPid: null });
  });

  it("recognizes migration recovery as a relaunch-only startup block", () => {
    const detector = new BackendStartupBlockDetector();

    detector.push("MigrationRecoveryRequiredError: Migration recovery is required");

    expect(detector.read()).toEqual({ kind: "migration-recovery-required" });
  });

  it("ignores unrelated startup failures", () => {
    const detector = new BackendStartupBlockDetector();

    detector.push("Error: address already in use");

    expect(detector.read()).toBeNull();
  });
});
