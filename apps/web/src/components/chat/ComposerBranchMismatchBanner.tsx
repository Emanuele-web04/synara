// FILE: ComposerBranchMismatchBanner.tsx
// Purpose: Explains when sending from a settled local thread will resume on the
//          directory's current branch instead of the thread's last branch.
// Layer: Chat composer UI
// Exports: ComposerBranchMismatchBanner

import { ArrowRightIcon, TriangleAlertIcon } from "~/lib/icons";

export function ComposerBranchMismatchBanner({
  threadBranch,
  currentBranch,
}: {
  threadBranch: string;
  currentBranch: string;
}) {
  return (
    <div
      className="flex min-w-0 items-center gap-2.5 px-3 py-2"
      data-testid="composer-branch-mismatch-warning"
      role="status"
    >
      <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-warning/8 text-warning">
        <TriangleAlertIcon aria-hidden="true" className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[length:var(--app-font-size-ui,12px)] leading-4 font-medium text-foreground/90">
          Sending a message will move this thread to the current branch
        </p>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[length:var(--app-font-size-ui-sm,11px)] leading-4">
          <code
            className="max-w-[40%] truncate text-muted-foreground/75"
            title={`Thread branch: ${threadBranch}`}
          >
            {threadBranch}
          </code>
          <ArrowRightIcon aria-hidden="true" className="size-3 shrink-0 text-muted-foreground/40" />
          <code
            className="min-w-0 truncate font-medium text-foreground/80"
            title={`Current branch: ${currentBranch}`}
          >
            {currentBranch}
          </code>
        </div>
      </div>
    </div>
  );
}
