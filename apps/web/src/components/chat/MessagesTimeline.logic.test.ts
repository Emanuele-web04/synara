import { describe, expect, it } from "vitest";
import {
  computeMessageDurationStart,
  deriveTerminalAssistantMessageIds,
  normalizeCompactToolLabel,
  resolveAssistantMessageCopyState,
} from "./MessagesTimeline.logic";

describe("computeMessageDurationStart", () => {
  it("returns message createdAt when there is no preceding user message", () => {
    const result = computeMessageDurationStart([
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:05Z",
        completedAt: "2026-01-01T00:00:10Z",
      },
    ]);
    expect(result).toEqual(new Map([["a1", "2026-01-01T00:00:05Z"]]));
  });

  it("uses the user message createdAt for the first assistant response", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("uses the previous assistant completedAt for subsequent assistant responses", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:00:55Z",
        completedAt: "2026-01-01T00:00:55Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["a2", "2026-01-01T00:00:30Z"],
      ]),
    );
  });

  it("does not advance the boundary for a streaming message without completedAt", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      { id: "a1", role: "assistant", createdAt: "2026-01-01T00:00:30Z" },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:00:55Z",
        completedAt: "2026-01-01T00:00:55Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["a2", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("resets the boundary on a new user message", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
      { id: "u2", role: "user", createdAt: "2026-01-01T00:01:00Z" },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:01:20Z",
        completedAt: "2026-01-01T00:01:20Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["u2", "2026-01-01T00:01:00Z"],
        ["a2", "2026-01-01T00:01:00Z"],
      ]),
    );
  });

  it("handles system messages without affecting the boundary", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      { id: "s1", role: "system", createdAt: "2026-01-01T00:00:01Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["s1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("returns empty map for empty input", () => {
    expect(computeMessageDurationStart([])).toEqual(new Map());
  });
});

describe("normalizeCompactToolLabel", () => {
  it("removes trailing completion wording from command labels", () => {
    expect(normalizeCompactToolLabel("Ran command complete")).toBe("Ran command");
  });

  it("removes trailing completion wording from other labels", () => {
    expect(normalizeCompactToolLabel("Read file completed")).toBe("Read file");
  });
});

describe("deriveTerminalAssistantMessageIds", () => {
  it("keeps only the latest assistant message for a turn", () => {
    expect(
      deriveTerminalAssistantMessageIds([
        { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
        { id: "a1", role: "assistant", createdAt: "2026-01-01T00:00:01Z", turnId: "t1" },
        { id: "a2", role: "assistant", createdAt: "2026-01-01T00:00:02Z", turnId: "t1" },
        { id: "a3", role: "assistant", createdAt: "2026-01-01T00:00:03Z", turnId: "t2" },
      ]),
    ).toEqual(new Set(["a2", "a3"]));
  });

  it("treats assistant messages without turn ids as one response per user boundary", () => {
    expect(
      deriveTerminalAssistantMessageIds([
        { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
        { id: "a1", role: "assistant", createdAt: "2026-01-01T00:00:01Z" },
        { id: "a2", role: "assistant", createdAt: "2026-01-01T00:00:02Z" },
        { id: "u2", role: "user", createdAt: "2026-01-01T00:00:03Z" },
        { id: "a3", role: "assistant", createdAt: "2026-01-01T00:00:04Z" },
      ]),
    ).toEqual(new Set(["a2", "a3"]));
  });
});

describe("resolveAssistantMessageCopyState", () => {
  it("shows copy only for non-empty settled assistant text", () => {
    expect(
      resolveAssistantMessageCopyState({
        text: "Hello",
        showCopyButton: true,
        streaming: false,
      }),
    ).toEqual({ text: "Hello", visible: true });
  });

  it("hides copy while the active assistant response is still streaming", () => {
    expect(
      resolveAssistantMessageCopyState({
        text: "Hello",
        showCopyButton: true,
        streaming: true,
      }),
    ).toEqual({ text: "Hello", visible: false });
  });

  it("hides copy for empty responses", () => {
    expect(
      resolveAssistantMessageCopyState({
        text: "   ",
        showCopyButton: true,
        streaming: false,
      }),
    ).toEqual({ text: null, visible: false });
  });
});
