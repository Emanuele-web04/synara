import { memo, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import {
  buildCollapsedProposedPlanPreviewMarkdown,
  proposedPlanTitle,
  stripDisplayedPlanMarkdown,
} from "../../proposedPlan";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { ProposedPlanActions } from "./ProposedPlanActions";

export const ProposedPlanCard = memo(function ProposedPlanCard({
  planMarkdown,
  cwd,
  workspaceRoot,
  chatTypographyStyle,
}: {
  planMarkdown: string;
  cwd: string | undefined;
  workspaceRoot: string | undefined;
  chatTypographyStyle?: CSSProperties;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const title = proposedPlanTitle(planMarkdown) ?? t("chat.planCard.proposedPlan");
  const lineCount = planMarkdown.split("\n").length;
  const canCollapse = planMarkdown.length > 900 || lineCount > 20;
  const displayedPlanMarkdown = stripDisplayedPlanMarkdown(planMarkdown);
  const collapsedPreview = canCollapse
    ? buildCollapsedProposedPlanPreviewMarkdown(planMarkdown, { maxLines: 10 })
    : null;
  return (
    <div className="rounded-[24px] border border-border/80 bg-card/70 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge variant="secondary">{t("chat.planCard.planBadge")}</Badge>
          <p className="truncate text-sm font-medium text-foreground">{title}</p>
        </div>
        <ProposedPlanActions planMarkdown={planMarkdown} workspaceRoot={workspaceRoot} />
      </div>
      <div className="mt-4">
        <div className={cn("relative", canCollapse && !expanded && "max-h-104 overflow-hidden")}>
          {canCollapse && !expanded ? (
            <ChatMarkdown
              text={collapsedPreview ?? ""}
              cwd={cwd}
              isStreaming={false}
              style={chatTypographyStyle}
            />
          ) : (
            <ChatMarkdown
              text={displayedPlanMarkdown}
              cwd={cwd}
              isStreaming={false}
              style={chatTypographyStyle}
            />
          )}
          {canCollapse && !expanded ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-linear-to-t from-card/95 via-card/80 to-transparent" />
          ) : null}
        </div>
        {canCollapse ? (
          <div className="mt-4 flex justify-center">
            <Button
              size="sm"
              variant="outline"
              data-scroll-anchor-ignore
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? t("chat.planCard.collapsePlan") : t("chat.planCard.expandPlan")}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
});
