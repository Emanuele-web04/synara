import { describe, expect, it } from "vitest";

import {
  coordinatorCheckinTurnReport,
  isCoordinatorCheckinUserMessage,
  isSilentCoordinatorCheckinReply,
  suppressCoordinatorCheckinMessages,
} from "./coordinatorCheckin";

describe("isSilentCoordinatorCheckinReply", () => {
  it("treats the bare sentinel (any case, trailing punctuation) as silent", () => {
    expect(isSilentCoordinatorCheckinReply("SILENT")).toBe(true);
    expect(isSilentCoordinatorCheckinReply("silent.")).toBe(true);
    expect(isSilentCoordinatorCheckinReply("  Silent!  ")).toBe(true);
    expect(isSilentCoordinatorCheckinReply("SILENT…")).toBe(true);
  });

  it("treats empty text as silent", () => {
    expect(isSilentCoordinatorCheckinReply("")).toBe(true);
    expect(isSilentCoordinatorCheckinReply("   ")).toBe(true);
  });

  it("treats any other reply as a report", () => {
    expect(isSilentCoordinatorCheckinReply("Silent until the build finishes")).toBe(false);
    expect(isSilentCoordinatorCheckinReply("Worker beta needs a look")).toBe(false);
  });
});

describe("isCoordinatorCheckinUserMessage", () => {
  it("matches only automation-dispatched user turns", () => {
    expect(isCoordinatorCheckinUserMessage({ role: "user", dispatchOrigin: "automation" })).toBe(
      true,
    );
    expect(isCoordinatorCheckinUserMessage({ role: "user" })).toBe(false);
    expect(
      isCoordinatorCheckinUserMessage({ role: "assistant", dispatchOrigin: "automation" }),
    ).toBe(false);
  });
});

const user = (id: string, dispatchOrigin?: string, turnId: string | null = null) => ({
  id,
  role: "user",
  text: "[automation] heartbeat",
  ...(dispatchOrigin === undefined ? {} : { dispatchOrigin }),
  turnId,
});

const assistant = (id: string, text: string, turnId: string | null = null) => ({
  id,
  role: "assistant",
  text,
  turnId,
});

describe("suppressCoordinatorCheckinMessages", () => {
  it("drops the automation prompt and a silent reply, keeping the turn ids", () => {
    const messages = [
      { id: "u1", role: "user", text: "Ship it" },
      user("u2", "automation", "turn-check-1"),
      assistant("a2", "SILENT", "turn-check-1"),
    ];
    const { messages: kept, checkinTurnIds } = suppressCoordinatorCheckinMessages(messages);
    expect(kept.map((message) => message.id)).toEqual(["u1"]);
    expect([...checkinTurnIds]).toEqual(["turn-check-1"]);
  });

  it("keeps a non-silent reply while hiding the prompt", () => {
    const messages = [
      user("u1", "automation", "turn-check-1"),
      assistant("a1", "Worker beta failed", "turn-check-1"),
    ];
    const { messages: kept, checkinTurnIds } = suppressCoordinatorCheckinMessages(messages);
    expect(kept.map((message) => message.id)).toEqual(["a1"]);
    expect([...checkinTurnIds]).toEqual(["turn-check-1"]);
  });

  it("leaves ordinary user and assistant turns untouched", () => {
    const messages = [
      { id: "u1", role: "user", text: "Do it" },
      assistant("a1", "Done", "turn-1"),
      { id: "u2", role: "user", text: "And this" },
    ];
    const { messages: kept, checkinTurnIds } = suppressCoordinatorCheckinMessages(messages);
    expect(kept.map((message) => message.id)).toEqual(["u1", "a1", "u2"]);
    expect(checkinTurnIds.size).toBe(0);
  });

  it("an unbound assistant after a check-in counts as its reply", () => {
    const messages = [user("u1", "automation"), assistant("a1", "SILENT")];
    const { messages: kept } = suppressCoordinatorCheckinMessages(messages);
    expect(kept.map((message) => message.id)).toEqual([]);
  });

  it("an assistant bound to another turn does not close the check-in", () => {
    const messages = [
      user("u1", "automation", "turn-check-1"),
      assistant("a1", "Streaming other turn", "turn-other"),
      assistant("a2", "SILENT", "turn-check-1"),
    ];
    const { messages: kept } = suppressCoordinatorCheckinMessages(messages);
    expect(kept.map((message) => message.id)).toEqual(["a1"]);
  });

  it("back-to-back check-ins each suppress only their own prompt", () => {
    const messages = [
      user("u1", "automation", "turn-check-1"),
      assistant("a1", "SILENT", "turn-check-1"),
      user("u2", "automation", "turn-check-2"),
      assistant("a2", "Gamma finished", "turn-check-2"),
      { id: "u3", role: "user", text: "thanks" },
    ];
    const { messages: kept, checkinTurnIds } = suppressCoordinatorCheckinMessages(messages);
    expect(kept.map((message) => message.id)).toEqual(["a2", "u3"]);
    expect(checkinTurnIds.size).toBe(2);
  });
});

describe("coordinatorCheckinTurnReport", () => {
  it("reports silent when the check-in reply is the sentinel", () => {
    const report = coordinatorCheckinTurnReport({
      messages: [user("u1", "automation", "turn-1"), assistant("a1", "SILENT.", "turn-1")],
      turnId: "turn-1",
    });
    expect(report).toEqual({ silent: true, replyText: "SILENT." });
  });

  it("reports the reply text when the check-in has something for the user", () => {
    const report = coordinatorCheckinTurnReport({
      messages: [
        user("u1", "automation", "turn-1"),
        assistant("a1", "Worker beta stalled", "turn-1"),
      ],
      turnId: "turn-1",
    });
    expect(report).toEqual({ silent: false, replyText: "Worker beta stalled" });
  });

  it("returns null for an ordinary turn", () => {
    const report = coordinatorCheckinTurnReport({
      messages: [{ id: "u1", role: "user", text: "hi" }, assistant("a1", "hello", "turn-1")],
      turnId: "turn-1",
    });
    expect(report).toBeNull();
  });

  it("is silent when no reply arrived yet", () => {
    const report = coordinatorCheckinTurnReport({
      messages: [user("u1", "automation", "turn-1")],
      turnId: "turn-1",
    });
    expect(report).toEqual({ silent: true, replyText: null });
  });
});
