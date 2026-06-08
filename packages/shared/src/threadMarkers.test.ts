import type { ThreadMarker } from "@t3tools/contracts";
import { MessageId, ThreadMarkerId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  addThreadMarker,
  isThreadMarkerAvailable,
  normalizeThreadMarkerLabel,
  removeThreadMarker,
  setThreadMarkerDone,
  setThreadMarkerLabel,
} from "./threadMarkers";

const markerId = (id: string): ThreadMarkerId => ThreadMarkerId.makeUnsafe(id);
const messageId = (id: string): MessageId => MessageId.makeUnsafe(id);

const marker = (id: string, overrides: Partial<ThreadMarker> = {}): ThreadMarker => ({
  id: markerId(id),
  messageId: messageId("assistant-1"),
  startOffset: 6,
  endOffset: 20,
  selectedText: "important text",
  style: "highlight",
  color: "yellow",
  label: null,
  done: false,
  createdAt: "2026-06-06T00:00:00.000Z",
  updatedAt: "2026-06-06T00:00:00.000Z",
  ...overrides,
});

describe("threadMarkers", () => {
  it("adds and removes markers without duplicating ids or exact ranges", () => {
    const markers = [marker("a")];
    const added = addThreadMarker(markers, marker("b", { startOffset: 24, endOffset: 31 }));

    expect(added.map((entry) => entry.id)).toEqual([markerId("a"), markerId("b")]);
    expect(addThreadMarker(added, marker("b", { startOffset: 24, endOffset: 31 }))).toBe(added);
    expect(addThreadMarker(added, marker("c"))).toBe(added);
    expect(removeThreadMarker(added, markerId("a")).map((entry) => entry.id)).toEqual([
      markerId("b"),
    ]);
  });

  it("updates done state and labels with copy-on-write behavior", () => {
    const markers = [marker("a"), marker("b", { startOffset: 24, endOffset: 31 })];
    const setDone = setThreadMarkerDone(markers, markerId("a"), true, "2026-06-06T00:01:00.000Z");

    expect(setDone[0]?.done).toBe(true);
    expect(setDone[0]?.updatedAt).toBe("2026-06-06T00:01:00.000Z");
    expect(setDone[1]).toBe(markers[1]);
    expect(setThreadMarkerDone(setDone, markerId("a"), true, "2026-06-06T00:02:00.000Z")).toBe(
      setDone,
    );

    const labeled = setThreadMarkerLabel(
      setDone,
      markerId("b"),
      "  follow up  ",
      "2026-06-06T00:03:00.000Z",
    );
    expect(labeled[1]?.label).toBe("follow up");
    expect(labeled[1]?.updatedAt).toBe("2026-06-06T00:03:00.000Z");
  });

  it("normalizes labels and validates exact text ranges", () => {
    expect(normalizeThreadMarkerLabel("  renamed  ")).toBe("renamed");
    expect(normalizeThreadMarkerLabel("   ")).toBeNull();
    expect(normalizeThreadMarkerLabel("x".repeat(80))).toHaveLength(60);

    const entry = marker("a");
    expect(isThreadMarkerAvailable(entry, "hello important text today")).toBe(true);
    expect(isThreadMarkerAvailable(entry, "hello important words today")).toBe(false);
    expect(isThreadMarkerAvailable(entry, "short")).toBe(false);
  });
});
