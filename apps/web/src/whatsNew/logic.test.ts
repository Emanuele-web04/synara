import { describe, expect, it } from "vitest";

import {
  compareVersions,
  parseVersion,
  resolveWhatsNewState,
  sortEntriesByVersionDesc,
  type WhatsNewEntry,
} from "./logic";

const entry = (version: string, overrides?: Partial<WhatsNewEntry>): WhatsNewEntry => ({
  version,
  date: "Jan 1",
  features: [
    {
      id: `feature-${version}`,
      title: `Release ${version}`,
      description: `Notes for ${version}`,
    },
  ],
  ...overrides,
});

describe("parseVersion", () => {
  it("parses a well-formed semver string", () => {
    expect(parseVersion("1.2.3")).toEqual([1, 2, 3]);
  });

  it("fills missing segments with 0", () => {
    expect(parseVersion("1")).toEqual([1, 0, 0]);
    expect(parseVersion("1.2")).toEqual([1, 2, 0]);
  });

  it("treats non-numeric segments as 0", () => {
    expect(parseVersion("abc.def.ghi")).toEqual([0, 0, 0]);
    expect(parseVersion("1.x.3")).toEqual([1, 0, 3]);
  });
});

describe("compareVersions", () => {
  it("orders versions numerically, not lexicographically", () => {
    expect(compareVersions("0.0.9", "0.0.10")).toBeLessThan(0);
    expect(compareVersions("0.0.10", "0.0.9")).toBeGreaterThan(0);
  });

  it("returns zero for equal versions", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  it("ranks major > minor > patch", () => {
    expect(compareVersions("2.0.0", "1.99.99")).toBeGreaterThan(0);
    expect(compareVersions("1.2.0", "1.1.99")).toBeGreaterThan(0);
  });
});

describe("sortEntriesByVersionDesc", () => {
  it("orders entries newest-first without mutating the input", () => {
    const input = [entry("0.0.27"), entry("0.1.0"), entry("0.0.29")];
    const sorted = sortEntriesByVersionDesc(input);

    expect(sorted.map((e) => e.version)).toEqual(["0.1.0", "0.0.29", "0.0.27"]);
    // Input array identity must be preserved — settings uses the same array
    // for the accordion and the dialog derives another sort from it.
    expect(input.map((e) => e.version)).toEqual(["0.0.27", "0.1.0", "0.0.29"]);
  });
});

describe("resolveWhatsNewState", () => {
  const entries: readonly WhatsNewEntry[] = [
    entry("0.0.27"),
    entry("0.0.28"),
    entry("0.0.29"),
    entry("0.1.0"),
  ];

  it("silently bootstraps when lastSeenVersion is null (first launch)", () => {
    const state = resolveWhatsNewState({
      entries,
      currentVersion: "0.0.29",
      lastSeenVersion: null,
    });

    expect(state).toEqual({ kind: "silent-bootstrap", nextLastSeenVersion: "0.0.29" });
  });

  it("returns noop when the user is already up to date", () => {
    const state = resolveWhatsNewState({
      entries,
      currentVersion: "0.0.29",
      lastSeenVersion: "0.0.29",
    });

    expect(state).toEqual({ kind: "noop" });
  });

  it("returns noop on a downgrade so the marker never moves backward", () => {
    const state = resolveWhatsNewState({
      entries,
      currentVersion: "0.0.28",
      lastSeenVersion: "0.0.29",
    });

    expect(state).toEqual({ kind: "noop" });
  });

  it("anchors on the current release entry and surfaces the full sorted history", () => {
    const state = resolveWhatsNewState({
      entries,
      currentVersion: "0.0.29",
      lastSeenVersion: "0.0.27",
    });

    if (state.kind !== "show") {
      throw new Error("expected show state");
    }
    expect(state.currentEntry.version).toBe("0.0.29");
    expect(state.nextLastSeenVersion).toBe("0.0.29");
    // Accordion view shows everything we know about, newest first — including
    // releases that come *after* the installed build so users can see what's
    // coming next if the team chose to preview it.
    expect(state.allEntries.map((e) => e.version)).toEqual(["0.1.0", "0.0.29", "0.0.28", "0.0.27"]);
  });

  it("silent-bootstraps when the user upgraded but there's no curated entry", () => {
    const state = resolveWhatsNewState({
      entries: [entry("0.0.10")],
      currentVersion: "0.0.29",
      lastSeenVersion: "0.0.28",
    });

    expect(state).toEqual({ kind: "silent-bootstrap", nextLastSeenVersion: "0.0.29" });
  });
});
