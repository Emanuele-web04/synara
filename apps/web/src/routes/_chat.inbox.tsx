import { createFileRoute, redirect } from "@tanstack/react-router";

import { INBOX_ON } from "~/betaFeatures";
import InboxView from "~/components/inbox/InboxView";

export const Route = createFileRoute("/_chat/inbox")({
  beforeLoad: () => {
    if (!INBOX_ON) throw redirect({ to: "/", replace: true });
  },
  component: InboxView,
});
