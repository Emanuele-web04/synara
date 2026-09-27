import { ProjectId, ThreadId, type Todo, TodoId, TurnId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import type { SidebarThreadSummary } from "../../types";
import {
  applyTodoEvent,
  buildTaskSections,
  deriveTaskStatus,
  filterTaskRows,
  formatDueLabel,
  resolveDuePreset,
  type TaskRowModel,
} from "./tasks.logic";

function todo(overrides: Omit<Partial<Todo>, "id"> & { id: string }): Todo {
  return {
    title: overrides.id,
    notes: "",
    priority: "none",
    projectId: null,
    dueDate: null,
    threadId: null,
    completedAt: null,
    createdAt: "2026-09-27T10:00:00.000Z",
    updatedAt: "2026-09-27T10:00:00.000Z",
    ...overrides,
    id: TodoId.makeUnsafe(overrides.id),
  };
}

const threadId = ThreadId.makeUnsafe("thread-1");
const turnId = TurnId.makeUnsafe("turn-1");

function thread(overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    id: threadId,
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Clean up Downloads",
    modelSelection: { provider: "claudeAgent", model: "claude-sonnet-5" },
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    session: {
      provider: "claudeAgent",
      status: "ready",
      orchestrationStatus: "ready",
      createdAt: "2026-09-27T10:00:00.000Z",
      updatedAt: "2026-09-27T10:05:00.000Z",
    },
    createdAt: "2026-09-27T10:00:00.000Z",
    latestTurn: {
      turnId,
      state: "completed",
      requestedAt: "2026-09-27T10:00:00.000Z",
      startedAt: "2026-09-27T10:00:01.000Z",
      completedAt: "2026-09-27T10:05:00.000Z",
      assistantMessageId: null,
    },
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    hasLiveTailWork: false,
    ...overrides,
  } as SidebarThreadSummary;
}

const delegated = todo({ id: "todo-delegated", threadId });

describe("deriveTaskStatus", () => {
  it("keeps undelegated and completed to-dos independent of any chat", () => {
    expect(
      deriveTaskStatus({ todo: todo({ id: "a" }), thread: null, hasDraftThread: false }).kind,
    ).toBe("todo");
    expect(
      deriveTaskStatus({
        todo: { ...delegated, completedAt: "2026-09-27T11:00:00.000Z" },
        thread: thread({ hasPendingApprovals: true }),
        hasDraftThread: false,
      }).kind,
    ).toBe("done");
  });

  it("reports a chat that is still a local draft as starting, and a vanished chat as missing", () => {
    expect(deriveTaskStatus({ todo: delegated, thread: null, hasDraftThread: true }).kind).toBe(
      "starting",
    );
    expect(
      deriveTaskStatus({ todo: delegated, thread: null, hasDraftThread: false }),
    ).toMatchObject({
      kind: "todo",
      chatMissing: true,
    });
  });

  it("puts pending approvals first, but not on a dead session", () => {
    expect(
      deriveTaskStatus({
        todo: delegated,
        thread: thread({ hasPendingApprovals: true }),
        hasDraftThread: false,
      }),
    ).toMatchObject({ kind: "needs", detail: "Waiting for your approval" });

    const dead = thread({
      hasPendingApprovals: true,
      session: { ...thread().session!, status: "error", lastError: "Provider crashed" },
      latestTurn: { ...thread().latestTurn!, state: "error" },
    });
    expect(
      deriveTaskStatus({ todo: delegated, thread: dead, hasDraftThread: false }),
    ).toMatchObject({
      kind: "stopped",
      label: "Failed",
      detail: "Provider crashed",
    });
  });

  it("maps a live turn to running and a finished one to review", () => {
    const running = thread({
      session: {
        ...thread().session!,
        status: "running",
        orchestrationStatus: "running",
        activeTurnId: turnId,
      },
      latestTurn: { ...thread().latestTurn!, state: "running", completedAt: null },
    });
    expect(
      deriveTaskStatus({ todo: delegated, thread: running, hasDraftThread: false }),
    ).toMatchObject({
      kind: "running",
      workStartedAt: "2026-09-27T10:00:01.000Z",
    });
    expect(
      deriveTaskStatus({ todo: delegated, thread: thread(), hasDraftThread: false }).kind,
    ).toBe("review");
    expect(
      deriveTaskStatus({
        todo: delegated,
        thread: thread({ latestTurn: { ...thread().latestTurn!, state: "interrupted" } }),
        hasDraftThread: false,
      }).label,
    ).toBe("Stopped");
  });
});

