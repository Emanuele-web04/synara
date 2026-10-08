// FILE: TasksViewSwitch.tsx
// Purpose: The List / Kanban switch shown in the Tasks and Kanban headers where both views
//          exist. Picking one opens it and makes it what the Tasks entry opens next.
// Layer: Tasks UI component
// Exports: TasksViewSwitch

import { useNavigate } from "@tanstack/react-router";

import { type TasksViewMode, useAppSettings } from "~/appSettings";
import { FilterPillGroup } from "~/components/FilterPillGroup";
import { useTasksSurfaceEnabled } from "~/tasksSurface";

const VIEW_OPTIONS: ReadonlyArray<{ value: TasksViewMode; label: string }> = [
  { value: "list", label: "List" },
  { value: "kanban", label: "Kanban" },
];

export function TasksViewSwitch({ current }: { current: TasksViewMode }) {
  const navigate = useNavigate();
  const { updateSettings } = useAppSettings();
  const tasksSurfaceEnabled = useTasksSurfaceEnabled();
  if (!tasksSurfaceEnabled) return null;
  return (
    <FilterPillGroup
      ariaLabel="View"
      value={current}
      options={VIEW_OPTIONS}
      onChange={(view) => {
        if (view === current) return;
        updateSettings({ tasksViewMode: view });
        void navigate({ to: view === "kanban" ? "/kanban" : "/tasks" });
      }}
    />
  );
}
