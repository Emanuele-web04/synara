// FILE: updateInstallMarker.test.ts
// Purpose: Verifies durable update install marker persistence and restart outcome resolution.
// Layer: Desktop update tests

import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  clearInstallMarker,
  createUpdateInstallMarker,
  markInstallHandoffSync,
  readInstallMarker,
  resolveInstallMarkerOutcome,
  writeInstallMarker,
  type UpdateInstallMarker,
} from "./updateInstallMarker";

const temporaryDirectories: string[] = [];
const artifact = {
  path: Path.resolve("/tmp/Synara-update.zip"),
  size: 123,
  sha512: "a".repeat(128),
} as const;

function createMarkerPath(): string {
  const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "synara-update-marker-"));
  temporaryDirectories.push(directory);
  return Path.join(directory, "pending-update-install.json");
}

function marker(overrides: Partial<UpdateInstallMarker> = {}): UpdateInstallMarker {
  return {
    schemaVersion: 2,
    attemptId: "attempt-1",
    fromVersion: "1.0.0",
    toVersion: "1.1.0",
    requestedAt: "2026-07-01T00:00:00.000Z",
    handoffAt: null,
    phase: "requested",
    consecutiveFailures: 0,
    lastFailureAt: null,
    artifact,
    ...overrides,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    FS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("updateInstallMarker", () => {
  it("roundtrips a marker and clears it", () => {
    const filePath = createMarkerPath();
    const value = createUpdateInstallMarker({
      fromVersion: "1.0.0",
      toVersion: "1.1.0",
      requestedAt: "2026-07-01T00:00:00.000Z",
      consecutiveFailures: 2,
      lastFailureAt: "2026-06-30T00:00:00.000Z",
      artifact,
    });

    writeInstallMarker(filePath, value);

    expect(readInstallMarker(filePath)).toEqual({ status: "valid", marker: value });
    clearInstallMarker(filePath);
    expect(readInstallMarker(filePath)).toEqual({ status: "missing" });
  });

  it("atomically replaces the marker without leaving temporary files", () => {
    const filePath = createMarkerPath();
    writeInstallMarker(filePath, marker());
    writeInstallMarker(filePath, marker({ attemptId: "attempt-2", consecutiveFailures: 1 }));

    expect(FS.readdirSync(Path.dirname(filePath))).toEqual(["pending-update-install.json"]);
    expect(readInstallMarker(filePath)).toEqual({
      status: "valid",
      marker: marker({ attemptId: "attempt-2", consecutiveFailures: 1 }),
    });
  });

  it("reports malformed JSON as invalid", () => {
    const filePath = createMarkerPath();
    FS.writeFileSync(filePath, "{not-json", "utf8");

    expect(readInstallMarker(filePath)).toMatchObject({ status: "invalid" });
  });

  it("rejects legacy markers that are not bound to an artifact", () => {
    const filePath = createMarkerPath();
    const { artifact: _artifact, ...legacyMarker } = marker();
    FS.writeFileSync(filePath, JSON.stringify({ ...legacyMarker, schemaVersion: 1 }), "utf8");

    expect(readInstallMarker(filePath)).toEqual({
      status: "invalid",
      error: "Marker does not match schema version 2.",
    });
  });

  it("resolves values outside the marker schema as invalid", () => {
    expect(resolveInstallMarkerOutcome({}, "1.0.0", "2026-07-02T00:00:00.000Z")).toBe("invalid");
  });

  it("resolves successful installs at or beyond the target version", () => {
    const value = marker();

    expect(resolveInstallMarkerOutcome(value, "1.1.0", "2026-07-02T00:00:00.000Z")).toBe("success");
    expect(resolveInstallMarkerOutcome(value, "1.2.0", "2026-07-02T00:00:00.000Z")).toBe("success");
  });

  it("resolves an old current version as a new failure", () => {
    expect(resolveInstallMarkerOutcome(marker(), "1.0.0", "2026-07-02T00:00:00.000Z")).toBe(
      "failure",
    );
  });

  it("does not count an already-recorded failure twice", () => {
    const value = marker({
      phase: "failed",
      consecutiveFailures: 2,
      lastFailureAt: "2026-07-02T00:00:00.000Z",
    });

    expect(resolveInstallMarkerOutcome(value, "1.0.0", "2026-07-03T00:00:00.000Z")).toBe(
      "already-failed",
    );
    expect(value.consecutiveFailures).toBe(2);
  });

  it("quarantines attempts older than seven days", () => {
    expect(resolveInstallMarkerOutcome(marker(), "1.0.0", "2026-07-08T00:00:00.001Z")).toBe(
      "stale",
    );
  });

  it("synchronously records the updater handoff", () => {
    const filePath = createMarkerPath();
    writeInstallMarker(filePath, marker());

    expect(
      markInstallHandoffSync(
        filePath,
        { attemptId: "attempt-1", artifact },
        "2026-07-01T00:00:05.000Z",
      ),
    ).toMatchObject({ phase: "handoff", handoffAt: "2026-07-01T00:00:05.000Z" });
    expect(readInstallMarker(filePath)).toEqual({
      status: "valid",
      marker: marker({ phase: "handoff", handoffAt: "2026-07-01T00:00:05.000Z" }),
    });
  });

  it("rejects handoff when the attempt or artifact identity changed", () => {
    const filePath = createMarkerPath();
    writeInstallMarker(filePath, marker());

    expect(markInstallHandoffSync(filePath, { attemptId: "attempt-2", artifact })).toBeNull();
    expect(
      markInstallHandoffSync(filePath, {
        attemptId: "attempt-1",
        artifact: { ...artifact, sha512: "b".repeat(128) },
      }),
    ).toBeNull();
    expect(readInstallMarker(filePath)).toEqual({ status: "valid", marker: marker() });
  });
});
