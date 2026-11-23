import {
  ProjectId,
  ThreadId,
  type Bot,
  type BotDelegation,
  type HubWorkItem,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  botHasOpenWork,
  botsNewlyWaiting,
  botWaitReason,
  isBotOnScreen,
  synbotPageForThread,
  synbotPageSearch,
} from "./synbotNotifications.logic";
import { EMPTY_SYNBOT_DATA, type SynbotData } from "./synbotState.logic";

const main = {
  id: ProjectId.makeUnsafe("bot-main"),
  kind: "main",
  name: "SynBot",
  threadId: ThreadId.makeUnsafe("thread-main"),
  status: "idle",
} as Bot;
const qa = {
  id: ProjectId.makeUnsafe("bot-qa"),
  kind: "bot",
  name: "QA",
  threadId: ThreadId.makeUnsafe("thread-qa"),
  status: "idle",
} as Bot;

const delegation = (overrides: Partial<BotDelegation>): BotDelegation =>
  ({
    id: "d1",
    fromBotId: main.id,
    fromThreadId: main.threadId,
    toBotId: qa.id,
    toThreadId: qa.threadId,
    brief: "Review the change",
    state: "sent",
    settledAt: null,
    ...overrides,
  }) as BotDelegation;

const task = (state: HubWorkItem["state"], overrides: Partial<HubWorkItem> = {}) => ({
  botId: qa.id,
  task: {
    id: "w1",
    title: "Test multiply",
    state,
    workerThreadId: ThreadId.makeUnsafe("thread-worker"),
    ...overrides,
  } as HubWorkItem,
});

const data = (overrides: Partial<SynbotData>): SynbotData => ({
  ...EMPTY_SYNBOT_DATA,
  bots: [main, qa],
  ...overrides,
});

describe("where a bot's notification opens", () => {
  it("opens SynBot without ?bot, any other bot with it, a task's thread in the task pane", () => {
    expect(synbotPageSearch(main)).toEqual({});
    expect(synbotPageSearch(qa)).toEqual({ bot: qa.id });
    const world = data({ tasks: [task("waiting")] });
    expect(synbotPageForThread(world, "thread-main")).toEqual({});
    expect(synbotPageForThread(world, "thread-qa")).toEqual({ bot: qa.id });
    expect(synbotPageForThread(world, "thread-worker")).toEqual({
      bot: qa.id,
      task: "thread-worker",
    });
    expect(synbotPageForThread(world, "thread-user")).toBeNull();
  });

  it("knows whether the bot's chat is on screen", () => {
    expect(isBotOnScreen(main, "")).toBe(true);
    expect(isBotOnScreen(qa, "")).toBe(false);
    expect(isBotOnScreen(qa, qa.id)).toBe(true);
    expect(isBotOnScreen(qa, null)).toBe(false);
  });
});

describe("botHasOpenWork", () => {
  it("holds a bot's turn while a hand-off it sent is open, then lets its recap through", () => {
    expect(botHasOpenWork(data({ delegations: [delegation({})] }), main)).toBe(true);
    // The receiving bot is not held by work handed to it.
    expect(botHasOpenWork(data({ delegations: [delegation({})] }), qa)).toBe(false);
    const settled = delegation({ state: "completed", settledAt: "2026-11-05T10:00:00.000Z" });
    expect(botHasOpenWork(data({ delegations: [settled] }), main)).toBe(false);
  });

  it("holds a bot's turn while one of its tasks is unfinished", () => {
    expect(botHasOpenWork(data({ tasks: [task("queued")] }), qa)).toBe(true);
    expect(botHasOpenWork(data({ tasks: [task("waiting")] }), qa)).toBe(true);
    expect(botHasOpenWork(data({ tasks: [task("completed")] }), qa)).toBe(false);
    expect(botHasOpenWork(data({ tasks: [task("working")] }), main)).toBe(false);
  });
});

describe("botsNewlyWaiting", () => {
  it("lists bots that moved into waiting, not those already waiting or new to the window", () => {
    const previous = new Map<string, Bot["status"]>([
      [main.id, "working"],
      [qa.id, "waiting"],
    ]);
    const now = [{ ...main, status: "waiting" } as Bot, { ...qa, status: "waiting" } as Bot];
    expect(botsNewlyWaiting(previous, now).map((bot) => bot.name)).toEqual(["SynBot"]);
    expect(botsNewlyWaiting(new Map(), now)).toEqual([]);
  });
});

describe("botWaitReason", () => {
  it("names a Start first, then an approval, a question, a waiting task", () => {
    const waitingStart = delegation({ state: "awaiting-start" });
    expect(botWaitReason(data({ delegations: [waitingStart] }), qa, undefined)).toEqual({
      kind: "start",
      brief: "Review the change",
    });
    expect(botWaitReason(data({}), qa, { hasPendingApprovals: true })).toEqual({
      kind: "approval",
    });
    expect(botWaitReason(data({}), qa, { hasPendingUserInput: true })).toEqual({
      kind: "question",
    });
    expect(botWaitReason(data({ tasks: [task("waiting")] }), qa, undefined)).toEqual({
      kind: "task",
      title: "Test multiply",
      threadId: "thread-worker",
    });
    expect(botWaitReason(data({}), qa, undefined)).toEqual({ kind: "unknown" });
  });
});
