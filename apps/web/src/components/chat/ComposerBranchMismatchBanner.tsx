import { ArrowRightIcon, TriangleAlertIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ComposerStackedPanel } from "./ComposerStackedPanel";
import { COMPOSER_NOTICE_CONTENT_CLASS_NAME } from "./composerStackedPanelStyles";

export function ComposerBranchMismatchBanner({
  threadBranch,
  currentBranch,
}: {
  threadBranch: string;
  currentBranch: string;
}) {
  return (
    <ComposerStackedPanel
      detached
      className={cn(COMPOSER_NOTICE_CONTENT_CLASS_NAME, "flex items-center gap-3")}
      data-testid="composer-branch-mismatch-warning"
      role="status"
    >
      <TriangleAlertIcon
        aria-hidden="true"
        className="size-4.5 shrink-0 text-[var(--color-text-foreground-secondary)]"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-ui-sm leading-5 font-medium text-foreground/95">
          Sending a message will move this thread to the current branch
        </p>
        <div className="mt-0.5 flex min-w-0 items-center gap-2 text-ui-sm leading-5">
          <code
            className="max-w-[40%] truncate text-muted-foreground/80"
            title={`Thread branch: ${threadBranch}`}
          >
            {threadBranch}
          </code>
          <ArrowRightIcon aria-hidden="true" className="size-3 shrink-0 text-muted-foreground/50" />
          <code
            className="min-w-0 truncate font-medium text-foreground/85"
            title={`Current branch: ${currentBranch}`}
          >
            {currentBranch}
          </code>
        </div>
      </div>
    </ComposerStackedPanel>
  );
}
