// FILE: EnvironmentSubagentsSection.tsx
// Purpose: Compact Environment panel summary of the thread's subagents: a few glyph
//          avatars, how many are running, and how many are done. Clicking it opens the
//          full list in the right dock (SubagentsDockPane).
// Layer: Environment panel UI

import { pluralize } from "~/i18n/pluralize";

import { SubagentAvatarStack } from "../SubagentAvatar";
import {
  ENVIRONMENT_ROW_CLASS_NAME,
  EnvironmentRowBody,
  EnvironmentSectionDivider,
  EnvironmentSectionLabel,
} from "./EnvironmentRow";
import type { EnvironmentSubagentRoster } from "./EnvironmentSubagentsSection.logic";
import { useTranslation } from "~/i18n";

const SUMMARY_AVATAR_LIMIT = 3;

export function EnvironmentSubagentsSection({
  roster,
  onOpenList,
}: {
  readonly roster: EnvironmentSubagentRoster;
  readonly onOpenList: () => void;
}) {
  const { t } = useTranslation();

  const { active, previous } = roster;
  const total = active.length + previous.length;
  // No subagents yet: hide the whole section instead of showing an empty header row.
  if (total === 0) {
    return null;
  }

  // Live agents lead the stack; with none running, the most recent finished ones stand in.
  const avatars = (active.length > 0 ? active : previous).slice(0, SUMMARY_AVATAR_LIMIT);
  const runningCount = active.filter((item) => item.statusKind === "running").length;
  const queuedCount = active.length - runningCount;
  const label =
    active.length > 0
      ? [
          runningCount > 0 ? `${runningCount} running` : null,
          queuedCount > 0 ? `${queuedCount} queued` : null,
        ]
          .filter(Boolean)
          .join(", ")
      : t("{{value0}} {{value1}}", { value0: total, value1: pluralize(total, "subagent") });
  const doneLabel =
    active.length > 0 && previous.length > 0
      ? t("{{value0}} done", { value0: previous.length })
      : null;

  return (
    <>
      <EnvironmentSectionDivider />
      <div className="flex flex-col gap-0.5" data-testid="environment-subagents-section">
        <EnvironmentSectionLabel>{t("Subagents")}</EnvironmentSectionLabel>
        <button
          type="button"
          className={ENVIRONMENT_ROW_CLASS_NAME}
          aria-label={t("Open subagents: {{value0}}", {
            value0: [label, doneLabel].filter(Boolean).join(", "),
          })}
          onClick={onOpenList}
        >
          <EnvironmentRowBody
            compact
            icon={<SubagentAvatarStack items={avatars} />}
            label={label}
            trailing={
              doneLabel ? (
                <span className="text-[var(--color-text-foreground-secondary)]">{doneLabel}</span>
              ) : null
            }
          />
        </button>
      </div>
    </>
  );
}
