// FILE: EnvironmentPanel.tsx
// Purpose: Codex-style "Environment" panel. Consolidates the chat-header diff toggle,
//          the composer-footer env/branch pickers, the header git actions, and the
//          "Open in editor" controls into one vertical list of full-width rows. Always
//          rendered as the same rounded floating card; the only difference is whether it
//          overlays pinned top-right of the chat column (p-3 gutters). Full-width single
//          chat also reserves transcript/composer inset; split panes and an open right dock
//          use floating overlay only. The card surface and content are identical either way.
// Layer: Environment panel container

import type { EditorId, ResolvedKeybindingsConfig, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import {
  ENVIRONMENT_PANEL_MOTION_CLASS,
  ENVIRONMENT_PANEL_SURFACE_CLASS_NAME,
} from "~/components/chat/composerPickerStyles";
import BranchToolbar, { type BranchToolbarProps } from "~/components/BranchToolbar";
import ChatMarkdown from "~/components/ChatMarkdown";
import GitActionsControl from "~/components/GitActionsControl";
import { IconButton } from "~/components/ui/icon-button";
import { useRepoDiffTotals } from "~/hooks/useRepoDiffTotals";
import { ChangesIcon, SettingsIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

import { EnvironmentEditorSection } from "./EnvironmentEditorSection";
import { ENVIRONMENT_PANEL_RECAP_MARKDOWN_CLASS_NAME } from "./environmentPanelStyles";
import {
  ENVIRONMENT_ROW_ICON_CLASS_NAME,
  EnvironmentPanelTitle,
  EnvironmentRow,
  EnvironmentSectionLabel,
} from "./EnvironmentRow";

// Horizontal space (px) the docked card reserves on the right edge of the chat area.
// Mirrors the card footprint — w-72 (288px) plus the p-3 wrapper gutters — so insetting
// the chat content by this amount clears the overlay while leaving the transcript's
// scrollbar pinned to the viewport's far right.
export const ENVIRONMENT_DOCKED_CONTENT_INSET_PX = 312;

const ENVIRONMENT_PANEL_OVERLAY_WRAPPER_CLASS_NAME =
  "pointer-events-none absolute inset-y-0 right-0 z-20 flex flex-col p-3";

export interface EnvironmentPanelProps {
  /** Drives the slide-in/out transition; the panel stays mounted so CSS can interpolate. */
  open: boolean;
  /**
   * Both variants render the same top-right overlay card inside the chat column.
   * `docked` also reserves layout space via {@link ENVIRONMENT_DOCKED_CONTENT_INSET_PX};
   * `floating` is used when the column is narrow (split chat or right dock open) — overlay
   * only, no content inset.
   */
  variant: "docked" | "floating";
  gitCwd: string | null;
  openInCwd: string | null;
  isGitRepo: boolean;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  activeThreadId: ThreadId | null;
  /** Whether the active runtime exposes git actions (hides "Commit and Push" otherwise). */
  showGitActions: boolean;
  /** Current diff-panel open state, so the "Changes" row reflects/toggles it. */
  diffOpen: boolean;
  /** Non-null when the diff panel cannot be opened (e.g. no repo / no changes yet). */
  diffDisabledReason?: string | null;
  /** Background refresh cadence for the diff totals badge, or false to fetch once. */
  diffBadgeRefreshIntervalMs?: number | false;
  /** Env/branch picker config — `variant` is supplied by the panel. */
  branchToolbar: Omit<BranchToolbarProps, "variant">;
  /** Compact idle-generated chat memory for the top of the panel. */
  recap?: {
    readonly text: string | null;
    readonly status: "idle" | "pending" | "error";
    readonly updatedAt: string | null;
  } | null;
  /** Toggle the Diff panel/route (same handler the header diff toggle used). */
  onToggleDiff: () => void;
  /** Dismiss the panel overlay — invoked after actions that open the dock. */
  onClose: () => void;
}

const PANEL_DIVIDER_CLASS_NAME = "my-1 border-t border-[color:var(--color-border-light)]";

function EnvironmentRecapSection({
  recap,
  markdownCwd,
}: {
  recap: NonNullable<EnvironmentPanelProps["recap"]>;
  markdownCwd: string | undefined;
}) {
  return (
    <div className="flex flex-col gap-1.5 pb-2.5 pt-1">
      <EnvironmentSectionLabel>Recap</EnvironmentSectionLabel>
      {recap.text ? (
        <div className="px-2">
          <ChatMarkdown
            text={recap.text}
            cwd={markdownCwd}
            isStreaming={false}
            className={ENVIRONMENT_PANEL_RECAP_MARKDOWN_CLASS_NAME}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-1.5 px-2" aria-hidden>
          <div className="h-2.5 w-full rounded bg-[var(--color-background-button-secondary-hover)]/45 motion-safe:animate-pulse" />
          <div className="h-2.5 w-4/5 rounded bg-[var(--color-background-button-secondary-hover)]/35 motion-safe:animate-pulse" />
        </div>
      )}
    </div>
  );
}

export function EnvironmentPanel({
  open,
  variant,
  gitCwd,
  openInCwd,
  isGitRepo,
  keybindings,
  availableEditors,
  activeThreadId,
  showGitActions,
  diffOpen,
  diffDisabledReason = null,
  diffBadgeRefreshIntervalMs = false,
  branchToolbar,
  recap = null,
  onToggleDiff,
  onClose,
}: EnvironmentPanelProps) {
  const navigate = useNavigate();
  const { additions, deletions, hasChanges } = useRepoDiffTotals({
    gitCwd,
    isGitRepo,
    refetchInterval: diffBadgeRefreshIntervalMs,
  });

  // Disable the Changes row only when the diff cannot be opened *and* is not already open
  // (so an open diff stays toggleable closed even when there are no pending changes).
  const changesDisabled = diffDisabledReason !== null && !diffOpen;
  const showRecap = Boolean(recap?.text) || recap?.status === "pending";
  const markdownCwd = openInCwd ?? gitCwd ?? undefined;

  const content = (
    <div className="flex flex-col gap-0.5 p-1.5">
      <div className="flex items-center justify-between gap-2 px-2 pb-0.5 pt-0.5">
        <EnvironmentPanelTitle>Environment</EnvironmentPanelTitle>
        <IconButton
          label="Environment settings"
          tooltip="Environment settings"
          onClick={() => void navigate({ to: "/settings" })}
        >
          <SettingsIcon className="size-3.5" />
        </IconButton>
      </div>

      {isGitRepo ? (
        <EnvironmentRow
          icon={<ChangesIcon className={ENVIRONMENT_ROW_ICON_CLASS_NAME} aria-hidden />}
          label="Changes"
          trailing={
            hasChanges ? (
              <>
                <span className="text-success">+{additions}</span>
                <span className="text-destructive">-{deletions}</span>
              </>
            ) : null
          }
          disabled={changesDisabled}
          onClick={() => {
            onToggleDiff();
            onClose();
          }}
        />
      ) : null}

      {isGitRepo ? <BranchToolbar {...branchToolbar} variant="panel" /> : null}

      {showGitActions ? (
        <GitActionsControl gitCwd={gitCwd} activeThreadId={activeThreadId} variant="panel" />
      ) : null}

      <div className={PANEL_DIVIDER_CLASS_NAME} />

      <EnvironmentEditorSection
        keybindings={keybindings}
        availableEditors={availableEditors}
        openInCwd={openInCwd}
      />

      {showRecap && recap ? (
        <>
          <div className={PANEL_DIVIDER_CLASS_NAME} />
          <EnvironmentRecapSection recap={recap} markdownCwd={markdownCwd} />
        </>
      ) : null}
    </div>
  );

  // Top-right overlay pinned to the chat column with p-3 edge gutters (same footprint in
  // split panes and when the right dock is open). Docked mode additionally insets transcript
  // content; floating overlays only without stealing flex width from the narrow chat pane.
  return (
    <div
      className={ENVIRONMENT_PANEL_OVERLAY_WRAPPER_CLASS_NAME}
      data-environment-panel-variant={variant}
      aria-hidden={!open}
    >
      <div
        className={cn(
          ENVIRONMENT_PANEL_SURFACE_CLASS_NAME,
          ENVIRONMENT_PANEL_MOTION_CLASS,
          "flex max-h-full w-72 flex-col",
          open
            ? "pointer-events-auto translate-x-0 opacity-100"
            : "pointer-events-none translate-x-full opacity-0",
        )}
      >
        <div className="min-h-0 overflow-y-auto">{content}</div>
      </div>
    </div>
  );
}
