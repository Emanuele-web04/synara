import { createFileRoute, redirect } from "@tanstack/react-router";

import KanbanView from "~/components/kanban/KanbanView";
import { TASKS_SURFACE_ENABLED } from "~/sidebarNavOrdering";

function KanbanOverviewRouteView() {
  return <KanbanView projectId={null} />;
}

export const Route = createFileRoute("/_chat/kanban/")({
  // Beta replaces Kanban with Tasks; old links land there instead.
  beforeLoad: () => {
    if (TASKS_SURFACE_ENABLED) throw redirect({ to: "/tasks", replace: true });
  },
  component: KanbanOverviewRouteView,
});
