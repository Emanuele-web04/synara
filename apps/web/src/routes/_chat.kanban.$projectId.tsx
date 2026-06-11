import { createFileRoute } from "@tanstack/react-router";

import KanbanView from "~/components/kanban/KanbanView";

function KanbanProjectRouteView() {
  const { projectId } = Route.useParams();
  return <KanbanView projectId={projectId} />;
}

export const Route = createFileRoute("/_chat/kanban/$projectId")({
  component: KanbanProjectRouteView,
});
