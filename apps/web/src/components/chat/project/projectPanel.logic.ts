import type {
  ProjectDigestFocusItem,
  ProjectTask,
  ProjectThreadIndexEntry,
  ThreadId,
} from "@synara/contracts";

export type ProjectFocusRowState = "open" | "done" | "archived";

export type ProjectFocusRow = {
  readonly id: string;
  readonly title: string;
  readonly detail: string | null;
  readonly threadId: ThreadId | null;
  readonly state: ProjectFocusRowState;
};

const OPEN_TASK_STATUSES = new Set(["planned", "ready", "running", "review", "blocked"]);

function firstLine(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0) return null;
  const line = trimmed.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return line.length > 0 ? line : null;
}

export function projectTaskFocusRow(task: ProjectTask): ProjectFocusRow {
  const archived = task.archivedAt !== null;
  const done = task.status === "done" || task.status === "cancelled";
  return {
    id: task.id,
    title: task.title,
    detail: firstLine(task.description),
    threadId: task.assignedThreadId,
    state: archived
      ? "archived"
      : done
        ? "done"
        : OPEN_TASK_STATUSES.has(task.status)
          ? "open"
          : "done",
  };
}

export function partitionProjectFocusRows(tasks: ReadonlyArray<ProjectTask>): {
  readonly open: ReadonlyArray<ProjectFocusRow>;
  readonly done: ReadonlyArray<ProjectFocusRow>;
  readonly archived: ReadonlyArray<ProjectFocusRow>;
} {
  const open: ProjectFocusRow[] = [];
  const done: ProjectFocusRow[] = [];
  const archived: ProjectFocusRow[] = [];
  for (const task of tasks) {
    const row = projectTaskFocusRow(task);
    if (row.state === "archived") archived.push(row);
    else if (row.state === "open") open.push(row);
    else done.push(row);
  }
  return { open, done, archived };
}

export function projectThreadIndexFocusRows(input: {
  readonly threads: ReadonlyArray<ProjectThreadIndexEntry>;
  readonly coordinatorThreadId: ThreadId | null | undefined;
  readonly titlesById: ReadonlyMap<string, string>;
}): {
  readonly open: ReadonlyArray<ProjectFocusRow>;
  readonly archived: ReadonlyArray<ProjectFocusRow>;
} {
  const open: ProjectFocusRow[] = [];
  const archived: ProjectFocusRow[] = [];
  for (const thread of input.threads) {
    if (thread.excluded) continue;
    if (input.coordinatorThreadId && thread.threadId === input.coordinatorThreadId) continue;
    const title = input.titlesById.get(thread.threadId) ?? "Worker thread";
    const row: ProjectFocusRow = {
      id: thread.threadId,
      title,
      detail: null,
      threadId: thread.threadId,
      state: thread.archived ? "archived" : "open",
    };
    if (row.state === "archived") archived.push(row);
    else open.push(row);
  }
  return { open, archived };
}

export function mergeProjectFocusRows(
  tasks: ReturnType<typeof partitionProjectFocusRows>,
  threads: ReturnType<typeof projectThreadIndexFocusRows>,
): ReturnType<typeof partitionProjectFocusRows> {
  const seen = new Set(tasks.open.map((row) => row.threadId).filter(Boolean));
  const extraOpen = threads.open.filter((row) => !row.threadId || !seen.has(row.threadId));
  const archivedIds = new Set(tasks.archived.map((row) => row.threadId).filter(Boolean));
  const extraArchived = threads.archived.filter(
    (row) => !row.threadId || !archivedIds.has(row.threadId),
  );
  return {
    open: [...tasks.open, ...extraOpen],
    done: tasks.done,
    archived: [...tasks.archived, ...extraArchived],
  };
}

export function projectDigestFocusRows(
  items: ReadonlyArray<ProjectDigestFocusItem>,
): ReadonlyArray<ProjectFocusRow> {
  return items.map((item) => ({
    id: item.id,
    title: item.title,
    detail: null,
    threadId: item.sourceThreadId ?? null,
    state: "open",
  }));
}

export function rewriteThreadIdsAsMarkdownLinks(
  text: string,
  threads: ReadonlyArray<{ readonly id: string; readonly title: string }>,
): string {
  if (threads.length === 0 || text.length === 0) return text;
  let next = text;
  for (const thread of threads) {
    const escapedId = thread.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const label = thread.title.trim().length > 0 ? thread.title.trim() : "Thread";
    const markdownLink = `[${label}](thread://${thread.id})`;
    next = next.replace(
      new RegExp(`\\[([^\\]]+)\\]\\(thread://${escapedId}\\)`, "g"),
      markdownLink,
    );
    next = next.replace(new RegExp(`thread://${escapedId}(?!\\))`, "g"), markdownLink);
    next = next.replace(new RegExp(`(?<!\\[|thread://)\\b${escapedId}\\b`, "g"), markdownLink);
  }
  return next;
}
