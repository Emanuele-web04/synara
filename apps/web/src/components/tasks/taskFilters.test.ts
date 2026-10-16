import { ProjectId, TodoId, type NotionTodoReference, type Todo } from "@synara/contracts";
import { describe, expect, it } from "vitest";
import {
  countTaskFilters,
  describeNotionTask,
  EMPTY_TASK_FILTERS,
  matchesTaskFilters,
  notionAssigneeKey,
  notionStatusKey,
  taskProjectKey,
  type TaskFilters,
} from "./taskFilters";

function reference(overrides: Partial<NotionTodoReference> = {}): NotionTodoReference {
  return {
    provider: "notion",
    connectionId: "workspace-a",
    mappingId: "mapping-a",
    dataSourceId: "11111111-1111-4111-8111-111111111111",
    pageId: "22222222-2222-4222-8222-222222222222",
    url: "https://www.notion.so/22222222222242228222222222222222",
    workspaceName: "Engineering",
    status: "In progress",
    statusId: "doing",
    assignees: ["Alex", "Alex"],
    assigneeIds: ["person-a", "person-b"],
    sprintIds: [],
    epicIds: [],
    milestoneIds: [],
    dependencyIds: [],
    subtaskIds: [],
    startDate: null,
    storyPoints: null,
    syncState: "synced",
    syncMessage: null,
    writableFields: ["title", "notes"],
    ...overrides,
  };
}

function task(overrides: Partial<Todo> = {}): Todo {
  return {
    id: TodoId.makeUnsafe("task-a"),
    title: "Review OAuth permissions",
    notes: "",
    priority: "none",
    projectId: ProjectId.makeUnsafe("project-a"),
    dueDate: null,
    threadId: null,
    delegationBaseTurnId: null,
    linkedAt: null,
    completedAt: null,
    createdAt: "2026-10-16T08:00:00.000Z",
    updatedAt: "2026-10-16T08:00:00.000Z",
    ...overrides,
  };
}

function accepts(external: NotionTodoReference, filters: Partial<TaskFilters>): boolean {
  return matchesTaskFilters(task({ external }), { ...EMPTY_TASK_FILTERS, ...filters });
}

describe("Notion task discovery filters", () => {
  it("leaves local and imported tasks visible by default", () => {
    expect(matchesTaskFilters(task(), EMPTY_TASK_FILTERS)).toBe(true);
    expect(accepts(reference(), EMPTY_TASK_FILTERS)).toBe(true);
  });

  it("separates sources without creating copies", () => {
    const local = task();
    const imported = task({ external: reference() });
    const rows = [local, imported];
    const filters: TaskFilters = { ...EMPTY_TASK_FILTERS, source: "local" };
    expect(rows.filter((todo) => matchesTaskFilters(todo, filters))).toEqual([local]);
    expect(accepts(reference(), { source: "notion" })).toBe(true);
    expect(matchesTaskFilters(local, { ...filters, source: "notion" })).toBe(false);
  });

  it("distinguishes no project from all projects", () => {
    const noProject = task({ projectId: null });
    const filters = { ...EMPTY_TASK_FILTERS, project: taskProjectKey(noProject) };
    expect(matchesTaskFilters(noProject, filters)).toBe(true);
    expect(matchesTaskFilters(task(), filters)).toBe(false);
  });

  it("scopes remote status IDs to their connection and data source", () => {
    const filters = { status: notionStatusKey(reference()) };
    expect(accepts(reference(), filters)).toBe(true);
    expect(accepts(reference({ connectionId: "workspace-b" }), filters)).toBe(false);
    const otherSource = reference({ dataSourceId: "33333333-3333-4333-8333-333333333333" });
    expect(accepts(otherSource, filters)).toBe(false);
    expect(matchesTaskFilters(task(), { ...EMPTY_TASK_FILTERS, ...filters })).toBe(false);
  });

  it("does not confuse people with identical names or IDs from another connection", () => {
    const filters = { assignee: notionAssigneeKey("workspace-a", "person-b") };
    expect(accepts(reference(), filters)).toBe(true);
    const otherPerson = reference({ assigneeIds: ["person-a"], assignees: ["Alex"] });
    expect(accepts(otherPerson, filters)).toBe(false);
    expect(accepts(reference({ connectionId: "workspace-b" }), filters)).toBe(false);
  });

  it("does not infer the current Notion user from a display name", () => {
    expect(accepts(reference(), { assignee: notionAssigneeKey("workspace-a", "Alex") })).toBe(false);
  });

  it("keeps remote status independent of local completion", () => {
    const external = reference();
    const filters = { ...EMPTY_TASK_FILTERS, status: notionStatusKey(external) };
    const completed = task({ external, completedAt: "2026-10-16T09:00:00.000Z" });
    expect(matchesTaskFilters(completed, filters)).toBe(true);
  });

  it("combines filters and leaves task data unchanged", () => {
    const todo = task({ external: reference() });
    const original = structuredClone(todo);
    expect(matchesTaskFilters(todo, {
      source: "notion",
      project: taskProjectKey(todo),
      status: notionStatusKey(reference()),
      assignee: notionAssigneeKey("workspace-a", "person-a"),
    })).toBe(true);
    expect(accepts(reference(), { source: "local" })).toBe(false);
    expect(todo).toEqual(original);
  });

  it("includes a new assignment in the next list projection", () => {
    const filters = {
      ...EMPTY_TASK_FILTERS,
      assignee: notionAssigneeKey("workspace-a", "person-b"),
    };
    const rows = [task()];
    expect(rows.filter((todo) => matchesTaskFilters(todo, filters))).toHaveLength(0);
    const incoming = task({ id: TodoId.makeUnsafe("incoming"), external: reference() });
    rows.push(incoming);
    expect(rows.filter((todo) => matchesTaskFilters(todo, filters))).toEqual([incoming]);
  });

  it("counts active controls", () => {
    expect(countTaskFilters(EMPTY_TASK_FILTERS)).toBe(0);
    const filters: TaskFilters = { source: "notion", project: "null", status: "s", assignee: "a" };
    expect(countTaskFilters(filters)).toBe(4);
  });

  it("describes source, ownership, remote status and conflicts separately", () => {
    expect(describeNotionTask(reference({ syncState: "conflict" }))).toBe(
      "Notion · Engineering · Status: In progress · Assigned to Alex, Alex · Sync: conflict",
    );
  });
});
