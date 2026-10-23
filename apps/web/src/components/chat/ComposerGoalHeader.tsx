// FILE: ComposerGoalHeader.tsx
// Purpose: Persistent thread-goal capsule above the composer, beside the live
// file-changes/task capsules: the pursuit state plus the live timer. Clicking it opens the
// full objective with Edit / pause-resume / delete, which act on the persisted goal.
// Layer: Chat composer UI
// Exports: ComposerGoalHeader, goalElapsedMs

import { useNowMs } from "~/hooks/useNowMs";
import { GoalIcon, PauseOutlineIcon, PencilIcon, PlayOutlineIcon, TrashCanIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { formatClockDuration } from "../../session-logic";
import { IconButton } from "../ui/icon-button";
import { ComposerCapsulePopover } from "./ComposerCapsule";
import {
  ComposerStackedPanelRow,
  ComposerStackedPanelRowLabel,
  ComposerStackedPanelRowMain,
} from "./ComposerStackedPanelContent";
import {
  COMPOSER_STACKED_PANEL_BODY_PADDING_CLASS_NAME,
  COMPOSER_STACKED_PANEL_ICON_CLASS_NAME,
  COMPOSER_STACKED_PANEL_SCROLL_REGION_CLASS_NAME,
} from "./composerStackedPanelStyles";

/**
 * Elapsed pursuit time for a goal, or null when the thread predates goal timing
 * (no `goalStartedAt`). While paused the clock freezes at `goalPausedAt`; the
 * server rebases `goalStartedAt` on resume so the paused span never counts.
 */
export function goalElapsedMs(
  input: {
    readonly goalStartedAt?: string | null | undefined;
    readonly goalPausedAt?: string | null | undefined;
  },
  nowMs: number,
): number | null {
  const startedMs = Date.parse(input.goalStartedAt ?? "");
  if (!Number.isFinite(startedMs)) {
    return null;
  }
  const pausedMs = Date.parse(input.goalPausedAt ?? "");
  const endMs = Number.isFinite(pausedMs) ? pausedMs : nowMs;
  return Math.max(0, endMs - startedMs);
}

interface ComposerGoalHeaderProps {
  goal: string;
  goalStartedAt?: string | null | undefined;
  goalPausedAt?: string | null | undefined;
  onEdit: () => void;
  onSetPaused: (paused: boolean) => void | Promise<void>;
  onClear: () => void | Promise<void>;
  // False while the goal is only staged on a draft thread: pursuit has not
  // started, so pausing has nothing to act on and the control is hidden.
  canPause?: boolean;
}

export function ComposerGoalHeader({
  goal,
  goalStartedAt,
  goalPausedAt,
  onEdit,
  onSetPaused,
  onClear,
  canPause = true,
}: ComposerGoalHeaderProps) {
  const paused = (goalPausedAt ?? null) !== null;
  const nowMs = useNowMs(!paused && goalStartedAt != null);
  const elapsedMs = goalElapsedMs({ goalStartedAt, goalPausedAt }, nowMs);
  const stateLabel = canPause ? (paused ? "Goal paused" : "Pursuing goal") : "Goal";
  const elapsedLabel = elapsedMs !== null ? formatClockDuration(elapsedMs) : null;

  return (
    <ComposerCapsulePopover
      icon={<GoalIcon className={COMPOSER_STACKED_PANEL_ICON_CLASS_NAME} />}
      label={
        <>
          {stateLabel}
          {elapsedLabel ? (
            <span className="ml-1.5 tabular-nums text-muted-foreground">{elapsedLabel}</span>
          ) : null}
        </>
      }
      title={goal}
      testId="composer-goal-header"
    >
      {(close) => (
        <>
          <ComposerStackedPanelRow>
            <ComposerStackedPanelRowMain>
              <GoalIcon className={COMPOSER_STACKED_PANEL_ICON_CLASS_NAME} />
              <ComposerStackedPanelRowLabel className="shrink-0">
                {stateLabel}
              </ComposerStackedPanelRowLabel>
              {elapsedLabel ? (
                <span className="shrink-0 tabular-nums text-muted-foreground/80">
                  {elapsedLabel}
                </span>
              ) : null}
            </ComposerStackedPanelRowMain>
            <div className="flex shrink-0 items-center gap-0">
              <IconButton
                variant="ghost"
                size="icon-chip"
                label="Edit goal"
                onClick={() => {
                  close();
                  onEdit();
                }}
              >
                <PencilIcon />
              </IconButton>
              {canPause ? (
                <IconButton
                  variant="ghost"
                  size="icon-chip"
                  label={paused ? "Resume goal" : "Pause goal"}
                  onClick={() => void onSetPaused(!paused)}
                >
                  {paused ? <PlayOutlineIcon /> : <PauseOutlineIcon />}
                </IconButton>
              ) : null}
              <IconButton
                variant="ghost"
                size="icon-chip"
                label="Delete goal"
                onClick={() => void onClear()}
              >
                <TrashCanIcon />
              </IconButton>
            </div>
          </ComposerStackedPanelRow>
          <div
            className={cn(
              COMPOSER_STACKED_PANEL_BODY_PADDING_CLASS_NAME,
              COMPOSER_STACKED_PANEL_SCROLL_REGION_CLASS_NAME,
            )}
          >
            <p
              data-testid="composer-goal-text"
              className="whitespace-pre-wrap break-words text-ui text-muted-foreground/80"
            >
              {goal}
            </p>
          </div>
        </>
      )}
    </ComposerCapsulePopover>
  );
}
