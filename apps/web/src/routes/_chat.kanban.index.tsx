import { createFileRoute } from "@tanstack/react-router";

import KanbanView from "~/components/kanban/KanbanView";

function KanbanOverviewRouteView() {
  return <KanbanView projectId={null} />;
}

export const Route = createFileRoute("/_chat/kanban/")({
  component: KanbanOverviewRouteView,
});
