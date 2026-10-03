import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ProjectId, ThreadId, TodoId, type Todo } from "@synara/contracts";

import type { SidebarThreadSummary, ThreadSession } from "../../types";
import { resolveThreadStatusPill } from "../Sidebar.logic";
import { toLocalDueDate, type TaskRowModel, type TaskStatusKind } from "../tasks/tasks.logic";
import type { StatsGetRecapResult } from "@synara/contracts";

import {
  collectNeedsYouItems,
  compareWithYesterday,
  countNeedsYouActions,
  groupInboxThreads,
  modelIconProvider,
  recapInputForRange,
  previousDayCutoffMs,
  resolveInboxDay,
  selectInboxTasks,
  sumRecapBefore,
  summarizeInboxSlots,
  type InboxDayRange,
} from "./inbox.logic";

// Local wall-clock instants, so the expectations hold in any test timezone.
const local = (month: number, day: number, hour: number, minute = 0) =>
  new Date(2026, month - 1, day, hour, minute).getTime();

describe("resolveInboxDay", () => {
  it("splits the 4am working day into morning, afternoon, and evening", () => {
    const day = resolveInboxDay(local(9, 30, 13, 15));

    expect(day.fromMs).toBe(local(9, 30, 4));
    expect(day.toMs).toBe(local(10, 1, 4));
    expect(day.currentSlotId).toBe("afternoon");
    expect(day.slots.map(({ id, fromMs, toMs }) => ({ id, fromMs, toMs }))).toEqual([
      { id: "morning", fromMs: local(9, 30, 4), toMs: local(9, 30, 12) },
      { id: "afternoon", fromMs: local(9, 30, 12), toMs: local(9, 30, 18) },
      { id: "evening", fromMs: local(9, 30, 18), toMs: local(10, 1, 4) },
    ]);
    expect(day.previousDay.fromMs).toBe(local(9, 29, 4));
    expect(day.previousDay.toMs).toBe(local(9, 30, 4));
  });

  it("keeps a late-night session in the evening of the day it started", () => {
    const day = resolveInboxDay(local(10, 1, 2, 30));

    expect(day.fromMs).toBe(local(9, 30, 4));
    expect(day.currentSlotId).toBe("evening");
  });

  describe("across daylight-saving changes (Europe/Rome)", () => {
    const originalTimeZone = process.env.TZ;
    beforeAll(() => {
      process.env.TZ = "Europe/Rome";
    });
    afterAll(() => {
      process.env.TZ = originalTimeZone;
    });

    it.each([
      [3, 29, 28],
      [10, 25, 24],
    ])(
      "compares the same local time across the clock change on %i/%i",
      (month, date, previousDate) => {
        expect(previousDayCutoffMs(local(month, date, 3, 30))).toBe(
          local(month, previousDate, 3, 30),
        );
      },
    );

    it("gives the fall-back night 25 one-hour bars and the spring-forward night 23", () => {
      // Clocks go back at 03:00 on Oct 25 and forward at 02:00 on Mar 29, both inside the
      // working day that started at 04:00 the day before.
      const fallBack = resolveInboxDay(local(10, 24, 20));
      const springForward = resolveInboxDay(local(3, 28, 20));

      expect(fallBack.hours).toHaveLength(25);
      expect(springForward.hours).toHaveLength(23);
      for (const day of [fallBack, springForward]) {
        expect(day.hours.every((hour) => hour.toMs - hour.fromMs === 3_600_000)).toBe(true);
        expect(day.hours.at(-1)?.toMs).toBe(day.toMs);
        expect(recapInputForRange(day).slotBoundaries).toHaveLength(day.hours.length - 1);
      }
      expect(fallBack.toMs).toBe(local(10, 25, 4));
      expect(fallBack.slots[2]?.fromMs).toBe(local(10, 24, 18));
    });
  });

  it("asks for the day by hour", () => {
    const day = resolveInboxDay(local(9, 30, 9));
    const input = recapInputForRange(day);

    expect(input.from).toBe(new Date(local(9, 30, 4)).toISOString());
    expect(input.to).toBe(new Date(local(10, 1, 4)).toISOString());
    expect(input.slotBoundaries).toHaveLength(day.hours.length - 1);
    expect(input.slotBoundaries[0]).toBe(new Date(local(9, 30, 5)).toISOString());
  });
});

