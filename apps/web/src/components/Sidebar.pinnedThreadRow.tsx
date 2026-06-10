// FILE: Sidebar.pinnedThreadRow.tsx
// Purpose: Renders a single globally-pinned sidebar thread row (stable-column variant of the project-nested row).
// Layer: Sidebar presentation (component).
// Exports: SidebarPinnedThreadRow

import type { ReactNode } from "react";
import { TerminalIcon } from "~/lib/icons";
import type { ThreadId } from "@t3tools/contracts";
import { isGenericChatThreadTitle } from "@t3tools/shared/chatThreads";
import { cn } from "~/lib/utils";
import type { SidebarThreadSummary } from "../types";
import { resolveThreadHandoffBadgeLabel } from "../lib/threadHandoff";
import { selectThreadTerminalState } from "../terminalStateStore";
import type { ThreadTerminalState } from "../terminalStateStore";
import {
  SIDEBAR_HEADER_ROW_CLASS_NAME,
  SIDEBAR_ROW_ACTIVE_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
  SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
} from "../sidebarRowStyles";
import {
  ProviderAvatarWithTerminal,
  ThreadPrStatusBadge,
  ThreadStatusTrailingGlyph,
} from "./Sidebar.icons";
import { SidebarSubagentLabel } from "./Sidebar.subagent";
import { SidebarMetaChipStack } from "./SidebarMetaChip";
import { SidebarGlyph } from "./sidebarGlyphs";
import { Kbd, KbdGroup } from "./ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { resolveThreadRowMetaChips } from "./Sidebar.threadRowMeta";
import {
  formatRelativeTime,
  prStatusIndicator,
  type ThreadPr,
  type ThreadStatusPill,
  terminalStatusFromThreadState,
  threadStatusSlotClassName,
} from "./Sidebar.logic";

const EMPTY_SHORTCUT_PARTS: readonly string[] = [];

export interface SidebarPinnedThreadRowProps {
  thread: SidebarThreadSummary;
  projectLabel: string | null;

  terminalStateByThreadId: Record<ThreadId, ThreadTerminalState>;
  pendingArchiveConfirmationThreadId: ThreadId | null;
  visualActiveSidebarThreadId: ThreadId | null;
  prByThreadId: ReadonlyMap<ThreadId, ThreadPr | null>;
  visibleThreadJumpLabelByThreadId: ReadonlyMap<ThreadId, string>;
  visibleThreadJumpLabelPartsByThreadId: ReadonlyMap<ThreadId, readonly string[]>;

  resolveThreadStatus: (thread: SidebarThreadSummary) => ThreadStatusPill | null;
  onOpenPrLink: (event: React.MouseEvent<HTMLElement>, prUrl: string) => void;
  onPrimeThreadActivation: (event: React.PointerEvent<HTMLElement>, threadId: ThreadId) => void;
  onActivateThreadFromSidebarIntent: (threadId: ThreadId) => void;
  onOpenRenameThreadDialog: (threadId: ThreadId) => void;
  onThreadRenamePointerUp: (event: React.PointerEvent<HTMLElement>, threadId: ThreadId) => void;
  onThreadContextMenu: (threadId: ThreadId, position: { x: number; y: number }) => void;
  renderHoverActions: (input: {
    threadId: ThreadId;
    toneClassName: string;
    pinned: boolean;
    compact?: boolean;
  }) => ReactNode;
}

