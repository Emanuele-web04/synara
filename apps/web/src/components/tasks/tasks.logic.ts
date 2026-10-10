// FILE: tasks.logic.ts
// Purpose: Pure derivation for the Tasks view — a to-do's status from its linked agent
//          chat, grouping and ordering, due-date labels, and the React Query cache
//          reducer for the live to-do event stream, and the text a delegation sends.
// Layer: UI logic (no React, no stores) so the task math stays unit-testable.
// Exports: deriveTaskStatus, buildTaskSections, applyTodoEvent, due-date helpers,
//          priority metadata.

import {
  TodoId,
  type Todo,
  type TodoDueDate,
  type TodoListResult,
  type TodoPriority,
  type TodoStreamEvent,
  type TodoUpdateInput,
} from "@synara/contracts";

import { formatRelativeTime } from "~/lib/relativeTime";
import { canSessionAnswerPendingRequests, deriveActiveWorkStartedAt } from "../../session-logic";
import type { SidebarThreadSummary } from "../../types";
import { isThreadActivelyWorking } from "../Sidebar.logic";

// ── Status ───────────────────────────────────────────────────────────

export type TaskStatusKind =
  | "todo"
  | "starting"
  | "running"
  | "needs"
  | "review"
  | "stopped"
  | "done";

export interface TaskStatus {
  kind: TaskStatusKind;
  /** Short state name shown in the status chip. */
  label: string;
  /** What the agent is doing or waiting on, when it says more than the label. */
  detail: string | null;
  /** ISO start of the running turn, for a live "4m" elapsed readout. */
  workStartedAt: string | null;
  /** True when the to-do points at a chat that no longer exists (deleted or not synced). */
  chatMissing: boolean;
}

export const NEEDS_APPROVAL_DETAIL = "Waiting for your approval";
export const NEEDS_ANSWER_DETAIL = "Asked you a question";

const TODO_STATUS: TaskStatus = {
  kind: "todo",
  label: "To do",
  detail: null,
  workStartedAt: null,
  chatMissing: false,
};

/** How long a new link's chat may take to reach every window before it counts as missing. */
const LINK_SETTLE_MS = 60_000;

/** A durable cross-window grace period while a newly linked chat reaches the client. */
export function isTaskLinkSettling(todo: Pick<Todo, "linkedAt">, now: Date): boolean {
  return todo.linkedAt !== null && now.getTime() - Date.parse(todo.linkedAt) < LINK_SETTLE_MS;
}

