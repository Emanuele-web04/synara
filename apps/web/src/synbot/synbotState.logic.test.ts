import {
  DEFAULT_BOT_SETTINGS,
  ProjectId,
  ThreadId,
  type Bot,
  type BotDelegation,
  type HubWorkItem,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  EMPTY_SYNBOT_DATA,
  altoGrantRetry,
  applyBotStreamEvent,
  botByThreadId,
  delegationsTouchingThread,
  orderedBots,
  selectedBot,
  synbotHasStoppableWork,
  synbotNeedsYouCount,
  tasksForBot,
} from "./synbotState.logic";

const bot = (overrides: Partial<Bot>): Bot => ({
  id: ProjectId.makeUnsafe("bot-a"),
  kind: "bot",
  name: "Frontend",
  role: "UI",
  mascot: { shape: "clover", color: "#2fb36b" },
  instructions: "",
  scope: { projects: "all", paths: [] },
  modelSelection: { provider: "codex", model: "gpt-6-luna" } as Bot["modelSelection"],
  autonomy: "auto",
  pinnedSkills: [],
  pinned: false,
  threadId: ThreadId.makeUnsafe("thread-a"),
  status: "idle",
  revision: 1,
  createdAt: "2026-11-05T00:00:00.000Z",
  updatedAt: "2026-11-05T00:00:00.000Z",
  ...overrides,
});

const task = (overrides: Partial<HubWorkItem>): HubWorkItem => ({
  id: "w1",
  sourceThreadId: ThreadId.makeUnsafe("thread-a"),
  sourceMessageId: null,
  title: "Fix the button",
  workerThreadId: null,
  state: "working",
  queueReason: null,
  resultSummary: null,
  progress: null,
  revision: 1,
  createdAt: "2026-11-05T00:00:00.000Z",
  updatedAt: "2026-11-05T00:00:00.000Z",
  ...overrides,
});

describe("applyBotStreamEvent", () => {
  it("replaces state on snapshot and upserts bots, settings and delegations", () => {
    const main = bot({ id: ProjectId.makeUnsafe("main"), kind: "main", name: "SynBot" });
    let data = applyBotStreamEvent(EMPTY_SYNBOT_DATA, {
      type: "snapshot",
      snapshot: { bots: [main], settings: DEFAULT_BOT_SETTINGS, delegations: [], tasks: [] },
    });
    data = applyBotStreamEvent(data, { type: "bot-upserted", bot: bot({}) });
    data = applyBotStreamEvent(data, { type: "bot-upserted", bot: bot({ status: "waiting" }) });
    expect(data.bots).toHaveLength(2);
    expect(synbotNeedsYouCount(data)).toBe(1);
    data = applyBotStreamEvent(data, {
      type: "settings-updated",
      settings: { ...DEFAULT_BOT_SETTINGS, mergeProofEnabled: true },
    });
    expect(data.settings.mergeProofEnabled).toBe(true);
    const delegation = {
      id: "d1",
      fromThreadId: ThreadId.makeUnsafe("thread-main"),
      toThreadId: ThreadId.makeUnsafe("thread-a"),
    } as BotDelegation;
    data = applyBotStreamEvent(data, { type: "delegation-upserted", delegation });
    expect(delegationsTouchingThread(data, ThreadId.makeUnsafe("thread-a"))).toHaveLength(1);
    data = applyBotStreamEvent(data, { type: "bot-removed", botId: ProjectId.makeUnsafe("bot-a") });
    expect(data.bots.map((entry) => entry.id)).toEqual(["main"]);
  });

  it("keeps the newest task revision", () => {
    const botId = ProjectId.makeUnsafe("bot-a");
    let data = applyBotStreamEvent(EMPTY_SYNBOT_DATA, {
      type: "task-upserted",
      botId,
      task: task({ revision: 3, state: "completed" }),
    });
    data = applyBotStreamEvent(data, { type: "task-upserted", botId, task: task({ revision: 2 }) });
    expect(tasksForBot(data, botId)[0]?.state).toBe("completed");
  });
});

