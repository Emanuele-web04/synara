import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_chat/automations")({
  component: AutomationsLayout,
});

// Layout-only route so /automations (index) and /automations/$automationId (detail)
// each render as their own full page rather than nesting one inside the other.
function AutomationsLayout() {
  return <Outlet />;
}
