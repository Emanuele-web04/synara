import type { PinnedMessage } from "@synara/contracts";
import { MessageId, THREAD_NOTES_MAX_CHARS } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  addPinnedMessage,
  clampThreadNotes,
  isMessagePinned,
  normalizePinLabel,
  removePinnedMessage,
  setPinnedMessageDone,
  setPinnedMessageLabel,
  togglePinnedMessage,
  togglePinnedMessageDone,
} from "./pinnedMessages";

const m = (id: string): MessageId => MessageId.makeUnsafe(id);

const pin = (id: string, overrides: Partial<PinnedMessage> = {}): PinnedMessage => ({
  messageId: m(id),
  label: null,
  done: false,
  pinnedAt: "2026-06-06T00:00:00.000Z",
  ...overrides,
});

describe("pinnedMessages", () => {
  it("detects membership in existing pin lists", () => {
    expect(isMessagePinned([pin("a"), pin("b")], m("b"))).toBe(true);
    expect(isMessagePinned([pin("a")], m("z"))).toBe(false);
    expect(isMessagePinned(undefined, m("a"))).toBe(false);
  });

  it("adds, removes, and toggles pins without duplicating entries", () => {
    const pins = [pin("a")];
    const added = addPinnedMessage(pins, pin("b"));
    expect(added.map((entry) => entry.messageId)).toEqual([m("a"), m("b")]);
    expect(addPinnedMessage(added, pin("b"))).toBe(added);
    expect(removePinnedMessage(added, m("a")).map((entry) => entry.messageId)).toEqual([m("b")]);
    expect(togglePinnedMessage(added, pin("b")).map((entry) => entry.messageId)).toEqual([m("a")]);
  });

  it("updates done state with copy-on-write behavior", () => {
    const pins = [pin("a"), pin("b")];
    const setDone = setPinnedMessageDone(pins, m("a"), true);
    expect(setDone[0]?.done).toBe(true);
    expect(setDone[1]).toBe(pins[1]);
    expect(setPinnedMessageDone(setDone, m("a"), true)).toBe(setDone);

    const toggled = togglePinnedMessageDone(setDone, m("a"));
    expect(toggled[0]?.done).toBe(false);
    expect(toggled[1]).toBe(setDone[1]);
  });

  it("normalizes and applies labels", () => {
    expect(normalizePinLabel("  renamed  ")).toBe("renamed");
    expect(normalizePinLabel("   ")).toBeNull();
    expect(normalizePinLabel("x".repeat(80))).toHaveLength(60);

    const pins = [pin("a"), pin("b")];
    const labeled = setPinnedMessageLabel(pins, m("b"), "  renamed  ");
    expect(labeled[0]).toBe(pins[0]);
    expect(labeled[1]?.label).toBe("renamed");
    expect(setPinnedMessageLabel(labeled, m("b"), "renamed")).toBe(labeled);
  });

  it("clamps thread notes to the persisted limit", () => {
    expect(clampThreadNotes("short")).toBe("short");
    expect(clampThreadNotes("x".repeat(THREAD_NOTES_MAX_CHARS + 1))).toHaveLength(
      THREAD_NOTES_MAX_CHARS,
    );
  });
});
