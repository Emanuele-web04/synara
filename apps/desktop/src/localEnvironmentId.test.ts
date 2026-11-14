import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readLocalEnvironmentId, resolveEarlyLocalEnvironmentId } from "./localEnvironmentId";

describe("readLocalEnvironmentId", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "synara-environment-id-"));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("returns the id the backend persisted for this data home", () => {
    writeFileSync(join(stateDir, "environment-id"), "5d15bd41-eb19-47ab-bbe1-c17d6f3db949\n");

    expect(readLocalEnvironmentId(stateDir)).toBe("5d15bd41-eb19-47ab-bbe1-c17d6f3db949");
  });

  it("returns null before the backend has created an id", () => {
    expect(readLocalEnvironmentId(stateDir)).toBeNull();
  });

  it("returns null for an empty file", () => {
    writeFileSync(join(stateDir, "environment-id"), "  \n");

    expect(readLocalEnvironmentId(stateDir)).toBeNull();
  });

  it("returns null when the path cannot be read as a file", () => {
    expect(readLocalEnvironmentId(join(stateDir, "missing", "nested"))).toBeNull();
  });
});

describe("resolveEarlyLocalEnvironmentId", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "synara-environment-id-"));
    writeFileSync(join(stateDir, "environment-id"), "5d15bd41-eb19-47ab-bbe1-c17d6f3db949\n");
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("returns the id when the desktop and its backend share the state directory", () => {
    expect(resolveEarlyLocalEnvironmentId({ stateDir, flavor: "production", env: {} })).toBe(
      "5d15bd41-eb19-47ab-bbe1-c17d6f3db949",
    );
  });

  it("returns null when a development URL moves the backend to another state directory", () => {
    expect(
      resolveEarlyLocalEnvironmentId({
        stateDir,
        flavor: "production",
        env: { VITE_DEV_SERVER_URL: "http://localhost:5733" },
      }),
    ).toBeNull();
  });

  it("returns null for the remote desktop flavor", () => {
    expect(resolveEarlyLocalEnvironmentId({ stateDir, flavor: "remote", env: {} })).toBeNull();
  });
});
