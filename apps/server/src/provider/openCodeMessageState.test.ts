import { describe, expect, it } from "vitest";

import {
  forgetOpenCodeMessage,
  forgetOpenCodePart,
  openCodeSnapshotKey,
  type OpenCodeMessageState,
  OpenCodePartIndex,
} from "./openCodeMessageState.ts";

function makeState(): OpenCodeMessageState<{ messageID: string; output: string }> {
  return {
    messageRoleById: new Map(),
    messageSnapshotKeyById: new Map(),
    partById: new OpenCodePartIndex(),
    partSnapshotKeyById: new Map(),
    emittedTextByPartId: new Map(),
    completedAssistantPartIds: new Set(),
    pendingTextDeltasByPartId: new Map(),
  };
}

function remember(state: ReturnType<typeof makeState>, messageId: string, partId: string) {
  state.messageRoleById.set(messageId, "assistant");
  state.messageSnapshotKeyById.set(messageId, messageId);
  state.partById.set(partId, { messageID: messageId, output: "tool output".repeat(1000) });
  state.partSnapshotKeyById.set(partId, "serialized output".repeat(1000));
  state.emittedTextByPartId.set(partId, "streamed text".repeat(1000));
  state.completedAssistantPartIds.add(partId);
  state.pendingTextDeltasByPartId.set(partId, {
    messageId,
    text: "pending",
    bufferedAfterKnownSnapshot: true,
  });
}

describe("OpenCode message memory ownership", () => {
  it("fingerprints complete snapshots without retaining their serialized output", () => {
    const part = { id: "part", messageID: "message", output: "output".repeat(100_000) };
    const key = openCodeSnapshotKey(part);
    expect(key).toHaveLength(64);
    expect(openCodeSnapshotKey(JSON.parse(JSON.stringify(part)))).toBe(key);
    expect(openCodeSnapshotKey({ ...part, output: part.output + "final byte" })).not.toBe(key);
    expect(part.output).toHaveLength(600_000);
    expect(
      new Set(["😀", "\ud83d", "\ufffd"].map((text) => openCodeSnapshotKey({ text }))).size,
    ).toBe(3);
  });
  it("returns retained state to baseline across repeated message removals", () => {
    const state = makeState();
    remember(state, "keep", "keep-part");
    for (let index = 0; index < 100; index += 1) {
      const messageId = `removed-${index}`;
      remember(state, messageId, `tool-${index}`);
      remember(state, messageId, `text-${index}`);
      state.pendingTextDeltasByPartId.set(`unseen-${index}`, {
        messageId,
        text: "delta received before its part snapshot",
        bufferedAfterKnownSnapshot: false,
      });
      forgetOpenCodeMessage(state, messageId);
      for (const entries of Object.values(state)) expect(entries.size).toBe(1);
    }
    expect(state.partById.get("keep-part")?.messageID).toBe("keep");
  });

  it("forgets a removed part without removing its message or sibling parts", () => {
    const state = makeState();
    remember(state, "message", "removed");
    remember(state, "message", "sibling");
    forgetOpenCodePart(state, "removed");
    forgetOpenCodePart(state, "removed");
    for (const entries of Object.values(state)) expect(entries.size).toBe(1);
    expect(state.messageRoleById.has("message")).toBe(true);
    expect(state.partById.has("sibling")).toBe(true);
  });
});

describe("OpenCodePartIndex", () => {
  it("looks parts up by message without scanning the whole session", () => {
    const index = new OpenCodePartIndex<{ messageID: string; output: string }>();
    index.set("a1", { messageID: "a", output: "1" });
    index.set("b1", { messageID: "b", output: "1" });
    index.set("a2", { messageID: "a", output: "2" });

    expect(index.entriesForMessage("a").map(([partId]) => partId)).toEqual(["a1", "a2"]);
    expect(index.partsForMessage("b")).toEqual([{ messageID: "b", output: "1" }]);
    expect(index.partsForMessage("missing")).toEqual([]);

    // Replacing a part keeps a single index entry; moving it re-homes it.
    index.set("a1", { messageID: "a", output: "1 updated" });
    expect(index.partsForMessage("a").map((part) => part.output)).toEqual(["1 updated", "2"]);
    index.set("a2", { messageID: "b", output: "2" });
    expect(index.entriesForMessage("a").map(([partId]) => partId)).toEqual(["a1"]);
    expect(index.entriesForMessage("b").map(([partId]) => partId)).toEqual(["b1", "a2"]);

    expect(index.delete("a1")).toBe(true);
    expect(index.delete("a1")).toBe(false);
    expect(index.partsForMessage("a")).toEqual([]);
    index.clear();
    expect(index.size).toBe(0);
    expect(index.partsForMessage("b")).toEqual([]);
  });

  it("evicts every part of a forgotten message through the index", () => {
    const state = makeState();
    remember(state, "gone", "gone-part-1");
    remember(state, "gone", "gone-part-2");
    remember(state, "kept", "kept-part");
    forgetOpenCodeMessage(state, "gone");
    expect([...state.partById.keys()]).toEqual(["kept-part"]);
    expect(state.partById.partsForMessage("gone")).toEqual([]);
  });
});