function recapWithHours(
  day: InboxDayRange,
  bucket: (index: number) => { prompts: number; tokens: number },
): StatsGetRecapResult {
  const slot = (index: number) => {
    const { prompts, tokens } = bucket(index);
    const hour = day.hours[index];
    return {
      from: hour ? new Date(hour.fromMs).toISOString() : "",
      to: hour ? new Date(hour.toMs).toISOString() : "",
      prompts,
      chats: prompts > 0 ? 1 : 0,
      turns: prompts,
      failedTurns: 0,
      agentWorkMs: prompts * 60_000,
      tokens: { user: tokens, automation: 0, agent: 0 },
    };
  };
  const slots = day.hours.map((_, index) => slot(index));
  return {
    generatedAt: "",
    totals: slot(0),
    slots,
    projects: [],
    models: [],
    unavailableProviders: [],
  };
}

describe("summarizeInboxSlots", () => {
  it("shows only started slots and drops an idle past one", () => {
    const now = local(9, 30, 13, 30);
    const day = resolveInboxDay(now);
    // Nothing in the morning, one prompt per hour from noon.
    const recap = recapWithHours(day, (index) =>
      index >= 8 && index <= 9 ? { prompts: 1, tokens: 1000 } : { prompts: 0, tokens: 0 },
    );

    const slots = summarizeInboxSlots(recap, day, now);

    expect(slots.map((slot) => [slot.id, slot.status, slot.prompts, slot.tokens])).toEqual([
      ["afternoon", "now", 2, 2000],
    ]);
    expect(slots[0]?.hours.map((hour) => hour.future)).toEqual([
      false,
      false,
      true,
      true,
      true,
      true,
    ]);
  });

  it("keeps a past slot whose only activity is an agent still running from before", () => {
    const now = local(9, 30, 13, 30);
    const day = resolveInboxDay(now);
    const recap = recapWithHours(day, () => ({ prompts: 0, tokens: 0 }));
    const morningHour = recap.slots[2];
    if (!morningHour) throw new Error("expected a morning hour");
    const slots = summarizeInboxSlots(
      {
        ...recap,
        slots: recap.slots.map((slot) =>
          slot === morningHour ? { ...slot, agentWorkMs: 3_600_000 } : slot,
        ),
      },
      day,
      now,
    );

    expect(slots.map((slot) => [slot.id, slot.agentWorkMs])).toEqual([
      ["morning", 3_600_000],
      ["afternoon", 0],
    ]);
  });

  it("keeps the current slot even before anything ran in it", () => {
    const now = local(9, 30, 5);
    const day = resolveInboxDay(now);
    const slots = summarizeInboxSlots(
      recapWithHours(day, () => ({ prompts: 0, tokens: 0 })),
      day,
      now,
    );

    expect(slots.map((slot) => slot.id)).toEqual(["morning"]);
  });
});

describe("sumRecapBefore", () => {
  it("counts yesterday up to the same time, the current hour pro rata", () => {
    const day = resolveInboxDay(local(9, 30, 13)).previousDay;
    const recap = recapWithHours(day, () => ({ prompts: 2, tokens: 100 }));

    // 06:30 is two and a half hours into the day.
    const totals = sumRecapBefore(recap, day, local(9, 29, 6, 30));

    expect(totals.prompts).toBe(5);
    expect(totals.tokens).toBe(250);
  });
});

describe("compareWithYesterday", () => {
  it("reports a percentage only when yesterday had something to compare", () => {
    expect(compareWithYesterday(41, 35)).toEqual({ label: "+17%", trend: "up" });
    expect(compareWithYesterday(10, 20)).toEqual({ label: "-50%", trend: "down" });
    expect(compareWithYesterday(5, 0)).toBeNull();
    expect(compareWithYesterday(5, null)).toBeNull();
  });
});

