import { ProjectId, ThreadId, type Todo, TodoId, TurnId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import type { SidebarThreadSummary } from "../../types";
import {
  applyTodoEvent,
  buildTaskSections,
  deriveTaskStatus,
  describeTaskMeta,
  formatDueLabel,
  NEEDS_ANSWER_DETAIL,
  pruneSavedTaskText,
  recordSavedTaskText,
  resolveDuePreset,
  summarizeTaskList,
  UNSAVED_TODO_UPDATED_AT,
  type TaskRowModel,
  unlinkChatInput,
  withSavedTaskText,
} from "./tasks.logic";

function todo(overrides: Omit<Partial<Todo>, "id"> & { id: string }): Todo {
  return {
    title: overrides.id,
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

  it("doesn't call a linked chat missing before the chat list has loaded", () => {
    expect(
      deriveTaskStatus({
        todo: delegated,
        thread: null,
        hasDraftThread: false,
        threadsHydrated: false,
      }),
    ).toMatchObject({ kind: "starting", chatMissing: false });
  });

  it("keeps a reused chat starting until its delegated turn appears", () => {
    const handedOff = { ...delegated, delegationBaseTurnId: turnId };
    expect(
      deriveTaskStatus({ todo: handedOff, thread: thread(), hasDraftThread: false }).kind,
    ).toBe("starting");
    const nextTurn = { ...thread().latestTurn!, turnId: TurnId.makeUnsafe("turn-2") };
    expect(
      deriveTaskStatus({
        todo: handedOff,
        thread: thread({ latestTurn: nextTurn }),
        hasDraftThread: false,
      }).kind,
    ).toBe("review");
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

function taskStatus(
  kind: TaskRowModel["status"]["kind"],
  extra: Partial<TaskRowModel["status"]> = {},
): TaskRowModel["status"] {
  return { kind, label: kind, detail: null, workStartedAt: null, chatMissing: false, ...extra };
}

describe("describeTaskMeta", () => {
  it("says what the agent does or needs, else the due day", () => {
    expect(describeTaskMeta(taskStatus("running"), null)).toEqual({
      text: "Working…",
      tone: "muted",
      live: true,
    });
    expect(describeTaskMeta(taskStatus("needs"), null)?.text).toBe("Needs your OK");
    expect(describeTaskMeta(taskStatus("needs", { detail: NEEDS_ANSWER_DETAIL }), null)?.text).toBe(
      "Asked you a question",
    );
    expect(describeTaskMeta(taskStatus("review"), null)?.tone).toBe("review");
    expect(describeTaskMeta(taskStatus("todo"), { label: "Today", overdue: false })?.tone).toBe(
      "strong",
    );
    expect(describeTaskMeta(taskStatus("todo"), { label: "Yesterday", overdue: true })?.tone).toBe(
      "failure",
    );
    expect(describeTaskMeta(taskStatus("todo"), null)).toBeNull();
    expect(describeTaskMeta(taskStatus("done"), null)).toBeNull();
  });
});

describe("summarizeTaskList", () => {
  it("leads with what needs the user", () => {
    expect(
      summarizeTaskList([
        row(todo({ id: "a" }), "needs"),
        row(todo({ id: "b" }), "review"),
        row(todo({ id: "c" }), "running"),
        row(todo({ id: "d" }), "todo"),
      ]),
    ).toBe("2 things need you · 1 working · 1 to do");
    expect(summarizeTaskList([row(todo({ id: "e" }), "done")])).toBe("All done");
    expect(summarizeTaskList([])).toBe("Add anything you need to do");
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

describe("a fresh link to a chat this window doesn't know yet", () => {
  it("reads as Starting for a minute, then as missing", () => {
    const linked = todo({ id: "linked", threadId, linkedAt: "2026-09-27T10:00:00.000Z" });
    const at = (iso: string) =>
      deriveTaskStatus({ todo: linked, thread: null, hasDraftThread: false, now: new Date(iso) });
    expect(at("2026-09-27T10:00:30.000Z")).toMatchObject({ kind: "starting", chatMissing: false });
    expect(at("2026-09-27T10:01:00.000Z")).toMatchObject({ kind: "todo", chatMissing: true });
  });
});

describe("applyTodoEvent", () => {
  it("keeps a create the server hasn't confirmed when a snapshot arrives", () => {
    const pending = todo({ id: "todo-pending", updatedAt: UNSAVED_TODO_UPDATED_AT });
    const stored = todo({ id: "todo-stored" });
    const list = applyTodoEvent({ todos: [pending] }, { type: "snapshot", todos: [stored] });
    expect(list.todos.map((item) => item.id)).toEqual(["todo-stored", "todo-pending"]);
  });

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

describe("saved task text", () => {
  const card = todo({ id: "todo-card", title: "Old title", notes: "" });
  const other = todo({ id: "todo-other", title: "Old title", notes: "" });

  it("reads an edit the to-do's copy doesn't show yet, only for that to-do", () => {
    let saved = recordSavedTaskText(null, { id: card.id, notes: "Use the staging key" });
    saved = recordSavedTaskText(saved, { id: card.id, title: "New title" });
    expect(withSavedTaskText(card, saved)).toMatchObject({
      title: "New title",
      notes: "Use the staging key",
    });
    // Same title and notes, but another to-do: nothing carries over.
    expect(withSavedTaskText(other, saved)).toBe(other);
    expect(pruneSavedTaskText(saved, other)).toBeNull();
  });

  it("keeps an edit until the to-do's copy shows it, whatever else changes", () => {
    const saved = recordSavedTaskText(null, { id: card.id, title: "New title" });
    // Another field changed first: the unsaved title stays.
    expect(pruneSavedTaskText(saved, { ...card, notes: "From another window" })).toEqual(saved);
    expect(pruneSavedTaskText(saved, { ...card, title: "New title" })).toBeNull();
  });

  it("starts over when an edit is for another to-do", () => {
    const saved = recordSavedTaskText(null, { id: card.id, notes: "For the card" });
    expect(recordSavedTaskText(saved, { id: other.id, title: "Other" })).toEqual({
      id: other.id,
      title: "Other",
    });
    expect(recordSavedTaskText(saved, { id: card.id, priority: "high" })).toBe(saved);
  });
});

describe("unlinkChatInput", () => {
  it("clears only the link this window shows", () => {
    expect(unlinkChatInput(delegated)).toEqual({
      id: delegated.id,
      threadId: null,
      expectedThreadId: threadId,
    });
  });
});
