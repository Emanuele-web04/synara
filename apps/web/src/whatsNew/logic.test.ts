import { describe, expect, it } from "vitest";

import { resolveWhatsNewState, sortEntriesByVersionDesc, type WhatsNewEntry } from "./logic";

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

describe("sortEntriesByVersionDesc", () => {
  it("orders entries newest-first without mutating the input", () => {
    const versions = [
      "1.2",
      "0.0.9",
      "1.x.3",
      "2.0.0",
      "1",
      "1.99.99",
      "1.2.0",
      "abc.def.ghi",
      "0.0.10",
      "1.1.99",
    ];
    const input = versions.map((version) => entry(version));
    const sorted = sortEntriesByVersionDesc(input);

    expect(sorted.map((e) => e.version)).toEqual([
      "2.0.0",
      "1.99.99",
      "1.2",
      "1.2.0",
      "1.1.99",
      "1.x.3",
      "1",
      "0.0.10",
      "0.0.9",
      "abc.def.ghi",
    ]);
    // Input array identity must be preserved — settings uses the same array
    // for the accordion and the dialog derives another sort from it.
    expect(input.map((e) => e.version)).toEqual(versions);
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