describe("modelIconProvider", () => {
  it("uses the model's maker when the name says so, else the provider", () => {
    expect(modelIconProvider("codex", "gpt-6-astra")).toBe("codex");
    expect(modelIconProvider("cursor", "claude-opus-5-5")).toBe("claudeAgent");
    expect(modelIconProvider("cursor", "composer-2")).toBe("cursor");
    expect(modelIconProvider("opencode", "openai/gpt-5")).toBe("codex");
    expect(modelIconProvider("omp", "openrouter/o3")).toBe("codex");
    expect(modelIconProvider("opencode", "qwen3-coder")).toBe("opencode");
    expect(modelIconProvider("unknown", "mystery")).toBeNull();
  });
});

function makeThread(
  id: string,
  overrides: Partial<SidebarThreadSummary> = {},
): SidebarThreadSummary {
  return {
    id: ThreadId.makeUnsafe(id),
    projectId: ProjectId.makeUnsafe("project-1"),
    title: `Thread ${id}`,
    modelSelection: { provider: "codex", model: "gpt-5" },
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    session: {
      provider: "codex",
      status: "ready",
      createdAt: "2026-09-30T08:00:00.000Z",
      updatedAt: "2026-09-30T08:00:00.000Z",
      orchestrationStatus: "idle",
    } as ThreadSession,
    createdAt: "2026-09-30T08:00:00.000Z",
    updatedAt: "2026-09-30T09:00:00.000Z",
    latestTurn: {
      turnId: `turn-${id}`,
      state: "completed",
      requestedAt: "2026-09-30T08:30:00.000Z",
      startedAt: "2026-09-30T08:30:00.000Z",
      completedAt: "2026-09-30T08:45:00.000Z",
    } as SidebarThreadSummary["latestTurn"],
    lastVisitedAt: "2026-09-30T09:00:00.000Z",
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    hasLiveTailWork: false,
    pendingBackgroundWorkCount: 0,
    ...overrides,
  } satisfies SidebarThreadSummary;
}

describe("collectNeedsYouItems", () => {
  it("lists waiting threads by urgency and skips seen, archived, and child threads", () => {
    const unseen = { lastVisitedAt: "2026-09-30T08:00:00.000Z" };
    const failedTurn = {
      turnId: "turn-failed",
      state: "error",
      requestedAt: "2026-09-30T08:30:00.000Z",
      startedAt: "2026-09-30T08:30:00.000Z",
      completedAt: "2026-09-30T08:45:00.000Z",
    } as SidebarThreadSummary["latestTurn"];
    const threads = [
      makeThread("unread", unseen),
      makeThread("failed", { ...unseen, latestTurn: failedTurn }),
      makeThread("failed-seen", { latestTurn: failedTurn }),
      makeThread("approval", { hasPendingApprovals: true }),
      makeThread("input", { hasPendingUserInput: true }),
      makeThread("seen"),
      makeThread("archived", { ...unseen, archivedAt: "2026-09-30T09:30:00.000Z" }),
      makeThread("child", { ...unseen, parentThreadId: ThreadId.makeUnsafe("approval") }),
    ];

    const items = collectNeedsYouItems(threads);

    expect(items.map((item) => [item.kind, item.thread.id])).toEqual([
      ["approval", "approval"],
      ["input", "input"],
      ["failed", "failed"],
      ["unread", "unread"],
    ]);
    // The badge counts what the "Needs you" group lists: not failures or plain unread
    // completions, and not the thread the user has open.
    expect(countNeedsYouActions(threads, ThreadId.makeUnsafe("input"))).toBe(1);
  });
});

