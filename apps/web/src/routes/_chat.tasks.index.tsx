import { createFileRoute, redirect } from "@tanstack/react-router";

import TasksView from "~/components/tasks/TasksView";
import { TASKS_SURFACE_ENABLED } from "~/sidebarNavOrdering";

export const Route = createFileRoute("/_chat/tasks/")({
  // Tasks is Beta-only; Stable keeps Kanban in its place.
  beforeLoad: () => {
    if (!TASKS_SURFACE_ENABLED) throw redirect({ to: "/kanban", replace: true });
  },
  component: TasksView,
});
