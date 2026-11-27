import { useState } from "react";
import { type TimestampFormat } from "../appSettings";
import { DisclosureChevron } from "./ui/DisclosureChevron";
import { DisclosureRegion } from "./ui/DisclosureRegion";
import { ScrollArea } from "./ui/scroll-area";
import ChatMarkdown from "./ChatMarkdown";
import { ListTodoIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { MUTED_LABEL_TEXT_CLASS_NAME, SOFT_SURFACE_FILL_CLASS_NAME } from "~/surfaceStyles";
import { SETTINGS_SECTION_LABEL_CLASS_NAME } from "~/settingsPanelStyles";
import type { ActiveTaskListState } from "../session-logic";
import type { LatestProposedPlanState } from "../session-logic";
import { formatTimestamp } from "../timestampFormat";
import { proposedPlanTitle, stripDisplayedPlanMarkdown } from "../proposedPlan";
import { ProposedPlanActions } from "./chat/ProposedPlanActions";
import { DockPaneHeader } from "./chat/DockPaneHeader";
import { TaskProgressSteps } from "./chat/TaskProgressSteps";
import { SettingsEmptyState } from "./settings/SettingsPanelPrimitives";
import { useTranslation } from "~/i18n";

interface PlanSidebarProps {
  activeTaskList: ActiveTaskListState | null;
  activeProposedPlan: LatestProposedPlanState | null;
  markdownCwd: string | undefined;
  workspaceRoot: string | undefined;
  timestampFormat: TimestampFormat;
  onClose: () => void;
}

const PlanSidebar = function PlanSidebar({
  activeTaskList,
  activeProposedPlan,
  markdownCwd,
  workspaceRoot,
  timestampFormat,
  onClose,
}: PlanSidebarProps) {
  const { t, formatLocale } = useTranslation();

  const [proposedPlanExpanded, setProposedPlanExpanded] = useState(false);
  const planMarkdown = activeProposedPlan?.planMarkdown ?? null;
  const displayedPlanMarkdown = planMarkdown ? stripDisplayedPlanMarkdown(planMarkdown) : null;
  const planTitle = planMarkdown ? proposedPlanTitle(planMarkdown) : null;

  return (
    <div className="flex h-full w-[340px] shrink-0 flex-col border-l border-[color:var(--color-border)]">
      {/* Header */}
      <DockPaneHeader
        title={
          <span className="flex min-w-0 items-center gap-2">
            <span>{t("workspace:plan_badge")}</span>
            {activeTaskList ? (
              <span className="truncate text-ui-sm font-normal text-muted-foreground">
                {formatTimestamp(activeTaskList.createdAt, timestampFormat, formatLocale)}
              </span>
            ) : null}
          </span>
        }
        leadingIcon={<ListTodoIcon className="size-4" />}
        actions={
          planMarkdown ? (
            <ProposedPlanActions
              planMarkdown={planMarkdown}
              workspaceRoot={workspaceRoot}
              variant="ghost"
            />
          ) : null
        }
        onClose={onClose}
        closeLabel={t("chat:closePlanSidebar")}
      />

      {/* Content */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-3 space-y-4">
          {/* Explanation */}
          {activeTaskList?.explanation ? (
            <p className="px-2 text-ui leading-relaxed text-muted-foreground">
              {activeTaskList.explanation}
            </p>
          ) : null}

          {/* Tasks */}
          {activeTaskList && activeTaskList.tasks.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <p className={SETTINGS_SECTION_LABEL_CLASS_NAME}>{t("workspace:plan_steps")}</p>
              <TaskProgressSteps
                className="px-2"
                steps={activeTaskList.tasks.map((task, index) => ({
                  id: `${index}:${task.task}`,
                  text: task.task,
                  status: task.status,
                }))}
              />
            </div>
          ) : null}

          {/* Proposed Plan Markdown */}
          {planMarkdown ? (
            <div className="space-y-2">
              <button
                type="button"
                className={cn(
                  "flex w-full items-center gap-1.5 px-2 py-1 text-left text-ui-sm hover:text-foreground",
                  MUTED_LABEL_TEXT_CLASS_NAME,
                )}
                aria-expanded={proposedPlanExpanded}
                onClick={() => setProposedPlanExpanded((v) => !v)}
              >
                <DisclosureChevron open={proposedPlanExpanded} className="size-3" />
                <span className="min-w-0 truncate">{planTitle ?? t("workspace:fullPlan")}</span>
              </button>
              <DisclosureRegion open={proposedPlanExpanded}>
                <div
                  className={cn(
                    "rounded-xl border border-[color:var(--color-border)] p-3",
                    SOFT_SURFACE_FILL_CLASS_NAME,
                  )}
                >
                  <ChatMarkdown
                    text={displayedPlanMarkdown ?? ""}
                    cwd={markdownCwd}
                    isStreaming={false}
                    className="text-ui leading-relaxed"
                  />
                </div>
              </DisclosureRegion>
            </div>
          ) : null}

          {/* Empty state */}
          {!activeTaskList && !planMarkdown ? (
            <SettingsEmptyState>
              <p className="font-medium text-foreground">{t("workspace:noActivePlanYet")}</p>
              <p>{t("workspace:plansWillAppearHereWhenGenerated")}</p>
            </SettingsEmptyState>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
};

export default PlanSidebar;
export type { PlanSidebarProps };
