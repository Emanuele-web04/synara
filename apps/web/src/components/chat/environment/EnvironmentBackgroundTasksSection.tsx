// FILE: EnvironmentBackgroundTasksSection.tsx
// Purpose: One-line Environment panel summary of the thread's background tasks
//          ("2 running", "2 failed"). It stays one line however many tasks run;
//          clicking it opens the full list in the right dock (BackgroundTasksDockPane).
// Layer: Environment panel UI

import { TerminalIcon } from "~/lib/icons";
import { useTranslation } from "~/i18n";

import type { WorkLogBackgroundTask } from "../../../workLog";
import { countBackgroundTasks } from "../backgroundTaskRow.logic";
import {
  ENVIRONMENT_ROW_ICON_CLASS_NAME,
  EnvironmentRow,
  EnvironmentSectionDivider,
  EnvironmentSectionLabel,
} from "./EnvironmentRow";

export function EnvironmentBackgroundTasksSection({
  tasks,
  onOpenList,
}: {
  readonly tasks: ReadonlyArray<WorkLogBackgroundTask>;
  readonly onOpenList: () => void;
}) {
  const { t } = useTranslation();

  // No background tasks yet: hide the whole section instead of an empty row.
  if (tasks.length === 0) {
    return null;
  }

  const { running, settled, failed } = countBackgroundTasks(tasks);
  const label =
    running > 0
      ? t("chat:backgroundTasksRunning", { count: running })
      : t("chat:done2", { value0: settled });
  const failedLabel = failed > 0 ? t("chat:backgroundTasksFailed", { count: failed }) : null;

  return (
    <>
      <EnvironmentSectionDivider />
      <div className="flex flex-col gap-0.5" data-testid="environment-background-tasks-section">
        <EnvironmentSectionLabel>{t("chat:backgroundTasks")}</EnvironmentSectionLabel>
        <EnvironmentRow
          icon={<TerminalIcon className={ENVIRONMENT_ROW_ICON_CLASS_NAME} aria-hidden />}
          label={label}
          trailing={failedLabel ? <span className="text-destructive">{failedLabel}</span> : null}
          aria-label={t("chat:openBackgroundTasks", {
            value0: [label, failedLabel].filter(Boolean).join(", "),
          })}
          onClick={onOpenList}
        />
      </div>
    </>
  );
}
