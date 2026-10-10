import type { RuntimeTaskListItem } from "@synara/contracts";

import {
  makeRuntimeTaskListItem,
  nonEmptyRuntimeTaskListPayload,
  normalizeRuntimeTaskStatus,
} from "./runtimeTaskList.ts";

type ClaudeTrackedTaskStatus = "pending" | "in_progress" | "completed";

export interface ClaudeTrackedTask {
  readonly id: string;
  readonly subject: string;
  readonly description: string | undefined;
  readonly activeForm: string | undefined;
  readonly status: ClaudeTrackedTaskStatus;
  readonly owner: string | undefined;
  readonly blockedBy: ReadonlyArray<string>;
}

interface ClaudeTaskToolCall {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
}

function readTaskString(
  input: Record<string, unknown>,
  ...keys: ReadonlyArray<string>
): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function readTaskId(input: Record<string, unknown>): string | undefined {
  // Claude Code repairs these aliases before execution, but streamed input is raw.
  return readTaskString(input, "taskId", "id", "task_id");
}

function readTrackedTaskStatus(value: unknown): ClaudeTrackedTaskStatus | "deleted" | undefined {
  return value === "pending" ||
    value === "in_progress" ||
    value === "completed" ||
    value === "deleted"
    ? value
    : undefined;
}

function readStringArray(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
  );
}

function parseToolResultValue(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const parsed = parseToolResultValue(entry);
      if (parsed !== undefined) {
        return parsed;
      }
    }
    return undefined;
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (record.type === "text" && typeof record.text === "string") {
    return parseToolResultValue(record.text);
  }
  return record;
}

function parseToolResultRecord(
  block: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const parsed = parseToolResultValue(block.content);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
}

function trackedTaskFromRecord(
  record: Record<string, unknown>,
  previous?: ClaudeTrackedTask,
): ClaudeTrackedTask | undefined {
  const id = readTaskId(record);
  const subject = readTaskString(record, "subject") ?? previous?.subject;
  if (!id || !subject) {
    return undefined;
  }

  const status = readTrackedTaskStatus(record.status);
  if (status === "deleted") {
    return undefined;
  }

  return {
    id,
    subject,
    description: readTaskString(record, "description") ?? previous?.description,
    activeForm: readTaskString(record, "activeForm", "active_form") ?? previous?.activeForm,
    status: status ?? previous?.status ?? "pending",
    owner: readTaskString(record, "owner") ?? previous?.owner,
    blockedBy:
      record.blockedBy !== undefined || record.blocked_by !== undefined
        ? readStringArray(record.blockedBy ?? record.blocked_by)
        : (previous?.blockedBy ?? []),
  };
}

function mergeTaskUpdate(
  existing: ClaudeTrackedTask,
  input: Record<string, unknown>,
): ClaudeTrackedTask {
  const status = readTrackedTaskStatus(input.status);
  const addedBlockedBy = readStringArray(input.addBlockedBy ?? input.add_blocked_by);
  return {
    ...existing,
    subject: readTaskString(input, "subject") ?? existing.subject,
    description: readTaskString(input, "description") ?? existing.description,
    activeForm: readTaskString(input, "activeForm", "active_form") ?? existing.activeForm,
    status: status && status !== "deleted" ? status : existing.status,
    owner: readTaskString(input, "owner") ?? existing.owner,
    blockedBy:
      addedBlockedBy.length > 0
        ? Array.from(new Set([...existing.blockedBy, ...addedBlockedBy]))
        : existing.blockedBy,
  };
}

export function parseClaudeTrackedTasks(value: unknown): ReadonlyArray<ClaudeTrackedTask> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) =>
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? trackedTaskFromRecord(entry as Record<string, unknown>)
        : undefined,
    )
    .filter((task): task is ClaudeTrackedTask => task !== undefined);
}

export function normalizeClaudeTodoTasks(input: Record<string, unknown>): {
  readonly tasks: ReadonlyArray<RuntimeTaskListItem>;
} | null {
  const todos = Array.isArray(input.todos) ? input.todos : null;
  if (!todos) {
    return null;
  }

  const tasks = todos.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const todo = entry as Record<string, unknown>;
    const status = normalizeRuntimeTaskStatus(todo.status);
    const content = readTaskString(todo, "content");
    const activeForm = readTaskString(todo, "activeForm");
    const task = status === "inProgress" ? (activeForm ?? content) : (content ?? activeForm);
    const item = makeRuntimeTaskListItem(task, status);
    return item ? [item] : [];
  });

  return nonEmptyRuntimeTaskListPayload(tasks);
}

