import type { Todo } from "@synara/contracts";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { NotionSelect } from "../notion/notionUi";
import {
  countTaskFilters,
  EMPTY_TASK_FILTERS,
  notionAssigneeKey,
  notionStatusKey,
  taskProjectKey,
  type TaskFilters,
} from "./taskFilters";

type Option = { value: string; label: string };

function choices(label: string, options: Map<string, string>, selected: string): Option[] {
  const result = [...options].map(([value, name]) => ({ value, label: name }));
  result.sort((a, b) => a.label.localeCompare(b.label));
  if (selected && !options.has(selected)) {
    result.push({ value: selected, label: "Unavailable selection" });
  }
  return [{ value: "", label }, ...result];
}

export function TaskListFilters({
  todos,
  projects,
  value,
  onChange,
}: {
  todos: readonly Todo[];
  projects: readonly { id: string; name: string }[];
  value: TaskFilters;
  onChange: (value: TaskFilters) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const active = countTaskFilters(value);
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  const projectOptions = new Map<string, string>();
  const statuses = new Map<string, string>();
  const assignees = new Map<string, string>();
  for (const todo of todos) {
    projectOptions.set(
      taskProjectKey(todo),
      todo.projectId === null ? "No project" : (projectNames.get(todo.projectId) ?? "Project"),
    );
    const external = todo.external;
    if (!external) continue;
    statuses.set(
      notionStatusKey(external),
      `${external.status ?? "No mapped status"} · ${external.workspaceName}`,
    );
    external.assigneeIds.forEach((id, index) => {
      assignees.set(
        notionAssigneeKey(external.connectionId, id),
        `${external.assignees[index] ?? id} · ${external.workspaceName}`,
      );
    });
  }
  return (
    <div className="space-y-3 px-3">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          Filter tasks{active ? ` (${active})` : ""}
        </Button>
        {active ? (
          <Button variant="ghost" size="sm" onClick={() => onChange({ ...EMPTY_TASK_FILTERS })}>
            Clear filters
          </Button>
        ) : null}
      </div>
      {expanded ? (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <NotionSelect
            label="Task source"
            value={value.source}
            options={[
              { value: "all", label: "All sources" },
              { value: "local", label: "Local Synara tasks" },
              { value: "notion", label: "Notion tasks" },
            ]}
            onChange={(source) => {
              if (source !== "all" && source !== "local" && source !== "notion") return;
              onChange({
                ...value,
                source,
                ...(source === "local" ? { status: "", assignee: "" } : {}),
              });
            }}
          />
          <NotionSelect
            label="Task project"
            value={value.project}
            options={choices("All projects", projectOptions, value.project)}
            onChange={(project) => onChange({ ...value, project })}
          />
          {value.source !== "local" ? (
            <>
              <NotionSelect
                label="Notion status"
                value={value.status}
                options={choices("All Notion statuses", statuses, value.status)}
                onChange={(status) => onChange({ ...value, status })}
              />
              <NotionSelect
                label="Notion assignee"
                value={value.assignee}
                options={choices("All Notion assignees", assignees, value.assignee)}
                onChange={(assignee) => onChange({ ...value, assignee })}
              />
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