export function deriveTaskStatus(input: {
  todo: Pick<Todo, "completedAt" | "threadId" | "delegationBaseTurnId" | "linkedAt">;
  thread: SidebarThreadSummary | null;
  /** The linked chat is still a local draft that has not reached the server yet. */
  hasDraftThread: boolean;
  /** False until the chat list has loaded; a link can't be called missing before that. */
  threadsHydrated?: boolean;
  /** With it, a link younger than LINK_SETTLE_MS whose chat isn't known yet is Starting. */
  now?: Date | undefined;
}): TaskStatus {
  const { todo, thread } = input;
  if (todo.completedAt !== null) {
    return { ...TODO_STATUS, kind: "done", label: "Done" };
  }
  if (todo.threadId === null) {
    return TODO_STATUS;
  }
  if (thread === null) {
    if (input.hasDraftThread) return { ...TODO_STATUS, kind: "starting", label: "Starting" };
    if (input.threadsHydrated === false) {
      return { ...TODO_STATUS, kind: "starting", label: "Loading", detail: "Loading the chat…" };
    }
    // Another window (or this one after a reload) may still be creating the chat.
    if (input.now && isTaskLinkSettling(todo, input.now)) {
      return { ...TODO_STATUS, kind: "starting", label: "Starting" };
    }
    return { ...TODO_STATUS, chatMissing: true };
  }
  // Handed to an existing chat whose delegated turn hasn't appeared yet: the chat's
  // current state belongs to earlier work.
  if (
    todo.delegationBaseTurnId !== null &&
    (thread.latestTurn?.turnId ?? null) === todo.delegationBaseTurnId
  ) {
    return { ...TODO_STATUS, kind: "starting", label: "Starting" };
  }

  const session = thread.session;
  const canAnswer = canSessionAnswerPendingRequests(session);
  if (thread.hasPendingApprovals && canAnswer) {
    return {
      ...TODO_STATUS,
      kind: "needs",
      label: "Needs you",
      detail: NEEDS_APPROVAL_DETAIL,
    };
  }
  if (thread.hasPendingUserInput && canAnswer) {
    return { ...TODO_STATUS, kind: "needs", label: "Needs you", detail: NEEDS_ANSWER_DETAIL };
  }
  if (isThreadActivelyWorking(thread)) {
    return {
      ...TODO_STATUS,
      kind: "running",
      label: "Running",
      detail: "Working",
      workStartedAt: deriveActiveWorkStartedAt(thread.latestTurn, session, null),
    };
  }
  const latestTurn = thread.latestTurn;
  if (
    session?.status === "connecting" ||
    latestTurn === null ||
    (latestTurn.state === "running" && latestTurn.startedAt === null)
  ) {
    return { ...TODO_STATUS, kind: "starting", label: "Starting" };
  }
  if (session?.status === "error" || latestTurn.state === "error") {
    return {
      ...TODO_STATUS,
      kind: "stopped",
      label: "Failed",
      detail: session?.lastError?.trim() || "The agent stopped with an error",
    };
  }
  if (latestTurn.state === "interrupted") {
    return { ...TODO_STATUS, kind: "stopped", label: "Stopped", detail: "Interrupted" };
  }
  if (thread.hasActionableProposedPlan && thread.interactionMode === "plan") {
    return { ...TODO_STATUS, kind: "review", label: "Review", detail: "Plan ready" };
  }
  return { ...TODO_STATUS, kind: "review", label: "Review", detail: "Finished" };
}

/** What the agent is doing, for the row's agent line ("Working · 4m", "Finished 2m ago"). */
export function formatAgentActivity(
  status: TaskStatus,
  thread: Pick<SidebarThreadSummary, "latestTurn"> | null,
): string | null {
  if (!thread) return null;
  if (status.kind === "running" && status.workStartedAt) {
    const elapsed = formatRelativeTime(status.workStartedAt);
    return elapsed === "now" ? "Working" : `Working · ${elapsed}`;
  }
  if (status.kind === "review" && thread.latestTurn?.completedAt) {
    const ago = formatRelativeTime(thread.latestTurn.completedAt);
    return `${status.detail ?? "Finished"} ${ago === "now" ? "just now" : `${ago} ago`}`;
  }
  if (status.kind === "starting") return "Starting…";
  return status.detail;
}

/** How a row's one quiet status word reads: muted, or tinted when it wants the user. */
export type TaskMetaTone = "muted" | "strong" | "attention" | "review" | "failure";

export interface TaskMeta {
  text: string;
  tone: TaskMetaTone;
  /** Agent work in progress: the row shimmers it. */
  live: boolean;
}

/** The short word after a row's title: its due day, or what its agent is doing or needs. */
export function describeTaskMeta(
  status: TaskStatus,
  due: { label: string; overdue: boolean } | null,
): TaskMeta | null {
  switch (status.kind) {
    case "starting":
      return { text: "Starting…", tone: "muted", live: true };
    case "running":
      return { text: "Working…", tone: "muted", live: true };
    case "needs":
      return {
        text: status.detail === NEEDS_ANSWER_DETAIL ? "Asked you a question" : "Needs your OK",
        tone: "attention",
        live: false,
      };
    case "review":
      return { text: "Ready for you", tone: "review", live: false };
    case "stopped":
      return { text: status.label, tone: "failure", live: false };
    case "done":
      return null;
    case "todo":
      if (status.chatMissing) return { text: "Chat deleted", tone: "muted", live: false };
      if (!due) return null;
      return {
        text: due.label,
        tone: due.overdue ? "failure" : due.label === "Today" ? "strong" : "muted",
        live: false,
      };
  }
}

