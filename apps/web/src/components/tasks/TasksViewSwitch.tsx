// FILE: TasksViewSwitch.tsx
// Purpose: The List / Kanban switch shown in the Tasks and Kanban headers where both views
//          exist. Picking one opens it and makes it what the Tasks entry opens next.
// Layer: Tasks UI component
// Exports: TasksViewSwitch

import { useNavigate } from "@tanstack/react-router";

import { type TasksViewMode, useAppSettings } from "~/appSettings";
import { FilterPillGroup } from "~/components/FilterPillGroup";
import { useTasksSurfaceEnabled } from "~/tasksSurface";
import { useTranslation } from "~/i18n";

const VIEW_OPTIONS: ReadonlyArray<{ value: TasksViewMode; labelKey: string }> = [
  { value: "list", labelKey: "workspace:list" },
  { value: "kanban", labelKey: "workspace:view_kanban" },
];

export function TasksViewSwitch({ current }: { current: TasksViewMode }) {
  const { t } = useTranslation();

  const navigate = useNavigate();
  const { updateSettings } = useAppSettings();
  const tasksSurfaceEnabled = useTasksSurfaceEnabled();
  if (!tasksSurfaceEnabled) return null;
  return (
    <FilterPillGroup
      ariaLabel={t("common:diff_view")}
      value={current}
      options={VIEW_OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey) }))}
      onChange={(view) => {
        if (view === current) return;
        updateSettings({ tasksViewMode: view });
        void navigate({ to: view === "kanban" ? "/kanban" : "/tasks" });
      }}
    />
  );
}
