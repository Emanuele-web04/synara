// FILE: PullRequestActions.tsx
// Purpose: The action controls of a pull request's detail, shared by its two hosts (the chat
//          dock's compact header and the code review page's top bar): the primary pill (Ready
//          for review, or Merge / Merge stack, inert with a reason while blocked), the Draft /
//          Ready state items, and the entries of the actions menu (merge method, hand-offs to a
//          thread, close / reopen). Every glyph that names a pull request state or the merge
//          comes from the state presentation map, so a control and the state it leads to look
//          alike. Presentation only: PullRequestDetailPanel owns the queries and runs the actions.
// Layer: Pull request presentation
// Exports: PullRequestPrimaryAction, resolvePullRequestPrimaryAction, PullRequestPrimaryButton,
//          PullRequestDraftStateItems, PullRequestActionMenuItems

import type { PullRequestDetail, PullRequestMergeMethod, ProjectId } from "@synara/contracts";
import type { ComponentProps } from "react";

import { MENU_ICON_CLASS_NAME } from "~/components/chat/composerPickerStyles";
import { Button } from "~/components/ui/button";
import { MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator } from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { ChatBubbleIcon, HammerIcon, LinkIcon, LoaderIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { SendToAgentMenuItems, type GitHubItemSendTarget } from "./GitHubItemAgentActions";
import { copyPullRequestLink } from "./PullRequestConfirmActionDialog";
import { PR_STATE_PRESENTATION_ICONS } from "./pullRequestStatePresentation";

const MergeIcon = PR_STATE_PRESENTATION_ICONS["merged-simple"];
const OpenIcon = PR_STATE_PRESENTATION_ICONS["pull-request"];
const DraftIcon = PR_STATE_PRESENTATION_ICONS.draft;
const ClosedIcon = PR_STATE_PRESENTATION_ICONS["pull-request-closed"];
const ConflictIcon = PR_STATE_PRESENTATION_ICONS["merge-conflict"];

/** What the primary pill offers; null when an open pull request has nothing to do next. */
export type PullRequestPrimaryAction =
  | { kind: "ready" }
  | {
      kind: "merge";
      /** Why Merge cannot run now; the pill stays but does nothing and says why. */
      blockedReason: string | null;
      /** Pull requests a stack merge lands; null outside a stack. */
      stackCount: number | null;
    };

/**
 * Whether the pill is a Merge that cannot run now. A blocked pill and the split chevron beside it
 * both drop to the neutral chip, so the pair never reads as half disabled.
 */
export function isPullRequestPrimaryActionBlocked(
  action: PullRequestPrimaryAction | null,
): boolean {
  return action?.kind === "merge" && action.blockedReason !== null;
}

export function resolvePullRequestPrimaryAction(
  detail: Pick<PullRequestDetail, "state" | "isDraft" | "stack">,
  input: { mergeBlocker: string | null; allowedMethodCount: number; stackCount: number | null },
): PullRequestPrimaryAction | null {
  if (detail.state !== "open") return null;
  // A draft's next step is publishing it; merge only matters once it leaves draft.
  if (detail.isDraft) return { kind: "ready" };
  if (input.mergeBlocker === null && input.allowedMethodCount === 0) return null;
  return {
    kind: "merge",
    blockedReason: input.mergeBlocker,
    stackCount: detail.stack ? input.stackCount : null,
  };
}

/**
 * The primary pill. A blocked Merge uses aria-disabled rather than disabled: Button's disabled
 * state sets `pointer-events-none`, which would swallow the hover its reason tooltip needs, and
 * with no click handler attached there is no action to guard against. It renders as the neutral
 * chip with muted text instead of a faded fill, matching the chevron its host pairs it with.
 */
export function PullRequestPrimaryButton({
  action,
  merging,
  disabled,
  onReady,
  onMerge,
  size,
  className,
  labelClassName,
}: {
  action: PullRequestPrimaryAction;
  merging: boolean;
  disabled: boolean;
  onReady: () => void;
  onMerge: () => void;
  size: ComponentProps<typeof Button>["size"];
  className?: string;
  /** On the words only, so a narrow host can keep just the glyph (e.g. `sr-only` there). */
  labelClassName?: string;
}) {
  if (action.kind === "ready") {
    return (
      <Button size={size} className={className} disabled={disabled} onClick={onReady}>
        <OpenIcon />
        <span className={labelClassName}>Ready for review</span>
      </Button>
    );
  }
  const stacked = action.stackCount !== null;
  const label = merging ? (
    <>
      <LoaderIcon className="size-3.5 animate-spin" />
      <span className={labelClassName}>{stacked ? "Merging stack…" : "Merging…"}</span>
    </>
  ) : (
    <>
      <MergeIcon />
      {stacked ? (
        <>
          <span className={labelClassName}>Merge stack</span>
          <span
            className={cn(
              "rounded-full px-1.5 text-ui-xs tabular-nums",
              action.blockedReason === null ? "bg-primary-foreground/16" : "bg-foreground/10",
            )}
          >
            {action.stackCount}
          </span>
        </>
      ) : (
        <span className={labelClassName}>Merge</span>
      )}
    </>
  );
  if (action.blockedReason !== null) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size={size}
              variant="subtle"
              aria-disabled="true"
              className={cn(
                "cursor-not-allowed text-[var(--color-text-foreground-secondary)]",
                className,
              )}
            />
          }
        >
          {label}
        </TooltipTrigger>
        <TooltipPopup side="bottom">{action.blockedReason}</TooltipPopup>
      </Tooltip>
    );
  }
  return (
    <Button size={size} className={className} disabled={disabled} onClick={onMerge}>
      {label}
    </Button>
  );
}