/** The line under the page title: what needs the user, then what's left to do. */
export function summarizeTaskList(rows: readonly TaskRowModel[]): string {
  const attention = rows.filter((row) => isTaskNeedingAttention(row.status)).length;
  const toDo = rows.filter((row) => row.status.kind === "todo").length;
  const working = rows.filter(
    (row) => row.status.kind === "running" || row.status.kind === "starting",
  ).length;
  const parts = [
    attention > 0 ? `${attention} ${attention === 1 ? "thing needs" : "things need"} you` : null,
    working > 0 ? `${working} working` : null,
    toDo > 0 ? `${toDo} to do` : null,
  ].filter((part) => part !== null);
  if (parts.length > 0) return parts.join(" · ");
  return rows.length > 0 ? "All done" : "Add anything you need to do";
}

export function folderLabel(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).at(-1) || trimmed;
}

/** Where the delegated agent works: its folder when it has one, else the project name. */
export function describeAgentLocation(
  thread: Pick<SidebarThreadSummary, "workingDirectory" | "projectId">,
  projectNameById: ReadonlyMap<string, string>,
): string | null {
  return thread.workingDirectory
    ? folderLabel(thread.workingDirectory)
    : (projectNameById.get(thread.projectId) ?? null);
}

// ── Priority ─────────────────────────────────────────────────────────

