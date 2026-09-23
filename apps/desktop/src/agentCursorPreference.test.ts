// FILE: agentCursorPreference.test.ts
// Purpose: Guards the agent cursor preference store: normalization at the
//          renderer boundary, versioned round-trip, and the stock default
//          leaving no overrides on disk.

import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  normalizeAgentCursorStylePreference,
  parseAgentCursorPreference,
  readAgentCursorPreference,
  writeAgentCursorPreference,
} from "./agentCursorPreference";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    FS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("normalizeAgentCursorStylePreference", () => {
  it("keeps usable channels, lowercased, and drops everything else", () => {
    expect(
      normalizeAgentCursorStylePreference({ fill: " #AABBCC ", rim: "#0f0f0f", shadow: "red" }),
    ).toEqual({ fill: "#aabbcc", rim: "#0f0f0f" });
    expect(normalizeAgentCursorStylePreference({ fill: "#12345" })).toBeNull();
    expect(normalizeAgentCursorStylePreference({ fill: 12 })).toBeNull();
    expect(normalizeAgentCursorStylePreference({})).toBeNull();
    expect(normalizeAgentCursorStylePreference(null)).toBeNull();
    expect(normalizeAgentCursorStylePreference("not-a-style")).toBeNull();
    expect(normalizeAgentCursorStylePreference(["#aabbcc"])).toBeNull();
  });
});

describe("parseAgentCursorPreference", () => {
  it("accepts only the versioned shape and normalizes the style through it", () => {
    expect(parseAgentCursorPreference({ version: 1, style: { fill: "#AABBCC" } })).toEqual({
      version: 1,
      style: { fill: "#aabbcc" },
    });
    // A stored payload whose channels all became unusable reads as stock,
    // because the version is valid even though the style normalizes to null.
    expect(parseAgentCursorPreference({ version: 1, style: { fill: "bad" } })).toEqual({
      version: 1,
      style: null,
    });
    expect(parseAgentCursorPreference({ version: 2, style: { fill: "#aabbcc" } })).toBeNull();
    expect(parseAgentCursorPreference({ style: { fill: "#aabbcc" } })).toBeNull();
    expect(parseAgentCursorPreference(null)).toBeNull();
  });
});

describe("agent cursor preference filesystem", () => {
  it("round-trips custom colors and restores stock by deleting the file", () => {
    const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "synara-agent-cursor-"));
    temporaryDirectories.push(directory);
    const filePath = Path.join(directory, "nested", "agent-cursor-colors.json");

    expect(readAgentCursorPreference(filePath)).toBeNull();

    writeAgentCursorPreference(filePath, { fill: "#AABBCC", rim: "#112233" });
    expect(readAgentCursorPreference(filePath)).toEqual({ fill: "#aabbcc", rim: "#112233" });
    expect(JSON.parse(FS.readFileSync(filePath, "utf8"))).toEqual({
      version: 1,
      style: { fill: "#aabbcc", rim: "#112233" },
    });

    // Stock removes the override rather than storing an empty one.
    writeAgentCursorPreference(filePath, null);
    expect(FS.existsSync(filePath)).toBe(false);
    expect(readAgentCursorPreference(filePath)).toBeNull();
  });

  it("reads stock from malformed or arbitrary JSON", () => {
    const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "synara-agent-cursor-"));
    temporaryDirectories.push(directory);
    const filePath = Path.join(directory, "agent-cursor-colors.json");

    FS.writeFileSync(filePath, "{ not json", "utf8");
    expect(readAgentCursorPreference(filePath)).toBeNull();

    FS.writeFileSync(filePath, JSON.stringify({ version: 1, style: { rim: "purple" } }), "utf8");
    expect(readAgentCursorPreference(filePath)).toBeNull();
  });
});