export function applyClaudeTaskToolResult(
  tasks: Map<string, ClaudeTrackedTask>,
  tool: ClaudeTaskToolCall,
  resultBlock: Record<string, unknown>,
  structuredResult: unknown,
  isError: boolean,
): boolean {
  if (isError) {
    return false;
  }

  const parsedStructuredResult = parseToolResultValue(structuredResult);
  const result =
    parsedStructuredResult &&
    typeof parsedStructuredResult === "object" &&
    !Array.isArray(parsedStructuredResult)
      ? (parsedStructuredResult as Record<string, unknown>)
      : parseToolResultRecord(resultBlock);

  switch (tool.toolName) {
    case "TaskCreate": {
      const resultTask =
        result?.task && typeof result.task === "object" && !Array.isArray(result.task)
          ? (result.task as Record<string, unknown>)
          : undefined;
      if (!resultTask) {
        return false;
      }
      const id = readTaskId(resultTask);
      const subject =
        readTaskString(resultTask, "subject") ?? readTaskString(tool.input, "subject");
      if (!id || !subject) {
        return false;
      }
      tasks.set(id, {
        id,
        subject,
        description: readTaskString(tool.input, "description"),
        activeForm: readTaskString(tool.input, "activeForm", "active_form"),
        status: "pending",
        owner: undefined,
        blockedBy: [],
      });
      return true;
    }

    case "TaskUpdate": {
      if (result?.success === false) {
        return false;
      }
      const taskId = readTaskId(tool.input);
      if (!taskId) {
        return false;
      }
      const status = readTrackedTaskStatus(tool.input.status);
      if (status === "deleted") {
        return tasks.delete(taskId);
      }
      const existing = tasks.get(taskId);
      if (!existing) {
        const subject = readTaskString(tool.input, "subject");
        if (!subject) {
          return false;
        }
        tasks.set(taskId, {
          id: taskId,
          subject,
          description: readTaskString(tool.input, "description"),
          activeForm: readTaskString(tool.input, "activeForm", "active_form"),
          status: status ?? "pending",
          owner: readTaskString(tool.input, "owner"),
          blockedBy: readStringArray(tool.input.addBlockedBy ?? tool.input.add_blocked_by),
        });
        return true;
      }
      tasks.set(taskId, mergeTaskUpdate(existing, tool.input));
      return true;
    }

    case "TaskGet": {
      if (!result || !("task" in result)) {
        return false;
      }
      const requestedTaskId = readTaskId(tool.input);
      if (result.task === null) {
        return requestedTaskId ? tasks.delete(requestedTaskId) : false;
      }
      if (typeof result.task !== "object" || Array.isArray(result.task)) {
        return false;
      }
      const taskRecord = result.task as Record<string, unknown>;
      const taskId = readTaskId(taskRecord);
      const task = trackedTaskFromRecord(taskRecord, taskId ? tasks.get(taskId) : undefined);
      if (!task) {
        return false;
      }
      tasks.set(task.id, task);
      return true;
    }

    case "TaskList": {
      if (!result || !Array.isArray(result.tasks)) {
        return false;
      }
      const snapshot = new Map<string, ClaudeTrackedTask>();
      for (const entry of result.tasks) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          continue;
        }
        const record = entry as Record<string, unknown>;
        const taskId = readTaskId(record);
        const task = trackedTaskFromRecord(record, taskId ? tasks.get(taskId) : undefined);
        if (task) {
          snapshot.set(task.id, task);
        }
      }
      tasks.clear();
      for (const [taskId, task] of snapshot) {
        tasks.set(taskId, task);
      }
      return true;
    }

    default:
      return false;
  }
}

export function claudeTrackedTasksPayload(tasks: ReadonlyMap<string, ClaudeTrackedTask>): {
  readonly tasks: ReadonlyArray<RuntimeTaskListItem>;
} {
  return {
    tasks: Array.from(tasks.values(), (task) =>
      makeRuntimeTaskListItem(
        task.status === "in_progress" ? (task.activeForm ?? task.subject) : task.subject,
        task.status,
      ),
    ).filter((task): task is RuntimeTaskListItem => task !== null),
  };
}

export function hasOnlyCompletedClaudeTasks(
  tasks: ReadonlyMap<string, ClaudeTrackedTask>,
): boolean {
  if (tasks.size === 0) {
    return false;
  }
  for (const task of tasks.values()) {
    if (task.status !== "completed") {
      return false;
    }
  }
  return true;
}

export function hasUnfinishedClaudeTasks(tasks: ReadonlyMap<string, ClaudeTrackedTask>): boolean {
  for (const task of tasks.values()) {
    if (task.status !== "completed") {
      return true;
    }
  }
  return false;
}
