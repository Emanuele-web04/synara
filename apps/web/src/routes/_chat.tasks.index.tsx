import { createFileRoute, redirect } from "@tanstack/react-router";

import TasksView from "~/components/tasks/TasksView";
import { isTasksSurfaceEnabled } from "~/tasksSurface";

export const Route = createFileRoute("/_chat/tasks/")({
  // Older servers without Tasks fall back to Kanban.
  beforeLoad: () => {
    if (!isTasksSurfaceEnabled()) throw redirect({ to: "/kanban", replace: true });
  },
  component: TasksView,
});
