import type { PullRequestCheckStatus } from "@synara/contracts";

import { CircleAlertIcon, CircleCheckIcon, Loader2Icon } from "~/lib/icons";

export function PullRequestCheckStatusIcon({ status }: { status: PullRequestCheckStatus }) {
  switch (status) {
    case "pending":
      return <Loader2Icon className="size-3.5 shrink-0 animate-spin text-warning" aria-hidden />;
    case "success":
      return <CircleCheckIcon className="size-3.5 shrink-0 text-success" aria-hidden />;
    case "failure":
    case "cancelled":
      return <CircleAlertIcon className="size-3.5 shrink-0 text-destructive" aria-hidden />;
    default:
      return (
        <span
          className="size-3 shrink-0 rounded-full border border-dashed border-current opacity-50"
          aria-hidden
        />
      );
  }
}
