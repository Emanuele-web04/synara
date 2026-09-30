import { createFileRoute } from "@tanstack/react-router";

import InboxView from "~/components/inbox/InboxView";

export const Route = createFileRoute("/_chat/inbox")({
  component: InboxView,
});
