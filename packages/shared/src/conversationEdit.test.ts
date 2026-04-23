import { describe, expect, it } from "vitest";

import {
  collectTailTurnIds,
  resolveLatestTailUserMessageEditTarget,
  resolveTailUserMessageEditTarget,
} from "./conversationEdit";

describe("conversationEdit", () => {
  it("collects unique turn ids from a target message through the tail", () => {
    expect(
      collectTailTurnIds({
        messages: [
          { id: "m1", turnId: "turn-1" },
          { id: "m2", turnId: null },
          { id: "m3", turnId: "turn-2" },
          { id: "m4", turnId: "turn-2" },
        ],
        messageId: "m2",
      }),
    ).toEqual(["turn-2"]);
  });

  it("allows editing the native user message for the latest concrete turn", () => {
    expect(
      resolveLatestTailUserMessageEditTarget({
        messages: [
          { id: "user-1", role: "user", source: "native", turnId: null },
          { id: "assistant-1", role: "assistant", source: "native", turnId: "turn-1" },
        ],
      }),
    ).toEqual({
      editable: true,
      messageId: "user-1",
      messageIndex: 0,
      mode: "rollback",
      rollbackTurnCount: 1,
      removedTurnIds: ["turn-1"],
    });
  });

  it("allows editing the active tail prompt before assistant output exists", () => {
    expect(
      resolveTailUserMessageEditTarget({
        messages: [{ id: "user-active", role: "user", source: "native", turnId: null }],
        messageId: "user-active",
        activeTurnId: "turn-active",
      }),
    ).toMatchObject({
      editable: true,
      mode: "active-tail",
      rollbackTurnCount: 0,
      removedTurnIds: [],
    });
  });

  it("rejects older native user messages", () => {
    expect(
      resolveTailUserMessageEditTarget({
        messages: [
          { id: "user-1", role: "user", source: "native", turnId: null },
          { id: "assistant-1", role: "assistant", source: "native", turnId: "turn-1" },
          { id: "user-2", role: "user", source: "native", turnId: null },
          { id: "assistant-2", role: "assistant", source: "native", turnId: "turn-2" },
        ],
        messageId: "user-1",
      }),
    ).toEqual({ editable: false, reason: "not-latest-native-user-message" });
  });

  it("rejects old tail messages that do not have turn metadata", () => {
    expect(
      resolveTailUserMessageEditTarget({
        messages: [
          { id: "user-old", role: "user", source: "native", turnId: null },
          { id: "assistant-old", role: "assistant", source: "native", turnId: null },
        ],
        messageId: "user-old",
      }),
    ).toEqual({ editable: false, reason: "missing-turn-metadata" });
  });
});
