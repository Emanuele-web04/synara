import { MessageId, ThreadId, TurnId, type HubWorkItem } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../types";
import type { TimelineEntry, WorkLogEntry } from "../workLog";
import { buildBotThreadRows, latestWorkStep, replyStreaming } from "./botThread.logic";

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 5, 9, minutes)).toISOString();

const message = (
  id: string,
  role: ChatMessage["role"],
  minutes: number,
  text = id,
  extra: Partial<ChatMessage> = {},
): TimelineEntry => ({
  id,
  kind: "message",
  createdAt: at(minutes),
  message: {
    id: MessageId.makeUnsafe(id),
    role,
    text,
    createdAt: at(minutes),
    streaming: false,
    ...extra,
  },
});

const work = (id: string, minutes: number, extra: Partial<WorkLogEntry>): TimelineEntry => ({
  id,
  kind: "work",
  createdAt: at(minutes),
  entry: { id, createdAt: at(minutes), label: id, tone: "tool", ...extra },
});

const task = (overrides: Partial<HubWorkItem>): HubWorkItem => ({
  id: "w1",
  sourceThreadId: ThreadId.makeUnsafe("bot-thread"),
  sourceMessageId: null,
  title: "Add divide",
  workerThreadId: ThreadId.makeUnsafe("worker-1"),
  state: "working",
  queueReason: null,
  resultSummary: null,
  progress: null,
  revision: 1,
  createdAt: at(2),
  updatedAt: at(2),
  ...overrides,
});

describe("buildBotThreadRows", () => {
  it("opens with a date, groups each side within five minutes and splits after an hour", () => {
    const rows = buildBotThreadRows({
      entries: [
        message("u1", "user", 0),
        message("a1", "assistant", 1),
        message("a2", "assistant", 2),
        message("a3", "assistant", 9),
        message("u2", "user", 75),
      ],
      tasks: [],
    });
    expect(
      rows.map((row) => (row.kind === "message" ? `${row.key}:${row.groupStart}` : row.kind)),
    ).toEqual([
      "separator",
      "msg:u1:true",
      "msg:a1:true",
      "msg:a2:false",
      "msg:a3:true",
      "separator",
      "msg:u2:true",
    ]);
  });

  it("hides SILENT and empty settled replies but keeps a streaming one", () => {
    const rows = buildBotThreadRows({
      entries: [
        message("u1", "user", 0),
        message("silent", "assistant", 1, "SILENT"),
        message("empty", "assistant", 1, ""),
        message("live", "assistant", 2, "", { streaming: true }),
      ],
      tasks: [],
    });
    expect(rows.flatMap((row) => (row.kind === "message" ? [row.message.id] : []))).toEqual([
      "u1",
      "live",
    ]);
  });

  it("turns a delegation message into a From row with the live brief", () => {
    const rows = buildBotThreadRows({
      entries: [message("synbot:delegation:d1", "user", 0, "long prompt")],
      tasks: [],
      briefOf: (id) => (id === "d1" ? "Add tests" : null),
    });
    expect(rows[1]).toMatchObject({ kind: "from", delegationId: "d1", brief: "Add tests" });
  });

  it("keeps SynBot cards, drops resolutions and the target's copy of a delegation", () => {
    const rows = buildBotThreadRows({
      entries: [
        work("card-1", 0, { synbotNotice: { kind: "synbot.card", payload: {} } }),
        work("card-1-done", 1, { synbotNotice: { kind: "synbot.card.resolved", payload: {} } }),
        work("deleg:to", 2, { synbotNotice: { kind: "synbot.delegation", payload: {} } }),
        work("deleg:from", 2, { synbotNotice: { kind: "synbot.delegation", payload: {} } }),
      ],
      tasks: [],
    });
    expect(rows.filter((row) => row.kind === "card").map((row) => row.key)).toEqual([
      "card:card-1",
      "card:deleg:from",
    ]);
  });

  it("folds a task's worker notices into one card at its latest notice", () => {
    const notice = (id: string, minutes: number, threadId: string) =>
      work(id, minutes, {
        synaraWorkerNotice: {
          kind: "settled",
          marker: null,
          phrase: null,
          threads: [
            { threadId, title: "t", outcome: "completed", result: null, pr: null, projectId: null },
          ],
        },
      });
    const rows = buildBotThreadRows({
      entries: [
        message("u1", "user", 0),
        message("a1", "assistant", 1),
        notice("n1", 3, "worker-1"),
        message("a2", "assistant", 4),
        notice("n2", 5, "worker-unknown"),
      ],
      tasks: [task({})],
    });
    expect(rows.map((row) => row.key)).toEqual([
      "sep:msg:u1",
      "msg:u1",
      "msg:a1",
      "task:w1",
      "msg:a2",
      "line:n2",
    ]);
  });

  it("places a task without notices where it was created", () => {
    const rows = buildBotThreadRows({
      entries: [message("u1", "user", 0), message("a1", "assistant", 5)],
      tasks: [task({ createdAt: at(3) })],
    });
    expect(rows.map((row) => row.key)).toEqual(["sep:msg:u1", "msg:u1", "task:w1", "msg:a1"]);
  });
});

describe("latestWorkStep and replyStreaming", () => {
  it("reads the newest tool step of the running turn", () => {
    const turn = TurnId.makeUnsafe("t1");
    const entries = [
      work("w-old", 0, { turnId: TurnId.makeUnsafe("t0"), toolTitle: "Old" }),
      work("w1", 1, { turnId: turn, toolTitle: "Read README.md" }),
      work("w2", 2, { turnId: turn, tone: "thinking", label: "Thinking" }),
    ];
    expect(latestWorkStep(entries, turn)).toBe("Read README.md");
    expect(latestWorkStep(entries, null)).toBeNull();
  });

  it("gives way to a reply once it streams words", () => {
    const rows = buildBotThreadRows({
      entries: [
        message("u1", "user", 0),
        message("a1", "assistant", 1, "Hel", { streaming: true }),
      ],
      tasks: [],
    });
    expect(replyStreaming(rows)).toBe(true);
    expect(
      replyStreaming(buildBotThreadRows({ entries: [message("u1", "user", 0)], tasks: [] })),
    ).toBe(false);
  });
});