export const TODO_PRIORITY_OPTIONS: ReadonlyArray<{ value: TodoPriority; label: string }> = [
  { value: "urgent", label: "Urgent" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
  { value: "none", label: "No priority" },
];

const PRIORITY_RANK: Record<TodoPriority, number> = {
  urgent: 4,
  high: 3,
  medium: 2,
  low: 1,
  none: 0,
};

export function todoPriorityLabel(priority: TodoPriority): string {
  return TODO_PRIORITY_OPTIONS.find((option) => option.value === priority)?.label ?? "";
}

// ── Grouping ─────────────────────────────────────────────────────────

export type TaskSectionKey = "needs" | "running" | "todo";

export interface TaskRowModel {
  todo: Todo;
  status: TaskStatus;
  thread: SidebarThreadSummary | null;
}

export interface TaskSection {
  key: TaskSectionKey;
  label: string;
  rows: TaskRowModel[];
}

const SECTION_BY_STATUS: Record<Exclude<TaskStatusKind, "done">, TaskSectionKey> = {
  needs: "needs",
  review: "needs",
  stopped: "needs",
  running: "running",
  starting: "running",
  todo: "todo",
};

/** Whether the to-do waits on the user: an approval, a finished run, or a failure. */
export function isTaskNeedingAttention(status: TaskStatus): boolean {
  return status.kind !== "done" && SECTION_BY_STATUS[status.kind] === "needs";
}

const SECTION_LABELS: Record<TaskSectionKey, string> = {
  needs: "Needs you",
  running: "Running",
  todo: "To do",
};

const SECTION_ORDER: readonly TaskSectionKey[] = ["needs", "running", "todo"];

function compareOpenRows(left: TaskRowModel, right: TaskRowModel): number {
  const byPriority = PRIORITY_RANK[right.todo.priority] - PRIORITY_RANK[left.todo.priority];
  if (byPriority !== 0) return byPriority;
  const leftDue = left.todo.dueDate;
  const rightDue = right.todo.dueDate;
  if (leftDue !== rightDue) {
    if (leftDue === null) return 1;
    if (rightDue === null) return -1;
    return leftDue.localeCompare(rightDue);
  }
  return left.todo.createdAt.localeCompare(right.todo.createdAt);
}

/** Open to-dos grouped by what they need from the user; empty sections are dropped. */
export function buildTaskSections(rows: readonly TaskRowModel[]): {
  sections: TaskSection[];
  completed: TaskRowModel[];
} {
  const bySection = new Map<TaskSectionKey, TaskRowModel[]>();
  const completed: TaskRowModel[] = [];
  for (const row of rows) {
    if (row.status.kind === "done") {
      completed.push(row);
      continue;
    }
    const key = SECTION_BY_STATUS[row.status.kind];
    const list = bySection.get(key) ?? [];
    list.push(row);
    bySection.set(key, list);
  }
  const sections = SECTION_ORDER.flatMap((key) => {
    const sectionRows = bySection.get(key);
    return sectionRows && sectionRows.length > 0
      ? [{ key, label: SECTION_LABELS[key], rows: sectionRows.toSorted(compareOpenRows) }]
      : [];
  });
  completed.sort((left, right) =>
    (right.todo.completedAt ?? "").localeCompare(left.todo.completedAt ?? ""),
  );
  return { sections, completed };
}

/** The client picks a to-do's id, so its optimistic row and a retried create stay one. */
export function newTodoId(): TodoId {
  return TodoId.makeUnsafe(`todo:${crypto.randomUUID()}`);
}

// ── Due dates ────────────────────────────────────────────────────────

export function toLocalDueDate(date: Date): TodoDueDate {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseLocalDueDate(dueDate: TodoDueDate): Date {
  const [year, month, day] = dueDate.split("-").map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export type DuePreset = "today" | "tomorrow" | "nextWeek";

export const DUE_PRESET_OPTIONS: ReadonlyArray<{ value: DuePreset; label: string }> = [
  { value: "today", label: "Today" },
  { value: "tomorrow", label: "Tomorrow" },
  { value: "nextWeek", label: "Next week" },
];

export function resolveDuePreset(preset: DuePreset, now: Date): TodoDueDate {
  if (preset === "today") return toLocalDueDate(now);
  if (preset === "tomorrow") return toLocalDueDate(addDays(now, 1));
  // Next Monday, or a week out when today is already Monday.
  const daysUntilMonday = (8 - now.getDay()) % 7 || 7;
  return toLocalDueDate(addDays(now, daysUntilMonday));
}

export function formatDueLabel(
  dueDate: TodoDueDate,
  now: Date,
): { label: string; overdue: boolean } {
  const today = parseLocalDueDate(toLocalDueDate(now));
  const due = parseLocalDueDate(dueDate);
  const dayDiff = Math.round((due.getTime() - today.getTime()) / 86_400_000);
  if (dayDiff === 0) return { label: "Today", overdue: false };
  if (dayDiff === 1) return { label: "Tomorrow", overdue: false };
  if (dayDiff === -1) return { label: "Yesterday", overdue: true };
  if (dayDiff > 1 && dayDiff < 7) {
    return { label: due.toLocaleDateString(undefined, { weekday: "short" }), overdue: false };
  }
  const sameYear = due.getFullYear() === today.getFullYear();
  return {
    label: due.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      ...(sameYear ? {} : { year: "numeric" }),
    }),
    overdue: dayDiff < 0,
  };
}

// ── Cache ────────────────────────────────────────────────────────────

export const todoQueryKey = ["todos"] as const;
export const EMPTY_TODO_LIST: TodoListResult = { todos: [] };

/**
 * Ids deleted during this session. A late upsert (an update that raced the delete)
 * must not resurrect the row; ids are client-generated and never reused.
 */
/** Stamps an optimistic create until the server confirms it; any stored row is newer. */
export const UNSAVED_TODO_UPDATED_AT = "1970-01-01T00:00:00.000Z";

const deletedTodosById = new Map<TodoId, "pending" | "confirmed">();

export function markTodoDeleted(todoId: TodoId, confirmed = false): void {
  // Confirmation is terminal: later duplicate attempts cannot downgrade it.
  if (confirmed || deletedTodosById.get(todoId) !== "confirmed") {
    deletedTodosById.set(todoId, confirmed ? "confirmed" : "pending");
  }
}

/** Roll back an unconfirmed delete; a server-confirmed deletion can never be undone. */
export function unmarkTodoDeleted(todoId: TodoId): void {
  if (deletedTodosById.get(todoId) !== "confirmed") deletedTodosById.delete(todoId);
}

function isSameOrNewer(candidate: string, existing: string): boolean {
  return candidate.localeCompare(existing) >= 0;
}

export function upsertTodo(todos: readonly Todo[], incoming: Todo): Todo[] {
  if (deletedTodosById.has(incoming.id)) {
    return [...todos];
  }
  const existing = todos.find((todo) => todo.id === incoming.id);
  if (!existing) {
    return [...todos, incoming];
  }
  if (!isSameOrNewer(incoming.updatedAt, existing.updatedAt)) {
    return [...todos];
  }
  return todos.map((todo) => (todo.id === incoming.id ? incoming : todo));
}

export function applyTodoEvent(
  prev: TodoListResult | undefined,
  event: TodoStreamEvent,
): TodoListResult {
  const base = prev ?? EMPTY_TODO_LIST;
  switch (event.type) {
    case "snapshot": {
      const previousById = new Map(base.todos.map((todo) => [todo.id, todo]));
      const snapshotIds = new Set(event.todos.map((todo) => todo.id));
      return {
        todos: [
          ...event.todos.flatMap((todo) => {
            if (deletedTodosById.has(todo.id)) return [];
            const previous = previousById.get(todo.id);
            // Snapshots are reconciliation data: a newer live copy keeps winning.
            return [
              previous && !isSameOrNewer(todo.updatedAt, previous.updatedAt) ? previous : todo,
            ];
          }),
          // A create still on its way isn't in the server's list yet; keep it. Its reply
          // (or its failure) settles it.
          ...base.todos.filter(
            (todo) => todo.updatedAt === UNSAVED_TODO_UPDATED_AT && !snapshotIds.has(todo.id),
          ),
        ],
      };
    }
    case "todo-upserted":
      return { todos: upsertTodo(base.todos, event.todo) };
    case "todo-deleted":
      markTodoDeleted(event.todoId, true);
      return { todos: base.todos.filter((todo) => todo.id !== event.todoId) };
  }
}

/**
 * Title and note edits the card saved for one to-do that its own copy may not show yet (the
 * optimistic write lands a moment later). Start reads the to-do through them, so an edit
 * saved by that same press still reaches the agent.
 */
export interface SavedTaskText {
  readonly id: TodoId;
  readonly title?: string;
  readonly notes?: string;
}

function savedTextFields(title: string | undefined, notes: string | undefined) {
  return { ...(title === undefined ? {} : { title }), ...(notes === undefined ? {} : { notes }) };
}

/** Records a saved title or note, starting over when the edit is for another to-do. */
export function recordSavedTaskText(
  saved: SavedTaskText | null,
  input: TodoUpdateInput,
): SavedTaskText | null {
  if (input.title === undefined && input.notes === undefined) return saved;
  const current = saved?.id === input.id ? saved : null;
  return {
    id: input.id,
    ...savedTextFields(input.title ?? current?.title, input.notes ?? current?.notes),
  };
}

/** Keeps only the edits `todo` doesn't show yet; none once another to-do is selected. */
export function pruneSavedTaskText(
  saved: SavedTaskText | null,
  todo: Pick<Todo, "id" | "title" | "notes">,
): SavedTaskText | null {
  if (!saved || saved.id !== todo.id) return null;
  const title = saved.title === todo.title ? undefined : saved.title;
  const notes = saved.notes === todo.notes ? undefined : saved.notes;
  if (title === undefined && notes === undefined) return null;
  return { id: saved.id, ...savedTextFields(title, notes) };
}

/** The to-do as last saved from the card. */
export function withSavedTaskText(todo: Todo, saved: SavedTaskText | null): Todo {
  if (!saved || saved.id !== todo.id) return todo;
  return { ...todo, ...savedTextFields(saved.title, saved.notes) };
}

/**
 * Clears a to-do's chat link, but only the link this window shows: another window may have
 * delegated it anew meanwhile, and that link must survive a stale Unlink.
 */
export function unlinkChatInput(todo: Pick<Todo, "id" | "threadId">): TodoUpdateInput {
  return { id: todo.id, threadId: null, expectedThreadId: todo.threadId };
}

/** Prompt handed to the agent when a to-do is delegated. */
export function buildDelegationPrompt(todo: Pick<Todo, "title" | "notes">): string {
  const notes = todo.notes.trim();
  return notes.length > 0 ? `${todo.title}\n\n${notes}` : todo.title;
}
