import { MessageId, ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import type { AppState } from "../storeState";
import type { ChatMessage } from "../types";
import { latestBotPreview, listTime } from "./botPreview.logic";

const thread = ThreadId.makeUnsafe("bot-thread");

function stateWith(messages: readonly Partial<ChatMessage>[]): AppState {
  const byId: Record<string, ChatMessage> = {};
  const ids = messages.map((partial, index) => {
    const id = MessageId.makeUnsafe(partial.id ?? `m${index}`);
    byId[id] = {
      id,
      role: "assistant",
      text: "",
      createdAt: `2026-11-05T09:0${index}:00.000Z`,
      streaming: false,
      ...partial,
    } as ChatMessage;
    return id;
  });
  return {
    messageIdsByThreadId: { [thread]: ids },
    messageByThreadId: { [thread]: byId },
  } as unknown as AppState;
}

describe("latestBotPreview", () => {
  it("takes the newest message worth showing, on one line", () => {
    const state = stateWith([
      { text: "Earlier" },
      { role: "user", text: "Add  multiply\nplease" },
      { text: "SILENT" },
      { id: MessageId.makeUnsafe("synbot:report:r1"), role: "user", text: "Report" },
      { role: "user", text: "check in", dispatchOrigin: "automation" },
    ]);
    expect(latestBotPreview(state, thread)).toEqual({
      text: "Add multiply please",
      at: "2026-11-05T09:01:00.000Z",
    });
  });

  it("shows a reply's markdown as plain text", () => {
    const state = stateWith([{ text: "`test/calc.test.js` has **3 tests** on `synara/x`" }]);
    expect(latestBotPreview(state, thread)?.text).toBe("test/calc.test.js has 3 tests on synara/x");
  });

  it("is null when the thread is not loaded", () => {
    expect(latestBotPreview({} as AppState, thread)).toBeNull();
  });
});

describe("listTime", () => {
  const now = new Date(2026, 10, 5, 18, 0).getTime();
  it("shows the time today, the weekday this week, else the date", () => {
    expect(listTime(new Date(2026, 10, 5, 9, 5).toISOString(), now, "en-US", false)).toBe("09:05");
    expect(listTime(new Date(2026, 10, 2, 9, 5).toISOString(), now, "en-US", false)).toBe("Mon");
    expect(listTime(new Date(2026, 9, 26, 9, 5).toISOString(), now, "en-US", false)).toBe("Oct 26");
  });
});
