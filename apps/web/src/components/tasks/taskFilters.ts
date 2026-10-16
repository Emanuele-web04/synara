import type { Todo } from "@synara/contracts";

export interface TaskFilters {
  source: "all" | "local" | "notion";
  project: string;
  status: string;
  assignee: string;
}

export const EMPTY_TASK_FILTERS: TaskFilters = {
  source: "all",
  project: "",
  status: "",
  assignee: "",
};

export function taskProjectKey(todo: Pick<Todo, "projectId">): string {
  return JSON.stringify(todo.projectId);
}

export function notionStatusKey(external: NonNullable<Todo["external"]>): string {
  // Notion status IDs belong to a data source, not to the agent's execution state.
  return JSON.stringify([
    external.connectionId,
    external.dataSourceId,
    external.statusId ?? external.status,
  ]);
}

export function notionAssigneeKey(connectionId: string, userId: string): string {
  return JSON.stringify([connectionId, userId]);
}

export function matchesTaskFilters(todo: Todo, filters: TaskFilters): boolean {
  const external = todo.external;
  if (filters.source === "local" && external) return false;
  if (filters.source === "notion" && !external) return false;
  if (filters.project && taskProjectKey(todo) !== filters.project) return false;
  if (filters.status && (!external || notionStatusKey(external) !== filters.status)) return false;
  if (
    filters.assignee &&
    !external?.assigneeIds.some(
      (id) => notionAssigneeKey(external.connectionId, id) === filters.assignee,
    )
  ) {
    return false;
  }
  return true;
}

export function countTaskFilters(filters: TaskFilters): number {
  return (
    Number(filters.source !== "all") +
    Number(Boolean(filters.project)) +
    Number(Boolean(filters.status)) +
    Number(Boolean(filters.assignee))
  );
}

export function describeNotionTask(external: NonNullable<Todo["external"]>): string {
  const parts = ["Notion", external.workspaceName];
  if (external.status) parts.push(`Status: ${external.status}`);
  if (external.assignees.length) parts.push(`Assigned to ${external.assignees.join(", ")}`);
  if (external.syncState !== "synced") parts.push(`Sync: ${external.syncState}`);
  return parts.join(" · ");
}