describe("orderedBots", () => {
  it("puts SynBot first, then pinned and other bots by name", () => {
    const ordered = orderedBots([
      bot({ id: ProjectId.makeUnsafe("q"), name: "QA" }),
      bot({ id: ProjectId.makeUnsafe("m"), kind: "main", name: "SynBot" }),
      bot({ id: ProjectId.makeUnsafe("f"), name: "Frontend", pinned: true }),
      bot({ id: ProjectId.makeUnsafe("b"), name: "Backend" }),
    ]);
    expect(ordered.main?.name).toBe("SynBot");
    expect(ordered.pinned.map((entry) => entry.name)).toEqual(["Frontend"]);
    expect(ordered.others.map((entry) => entry.name)).toEqual(["Backend", "QA"]);
    expect(botByThreadId({ ...EMPTY_SYNBOT_DATA, bots: [bot({})] }, "thread-a")?.name).toBe(
      "Frontend",
    );
  });
});

describe("selectedBot", () => {
  const main = bot({ id: ProjectId.makeUnsafe("main"), kind: "main", name: "SynBot" });
  const frontend = bot({ id: ProjectId.makeUnsafe("front"), name: "Frontend" });
  const data = { ...EMPTY_SYNBOT_DATA, bots: [frontend, main] };

  it("is the bot `?bot=` names, or SynBot without one", () => {
    expect(selectedBot(data, "front")?.name).toBe("Frontend");
    expect(selectedBot(data, undefined)?.name).toBe("SynBot");
  });

  it("falls back to SynBot for a bot that is gone (a stale link)", () => {
    expect(selectedBot(data, "removed-bot")?.name).toBe("SynBot");
  });

  it("is nothing before the bots load", () => {
    expect(selectedBot(EMPTY_SYNBOT_DATA, "front")).toBeNull();
  });
});

describe("synbotHasStoppableWork", () => {
  const idle = { ...EMPTY_SYNBOT_DATA, bots: [bot({})] };

  it("is false when every bot is idle and nothing runs", () => {
    expect(synbotHasStoppableWork(EMPTY_SYNBOT_DATA)).toBe(false);
    expect(
      synbotHasStoppableWork({
        ...idle,
        tasks: [{ botId: ProjectId.makeUnsafe("bot-a"), task: task({ state: "completed" }) }],
        delegations: [{ id: "d1", state: "cancelled" } as BotDelegation],
      }),
    ).toBe(false);
  });

  it("is true while a bot works or waits for the user", () => {
    expect(synbotHasStoppableWork({ ...idle, bots: [bot({ status: "working" })] })).toBe(true);
    expect(synbotHasStoppableWork({ ...idle, bots: [bot({ status: "waiting" })] })).toBe(true);
  });

  it("is true while a task is queued or running, or a hand-off is open", () => {
    expect(
      synbotHasStoppableWork({
        ...idle,
        tasks: [{ botId: ProjectId.makeUnsafe("bot-a"), task: task({ state: "queued" }) }],
      }),
    ).toBe(true);
    expect(
      synbotHasStoppableWork({
        ...idle,
        delegations: [{ id: "d1", state: "awaiting-start" } as BotDelegation],
      }),
    ).toBe(true);
  });
});

describe("altoGrantRetry", () => {
  it("re-opens SynBot once per grant, however often the server keeps refusing", () => {
    let retried = false;
    let retries = 0;
    // The page's status cycles refused -> loading -> refused while the plan shows Alto.
    for (const status of ["refused", "loading", "refused", "loading", "refused"]) {
      const next = altoGrantRetry({
        granted: true,
        subscriptionRequired: status === "refused",
        retried,
      });
      retried = next.retried;
      if (next.retry) retries += 1;
    }
    expect(retries).toBe(1);
    // Losing Alto and getting it back allows one more.
    retried = altoGrantRetry({ granted: false, subscriptionRequired: true, retried }).retried;
    expect(altoGrantRetry({ granted: true, subscriptionRequired: true, retried }).retry).toBe(true);
  });
});