function row(item: Todo, kind: TaskRowModel["status"]["kind"]): TaskRowModel {
  return {
    todo: item,
    thread: null,
    status: { kind, label: kind, detail: null, workStartedAt: null, chatMissing: false },
  };
}

describe("buildTaskSections", () => {
  it("groups by what the user must do and orders by priority, then due date", () => {
    const { sections, completed } = buildTaskSections([
      row(todo({ id: "low", priority: "low" }), "todo"),
      row(todo({ id: "due-later", priority: "high", dueDate: "2026-10-03" }), "todo"),
      row(todo({ id: "due-sooner", priority: "high", dueDate: "2026-09-28" }), "todo"),
      row(todo({ id: "urgent", priority: "urgent" }), "todo"),
      row(todo({ id: "approval" }), "needs"),
      row(todo({ id: "failed" }), "stopped"),
      row(todo({ id: "working" }), "running"),
      row(todo({ id: "finished", completedAt: "2026-09-27T12:00:00.000Z" }), "done"),
    ]);

    expect(sections.map((section) => [section.key, section.rows.map((r) => r.todo.id)])).toEqual([
      ["needs", ["approval", "failed"]],
      ["running", ["working"]],
      ["todo", ["urgent", "due-sooner", "due-later", "low"]],
    ]);
    expect(completed.map((r) => r.todo.id)).toEqual(["finished"]);
  });
});

describe("filterTaskRows", () => {
  it("splits open to-dos into mine and delegated, and done apart", () => {
    const plain = row(todo({ id: "plain" }), "todo");
    const delegatedRow = { ...row(todo({ id: "agent", threadId }), "running"), thread: thread() };
    // Its chat is still a local draft, so no thread summary is loaded yet.
    const startingRow = row(todo({ id: "starting", threadId }), "starting");
    const finished = row(todo({ id: "done", completedAt: "2026-09-27T12:00:00.000Z" }), "done");
    const rows = [plain, delegatedRow, startingRow, finished];

    const ids = (filter: Parameters<typeof filterTaskRows>[1]) =>
      filterTaskRows(rows, filter).map((r) => r.todo.id);
    expect(ids("all")).toEqual(["plain", "agent", "starting", "done"]);
    expect(ids("mine")).toEqual(["plain"]);
    expect(ids("delegated")).toEqual(["agent", "starting"]);
    expect(ids("done")).toEqual(["done"]);
  });
});

describe("due dates", () => {
  // Sunday, September 27, 2026 (local time).
  const now = new Date(2026, 8, 27, 15, 30);

  it("resolves presets to local calendar days", () => {
    expect(resolveDuePreset("today", now)).toBe("2026-09-27");
    expect(resolveDuePreset("tomorrow", now)).toBe("2026-09-28");
    expect(resolveDuePreset("nextWeek", now)).toBe("2026-09-28");
    expect(resolveDuePreset("nextWeek", new Date(2026, 8, 28))).toBe("2026-10-05");
  });

  it("labels nearby days by name and flags overdue ones", () => {
    expect(formatDueLabel("2026-09-27", now)).toEqual({ label: "Today", overdue: false });
    expect(formatDueLabel("2026-09-28", now)).toEqual({ label: "Tomorrow", overdue: false });
    expect(formatDueLabel("2026-09-26", now)).toEqual({ label: "Yesterday", overdue: true });
    expect(formatDueLabel("2026-09-20", now).overdue).toBe(true);
  });
});

describe("applyTodoEvent", () => {
  it("keeps the newest copy of each to-do and drops deleted ones for good", () => {
    const older = todo({ id: "todo-event", title: "Old", updatedAt: "2026-09-27T10:00:00.000Z" });
    const newer = { ...older, title: "New", updatedAt: "2026-09-27T10:01:00.000Z" };

    let list = applyTodoEvent(undefined, { type: "todo-upserted", todo: newer });
    list = applyTodoEvent(list, { type: "todo-upserted", todo: older });
    expect(list.todos.map((item) => item.title)).toEqual(["New"]);

    list = applyTodoEvent(list, { type: "snapshot", todos: [older] });
    expect(list.todos.map((item) => item.title)).toEqual(["New"]);

    list = applyTodoEvent(list, { type: "todo-deleted", todoId: older.id });
    list = applyTodoEvent(list, { type: "todo-upserted", todo: newer });
    expect(list.todos).toEqual([]);
  });
});
