import { describe, expect, it } from "vitest";

import {
  encodeNotchIslandSnapshotCommand,
  MAX_NOTCH_ISLAND_ROWS,
  resolveNotchIslandLead,
  sanitizeNotchIslandSnapshot,
} from "./notchIslandSnapshot";

const row = (overrides: Record<string, unknown> = {}) => ({
  threadId: "thread-1",
  title: "Add the notch island",
  project: "synara",
  provider: "codex",
  state: "approval",
  ...overrides,
});

const snapshot = (overrides: Record<string, unknown> = {}) => ({
  needsYou: 1,
  working: 2,
  done: 3,
  failed: 0,
  rows: [row()],
  icons: { codex: "<svg viewBox='0 0 24 24'></svg>" },
  ...overrides,
});

describe("sanitizeNotchIslandSnapshot", () => {
  it("keeps a well-formed snapshot", () => {
    expect(sanitizeNotchIslandSnapshot(snapshot())).toEqual(snapshot());
  });

  it("rejects payloads without valid counts or rows", () => {
    expect(sanitizeNotchIslandSnapshot(null)).toBeNull();
    expect(sanitizeNotchIslandSnapshot(snapshot({ needsYou: -1 }))).toBeNull();
    expect(sanitizeNotchIslandSnapshot(snapshot({ working: 1.5 }))).toBeNull();
    expect(sanitizeNotchIslandSnapshot(snapshot({ rows: "nope" }))).toBeNull();
  });

  it("drops malformed rows and caps the list", () => {
    const rows = [
      row({ state: "sleeping" }),
      row({ title: "   " }),
      row({ threadId: "" }),
      ...Array.from({ length: 6 }, (_, index) => row({ threadId: `t-${index}` })),
    ];
    const result = sanitizeNotchIslandSnapshot(snapshot({ rows }));
    expect(result?.rows.map((entry) => entry.threadId)).toEqual(
      ["t-0", "t-1", "t-2", "t-3"].slice(0, MAX_NOTCH_ISLAND_ROWS),
    );
  });

  it("trims long text, clamps counts and drops unknown provider keys", () => {
    const result = sanitizeNotchIslandSnapshot(
      snapshot({
        done: 5_000,
        rows: [row({ title: `  ${"x".repeat(200)}\n`, project: "", provider: "../evil" })],
      }),
    );
    expect(result?.done).toBe(999);
    expect(result?.rows[0]?.title).toHaveLength(120);
    expect(result?.rows[0]?.title.endsWith("…")).toBe(true);
    expect(result?.rows[0]?.project).toBeNull();
    expect(result?.rows[0]?.provider).toBeNull();
  });

  it("keeps icons only for providers in the rows and only SVG markup", () => {
    const result = sanitizeNotchIslandSnapshot(
      snapshot({
        rows: [row({ provider: "codex" }), row({ threadId: "t-2", provider: "claudeAgent" })],
        icons: {
          codex: "<svg/>",
          claudeAgent: "<script>alert(1)</script>",
          cursor: "<svg/>",
        },
      }),
    );
    expect(result?.icons).toEqual({ codex: "<svg/>" });
    const huge = sanitizeNotchIslandSnapshot(
      snapshot({ icons: { codex: `<svg>${"a".repeat(20_000)}</svg>` } }),
    );
    expect(huge?.icons).toEqual({});
  });
});

const counts = (needsYou: number, working: number, failed: number, done: number) => ({
  needsYou,
  working,
  failed,
  done,
  rows: [],
  icons: {},
});

describe("resolveNotchIslandLead", () => {
  it("shows the most urgent state and its count", () => {
    expect(resolveNotchIslandLead(counts(2, 3, 1, 4))).toEqual({ lead: "needs-you", count: 2 });
    expect(resolveNotchIslandLead(counts(0, 3, 1, 4))).toEqual({ lead: "working", count: 3 });
    expect(resolveNotchIslandLead(counts(0, 0, 1, 4))).toEqual({ lead: "failed", count: 1 });
    expect(resolveNotchIslandLead(counts(0, 0, 0, 4))).toEqual({ lead: "finished", count: 4 });
    expect(resolveNotchIslandLead(counts(0, 0, 0, 0))).toEqual({ lead: "idle", count: 0 });
  });

  it("encodes the lead into the helper line without the icons", () => {
    const line = encodeNotchIslandSnapshotCommand(sanitizeNotchIslandSnapshot(snapshot())!);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed).toMatchObject({ type: "snapshot", lead: "needs-you", count: 1, working: 2 });
    expect(parsed).not.toHaveProperty("icons");
  });
});
