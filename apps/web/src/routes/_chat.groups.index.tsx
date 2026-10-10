// Legacy Groups links open the renamed Hubs surface.
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_chat/groups/")({
  beforeLoad: () => {
    throw redirect({ to: "/hubs", replace: true });
  },
});