/** Draft / Ready for review, as a radio pair (the header's state pill and the actions menu). */
export function PullRequestDraftStateItems({
  isDraft,
  disabled,
  onChange,
}: {
  isDraft: boolean;
  disabled: boolean;
  onChange: (next: "draft" | "ready") => void;
}) {
  return (
    <MenuRadioGroup
      value={isDraft ? "draft" : "ready"}
      onValueChange={(value) => {
        if (disabled) return;
        if (value === "draft" && !isDraft) onChange("draft");
        if (value === "ready" && isDraft) onChange("ready");
      }}
    >
      <MenuRadioItem value="draft" disabled={disabled}>
        <DraftIcon className={MENU_ICON_CLASS_NAME} />
        <span>Draft</span>
      </MenuRadioItem>
      <MenuRadioItem value="ready" disabled={disabled}>
        <OpenIcon className={MENU_ICON_CLASS_NAME} />
        <span>Ready for review</span>
      </MenuRadioItem>
    </MenuRadioGroup>
  );
}

/** Which hand-off to a new thread is being prepared. */
export type PreparingThreadAction = "send" | "findings" | "conflicts" | null;

/**
 * What the actions menu holds: the dock's "…" menu, or the page's Merge chevron. The page shows
 * Copy link, Send to agent, and Ask as top bar controls and its floating composer, so only the
 * dock lists them here.
 */
export function PullRequestActionMenuItems({
  detail,
  host,
  actionPending,
  mergeMethods,
  selectedMergeMethod,
  mergeBlocker,
  preparingThread,
  sendTargets,
  askPending,
  onStateChange,
  onMergeMethodChange,
  onSendToAgent,
  onAsk,
  onFixFindings,
  onResolveConflicts,
  onClose,
  onReopen,
}: {
  detail: Pick<PullRequestDetail, "state" | "isDraft" | "mergeability" | "url">;
  host: "dock" | "page";
  actionPending: boolean;
  mergeMethods: ReadonlyArray<PullRequestMergeMethod>;
  selectedMergeMethod: PullRequestMergeMethod;
  mergeBlocker: string | null;
  preparingThread: PreparingThreadAction;
  sendTargets: ReadonlyArray<GitHubItemSendTarget>;
  askPending: boolean;
  onStateChange: (next: "draft" | "ready") => void;
  onMergeMethodChange: (method: PullRequestMergeMethod) => void;
  onSendToAgent: (projectId: ProjectId) => void;
  /** The host's side chat; absent hides Ask. */
  onAsk: (() => void) | undefined;
  onFixFindings: () => void;
  onResolveConflicts: () => void;
  onClose: () => void;
  onReopen: () => void;
}) {
  const open = detail.state === "open";
  return (
    <>
      {open ? (
        <>
          <PullRequestDraftStateItems
            isDraft={detail.isDraft}
            disabled={actionPending}
            onChange={onStateChange}
          />
          <MenuSeparator />
        </>
      ) : null}
      {/* The merge method is a preference for the action, not a second action. Hidden while
          blocked: every method would fail. */}
      {open && !detail.isDraft && mergeBlocker === null && mergeMethods.length > 0 ? (
        <>
          <MenuRadioGroup
            value={selectedMergeMethod}
            onValueChange={(value) => onMergeMethodChange(value as PullRequestMergeMethod)}
          >
            {mergeMethods.map((method) => (
              <MenuRadioItem key={method} value={method} disabled={actionPending}>
                <MergeIcon className={MENU_ICON_CLASS_NAME} />
                <span className="capitalize">{method}</span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
          <MenuSeparator />
        </>
      ) : null}
      {host === "dock" ? (
        <>
          <MenuItem onClick={() => copyPullRequestLink(detail.url)}>
            <LinkIcon className={MENU_ICON_CLASS_NAME} />
            <span>Copy link</span>
          </MenuItem>
          <SendToAgentMenuItems
            sendTargets={sendTargets}
            sending={preparingThread === "send"}
            disabled={preparingThread !== null}
            onSendToAgent={onSendToAgent}
          />
          {onAsk ? (
            <MenuItem onClick={onAsk} disabled={askPending}>
              <ChatBubbleIcon className={MENU_ICON_CLASS_NAME} />
              <span>Ask in a side chat</span>
            </MenuItem>
          ) : null}
        </>
      ) : null}
      <MenuItem onClick={onFixFindings} disabled={preparingThread !== null}>
        <HammerIcon className={MENU_ICON_CLASS_NAME} />
        <span>{preparingThread === "findings" ? "Preparing findings…" : "Fix findings"}</span>
      </MenuItem>
      {/* Beside Fix findings: the same kind of hand-off, offered only while there is a conflict
          to resolve, which is also when Merge is blocked. */}
      {open && detail.mergeability === "conflicting" ? (
        <MenuItem onClick={onResolveConflicts} disabled={preparingThread !== null}>
          <ConflictIcon className={MENU_ICON_CLASS_NAME} />
          <span>
            {preparingThread === "conflicts" ? "Preparing conflicts…" : "Resolve conflicts"}
          </span>
        </MenuItem>
      ) : null}
      {detail.state !== "merged" ? <MenuSeparator /> : null}
      {open ? (
        <MenuItem variant="destructive" disabled={actionPending} onClick={onClose}>
          <ClosedIcon className={MENU_ICON_CLASS_NAME} />
          <span>Close pull request</span>
        </MenuItem>
      ) : detail.state === "closed" ? (
        <MenuItem disabled={actionPending} onClick={onReopen}>
          <OpenIcon className={MENU_ICON_CLASS_NAME} />
          <span>Reopen pull request</span>
        </MenuItem>
      ) : null}
    </>
  );
}
