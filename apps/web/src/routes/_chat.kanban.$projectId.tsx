import { createFileRoute, redirect } from "@tanstack/react-router";

import KanbanView from "~/components/kanban/KanbanView";
import { isTasksSurfaceEnabled } from "~/tasksSurface";

function KanbanProjectRouteView() {
  const { projectId } = Route.useParams();
  return <KanbanView projectId={projectId} />;
}

export const Route = createFileRoute("/_chat/kanban/$projectId")({
  // Beta replaces Kanban with Tasks; old links land there instead.
  beforeLoad: () => {
    if (isTasksSurfaceEnabled()) throw redirect({ to: "/tasks", replace: true });
  },
  component: KanbanProjectRouteView,
});
