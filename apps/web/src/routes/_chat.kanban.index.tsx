import { createFileRoute, redirect } from "@tanstack/react-router";

import KanbanView from "~/components/kanban/KanbanView";
import { isTasksSurfaceEnabled } from "~/tasksSurface";

function KanbanOverviewRouteView() {
  return <KanbanView projectId={null} />;
}

export const Route = createFileRoute("/_chat/kanban/")({
  // Beta replaces Kanban with Tasks; old links land there instead.
  beforeLoad: () => {
    if (isTasksSurfaceEnabled()) throw redirect({ to: "/tasks", replace: true });
  },
  component: KanbanOverviewRouteView,
});
