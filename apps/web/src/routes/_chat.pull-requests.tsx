import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_chat/pull-requests")({
  component: PullRequestsLayout,
});

function PullRequestsLayout() {
  return <Outlet />;
}
