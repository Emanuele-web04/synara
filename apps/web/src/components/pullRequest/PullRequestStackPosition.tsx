// FILE: PullRequestStackPosition.tsx
// Purpose: Shared compact stack-position indicator for pull request list and detail surfaces.
// Layer: Pull request presentation
// Exports: PullRequestStackPosition

import type { PullRequestStackSummary } from "@synara/contracts";

import { Badge } from "~/components/ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { GitForkIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useTranslation, t } from "~/i18n";

type StackPosition = Pick<PullRequestStackSummary, "number" | "size" | "position" | "baseBranch">;

function stackPositionAriaLabel(stack: StackPosition): string {
  return t("git:stackPullRequestOf", {
    value0: stack.number,
    value1: stack.position,
    value2: stack.size,
  });
}

function StackPositionContents({ stack }: { stack: StackPosition }) {
  return (
    <>
      <GitForkIcon className="size-3" aria-hidden />
      <span className="tabular-nums">
        {stack.position}/{stack.size}
      </span>
    </>
  );
}

export function PullRequestStackPosition({
  stack,
  appearance = "badge",
  className,
}: {
  stack: StackPosition;
  appearance?: "badge" | "plain";
  className?: string;
}) {
  const { t } = useTranslation();

  if (appearance === "plain") {
    return (
      <span className={cn("inline-flex items-center gap-1.5", className)} aria-hidden="true">
        <StackPositionContents stack={stack} />
      </span>
    );
  }

  const label = stackPositionAriaLabel(stack);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge
            variant="outline"
            size="sm"
            aria-label={label}
            className={cn("gap-1 font-normal text-muted-foreground", className)}
          >
            <StackPositionContents stack={stack} />
          </Badge>
        }
      />
      <TooltipPopup side="top">
        {t("git:stack")}
        {stack.number} {t("git:pR")} {stack.position} {t("onboarding:of")} {stack.size}{" "}
        {t("git:targets")} {stack.baseBranch}
      </TooltipPopup>
    </Tooltip>
  );
}