export function SidebarPinnedThreadRow({
  thread,
  projectLabel,
  terminalStateByThreadId,
  pendingArchiveConfirmationThreadId,
  visualActiveSidebarThreadId,
  prByThreadId,
  visibleThreadJumpLabelByThreadId,
  visibleThreadJumpLabelPartsByThreadId,
  resolveThreadStatus,
  onOpenPrLink,
  onPrimeThreadActivation,
  onActivateThreadFromSidebarIntent,
  onOpenRenameThreadDialog,
  onThreadRenamePointerUp,
  onThreadContextMenu,
  renderHoverActions,
}: SidebarPinnedThreadRowProps) {
  const threadTerminalState = selectThreadTerminalState(terminalStateByThreadId, thread.id);
  const threadEntryPoint = threadTerminalState.entryPoint;
  const terminalStatus = terminalStatusFromThreadState({
    runningTerminalIds: threadTerminalState.runningTerminalIds,
    terminalAttentionStatesById: threadTerminalState.terminalAttentionStatesById,
  });
  const terminalCount = threadTerminalState.terminalIds.length;
  const isPendingArchiveConfirmation = pendingArchiveConfirmationThreadId === thread.id;
  const isActive = visualActiveSidebarThreadId === thread.id;
  const rightMetaChips = resolveThreadRowMetaChips({
    thread,
    includeHandoffBadge: true,
    handoffShownInAvatar:
      threadEntryPoint !== "terminal" &&
      !isGenericChatThreadTitle(thread.title) &&
      Boolean(thread.handoff?.sourceProvider),
  });
  const threadStatus = resolveThreadStatus(thread);
  const isSubagentThread = Boolean(thread.parentThreadId);
  const prStatus = prStatusIndicator(prByThreadId.get(thread.id) ?? null);
  const leadingPrStatus =
    isSubagentThread || thread.forkSourceThreadId || thread.sidechatSourceThreadId
      ? null
      : prStatus;
  const handoffBadgeLabel = resolveThreadHandoffBadgeLabel(thread);
  const threadJumpLabel = visibleThreadJumpLabelByThreadId.get(thread.id) ?? null;
  const threadJumpLabelParts =
    visibleThreadJumpLabelPartsByThreadId.get(thread.id) ?? EMPTY_SHORTCUT_PARTS;
  const showThreadProviderAvatar = !isGenericChatThreadTitle(thread.title);
  const showThreadIdentityGlyph = threadEntryPoint === "terminal" || showThreadProviderAvatar;
  const pinnedTimestampClassName = isSubagentThread
    ? "mr-1 w-[1.2rem] text-right text-[10px] leading-none tabular-nums text-muted-foreground/62 transition-opacity group-hover/thread-row:opacity-0 group-focus-within/thread-row:opacity-0"
    : "mr-1 w-[1.625rem] text-right text-[length:var(--app-font-size-ui-meta,11px)] leading-none tabular-nums text-muted-foreground/70 transition-opacity group-hover/thread-row:opacity-0 group-focus-within/thread-row:opacity-0";

  return (
    <div key={thread.id} className="group/thread-row relative w-full opacity-85">
      {leadingPrStatus ? (
        <ThreadPrStatusBadge
          prStatus={leadingPrStatus}
          onOpen={onOpenPrLink}
          className="absolute left-1.5 top-1/2 z-20 size-5 -translate-y-1/2"
        />
      ) : null}
      <div
        role="button"
        tabIndex={0}
        data-thread-item
        className={cn(
          SIDEBAR_HEADER_ROW_CLASS_NAME,
          "grid w-full items-center gap-x-1.5 transition-colors",
          leadingPrStatus && "pl-8",
          showThreadIdentityGlyph
            ? "grid-cols-[auto_minmax(0,1fr)_auto_3.5rem]"
            : "grid-cols-[minmax(0,1fr)_auto_3.5rem]",
          isActive
            ? SIDEBAR_ROW_ACTIVE_CLASS_NAME
            : cn(SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME, SIDEBAR_ROW_HOVER_CLASS_NAME),
        )}
        onPointerDown={(event) => onPrimeThreadActivation(event, thread.id)}
        onClick={() => onActivateThreadFromSidebarIntent(thread.id)}
        onDoubleClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onOpenRenameThreadDialog(thread.id);
        }}
        onPointerUp={(event) => onThreadRenamePointerUp(event, thread.id)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onActivateThreadFromSidebarIntent(thread.id);
          }
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          onThreadContextMenu(thread.id, {
            x: event.clientX,
            y: event.clientY,
          });
        }}
      >
        {threadEntryPoint === "terminal" ? (
          <SidebarGlyph icon={TerminalIcon} variant="chrome" className="text-teal-600/85" />
        ) : showThreadProviderAvatar ? (
          <ProviderAvatarWithTerminal
            provider={thread.session?.provider ?? thread.modelSelection.provider}
            handoffSourceProvider={thread.handoff?.sourceProvider ?? null}
            handoffTooltip={handoffBadgeLabel}
            terminalStatus={terminalStatus}
            terminalCount={terminalCount}
          />
        ) : null}
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="min-w-0 flex-1 truncate" data-testid={`thread-title-${thread.id}`}>
                  {isSubagentThread ? (
                    <SidebarSubagentLabel
                      threadId={thread.id}
                      parentThreadId={thread.parentThreadId}
                      agentId={thread.subagentAgentId}
                      nickname={thread.subagentNickname}
                      role={thread.subagentRole}
                      title={thread.title}
                    />
                  ) : (
                    thread.title
                  )}
                </span>
              }
            />
            <TooltipPopup side="top" className="max-w-80 whitespace-normal leading-tight">
              {thread.title}
            </TooltipPopup>
          </Tooltip>
          {!isSubagentThread && threadStatus?.label === "Pending Approval" ? (
            <span
              aria-label="Pending approval"
              className={cn("shrink-0 text-[10px] font-medium", threadStatus.colorClass)}
            >
              Pending
            </span>
          ) : null}
        </div>
        {/* Keep pinned rows on stable columns even when badges/timestamps differ. */}
        <div className="flex min-w-0 max-w-[3rem] shrink items-center justify-end">
          {projectLabel ? (
            <span className="truncate text-right text-[length:var(--app-font-size-ui-meta,10px)] text-muted-foreground/70">
              {projectLabel}
            </span>
          ) : null}
        </div>
        <div className="flex w-14 shrink-0 items-center justify-end">
          <div className="relative flex shrink-0 items-center justify-end gap-1">
            {!isPendingArchiveConfirmation ? <SidebarMetaChipStack chips={rightMetaChips} /> : null}
            {!isPendingArchiveConfirmation && threadJumpLabel ? (
              <KbdGroup>
                {threadJumpLabelParts.map((part) => (
                  <Kbd key={part}>{part}</Kbd>
                ))}
              </KbdGroup>
            ) : null}
            {!isPendingArchiveConfirmation && !threadJumpLabel ? (
              threadStatus ? (
                <span className={threadStatusSlotClassName(isSubagentThread)}>
                  <ThreadStatusTrailingGlyph threadStatus={threadStatus} />
                </span>
              ) : (
                <span className={pinnedTimestampClassName}>
                  {formatRelativeTime(thread.updatedAt ?? thread.createdAt)}
                </span>
              )
            ) : null}
            {renderHoverActions({
              threadId: thread.id,
              toneClassName: "text-muted-foreground/70",
              pinned: true,
              compact: isSubagentThread,
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