describe("dismissed status pills", () => {
  it("drops what the user dismissed in the sidebar from the badge and the lists", () => {
    const unseen = { lastVisitedAt: "2026-09-30T08:00:00.000Z" };
    const approval = makeThread("approval", { hasPendingApprovals: true });
    const failed = makeThread("failed", {
      ...unseen,
      latestTurn: {
        turnId: "turn-failed",
        state: "error",
        requestedAt: "2026-09-30T08:30:00.000Z",
        startedAt: "2026-09-30T08:30:00.000Z",
        completedAt: "2026-09-30T08:45:00.000Z",
      } as SidebarThreadSummary["latestTurn"],
    });
    const threads = [approval, failed];
    const pillKey = (thread: SidebarThreadSummary) =>
      resolveThreadStatusPill({
        thread,
        hasPendingApprovals: thread.hasPendingApprovals,
        hasPendingUserInput: thread.hasPendingUserInput,
      })?.dismissalKey ?? "";
    const dismissed = { approval: pillKey(approval), failed: pillKey(failed) };

    expect(countNeedsYouActions(threads, null)).toBe(1);
    expect(countNeedsYouActions(threads, null, dismissed)).toBe(0);
    expect(groupInboxThreads(threads, dismissed)).toMatchObject({ needsYou: [], failed: [] });
  });
});

describe("groupInboxThreads", () => {
  it("puts each thread in exactly one list", () => {
    const working = makeThread("working", {
      latestTurn: {
        turnId: "turn-working",
        state: "running",
        requestedAt: "2026-09-30T08:30:00.000Z",
        startedAt: "2026-09-30T08:30:00.000Z",
        completedAt: null,
      } as SidebarThreadSummary["latestTurn"],
      session: {
        provider: "codex",
        status: "running",
        activeTurnId: "turn-working",
        createdAt: "2026-09-30T08:00:00.000Z",
        updatedAt: "2026-09-30T08:30:00.000Z",
        orchestrationStatus: "running",
      } as ThreadSession,
    });
    const groups = groupInboxThreads([
      working,
      makeThread("unread", { lastVisitedAt: "2026-09-30T08:00:00.000Z" }),
      makeThread("seen"),
    ]);

    expect(groups.needsYou).toEqual([]);
    expect(groups.working.map((thread) => thread.id)).toEqual(["working"]);
    expect(groups.finished.map((thread) => thread.id)).toEqual(["unread"]);
    expect(groups.failed).toEqual([]);
  });
});

describe("selectInboxTasks", () => {
  const nowMs = local(9, 30, 13);
  const day = resolveInboxDay(nowMs);
  const due = (month: number, date: number) => toLocalDueDate(new Date(2026, month - 1, date));
  const row = (id: string, kind: TaskStatusKind, overrides: Partial<Todo> = {}): TaskRowModel => ({
    todo: {
      id: TodoId.makeUnsafe(id),
      title: id,
      notes: "",
      priority: "none",
      projectId: null,
      dueDate: null,
      threadId: null,
      delegationBaseTurnId: null,
      linkedAt: null,
      completedAt: null,
      createdAt: "2026-09-27T10:00:00.000Z",
      updatedAt: "2026-09-27T10:00:00.000Z",
      ...overrides,
    },
    thread: null,
    status: { kind, label: kind } as TaskRowModel["status"],
  });

  it("keeps what counts today and leaves the backlog out", () => {
    const tasks = selectInboxTasks(
      [
        row("backlog", "todo"),
        row("later", "todo", { dueDate: due(10, 2) }),
        row("today", "todo", { dueDate: due(9, 30) }),
        row("overdue", "todo", { dueDate: due(9, 28) }),
        row("with-agent", "running"),
        row("done-today", "done", { completedAt: new Date(local(9, 30, 9)).toISOString() }),
        row("done-before", "done", { completedAt: new Date(local(9, 29, 9)).toISOString() }),
      ],
      day,
      nowMs,
    );

    expect(tasks.open.map((item) => item.todo.id)).toEqual(["with-agent", "overdue", "today"]);
    expect(tasks.doneToday.map((item) => item.todo.id)).toEqual(["done-today"]);
    expect(tasks.overdue).toBe(1);
  });
});
