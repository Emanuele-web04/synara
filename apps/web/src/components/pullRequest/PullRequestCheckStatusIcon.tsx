// FILE: PullRequestCheckStatusIcon.tsx
// Purpose: Status glyph for a single pull request check, shared by the Summary tab rows and
//          the environment checks menu so both surfaces read identically.
// Layer: Pull request presentation
// Exports: PullRequestCheckStatusIcon

import type { PullRequestCheckStatus } from "@synara/contracts";

import { CentralIcon } from "~/lib/central-icons";
import { Loader2Icon } from "~/lib/icons";
import { cn } from "~/lib/utils";

// One footprint for every branch: the glyphs head a row of text and must share an optical
// box, so the dashed placeholder is centered inside the same size rather than sized down.
const CHECK_STATUS_ICON_CLASS = "size-4 shrink-0";

// `--status-*` already resolves to the role color in light and to a lighter tint of it in dark
// (see index.css), so these need no `dark:` step of their own.
const CHECK_SUCCESS_COLOR_CLASS = "text-status-success";
const CHECK_FAILURE_COLOR_CLASS = "text-status-failure";

export function PullRequestCheckStatusIcon({ status }: { status: PullRequestCheckStatus }) {
  switch (status) {
    case "pending":
      return (
        <Loader2Icon
          className={cn(CHECK_STATUS_ICON_CLASS, "animate-spin text-warning")}
          aria-hidden
        />
      );
    case "success":
      return (
        <CentralIcon
          name="circle-check"
          variant="fill"
          className={cn(CHECK_STATUS_ICON_CLASS, CHECK_SUCCESS_COLOR_CLASS)}
        />
      );
    case "failure":
    case "cancelled":
      return (
        <CentralIcon
          name="circle-x"
          variant="fill"
          className={cn(CHECK_STATUS_ICON_CLASS, CHECK_FAILURE_COLOR_CLASS)}
        />
      );
    default:
      return (
        <span className={cn(CHECK_STATUS_ICON_CLASS, "flex items-center justify-center")}>
          <span
            className="size-3.5 rounded-full border border-dashed border-current opacity-50"
            aria-hidden
          />
        </span>
      );
  }
}
