// FILE: Sidebar.threadRow.tsx
// Purpose: Renders a single project-nested sidebar thread row (status, avatar, rename input, subagent toggle, hover actions).
// Layer: Sidebar presentation (component).
// Exports: SidebarThreadRow

import type { MutableRefObject, ReactNode } from "react";
import { ChevronDownIcon, ChevronRightIcon, DisposableThreadIcon, TerminalIcon } from "~/lib/icons";
import type { ThreadId } from "@t3tools/contracts";
import { isGenericChatThreadTitle } from "@t3tools/shared/chatThreads";
import { cn } from "~/lib/utils";
import type { SidebarThreadSummary } from "../types";
import { resolveThreadHandoffBadgeLabel } from "../lib/threadHandoff";
import { resolveSubagentPresentationForThread } from "../lib/subagentPresentation";
import { selectThreadTerminalState } from "../terminalStateStore";
import type { ThreadTerminalState } from "../terminalStateStore";
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
import { SidebarMenuSubButton, SidebarMenuSubItem } from "./ui/sidebar";
import { THREAD_DRAG_MIME } from "./chat-drop-overlay/ChatPaneDropOverlay";
import { resolveThreadRowMetaChips } from "./Sidebar.threadRowMeta";
import {
  formatRelativeTime,
  prStatusIndicator,
  resolveThreadRowClassName,
  resolveThreadRowTrailingReserveClass,
  type ThreadPr,
  type ThreadStatusPill,
  terminalStatusFromThreadState,
  threadStatusSlotClassName,
} from "./Sidebar.logic";

const EMPTY_SHORTCUT_PARTS: readonly string[] = [];

export interface SidebarThreadRowProps {
  thread: SidebarThreadSummary;
  orderedProjectThreadIds: readonly ThreadId[];
  depth?: number;
  childCount?: number;
  isExpanded?: boolean;

  terminalStateByThreadId: Record<ThreadId, ThreadTerminalState>;
  pendingArchiveConfirmationThreadId: ThreadId | null;
  visualActiveSidebarThreadId: ThreadId | null;
  pinnedThreadIdSet: ReadonlySet<ThreadId>;
  selectedThreadIds: ReadonlySet<ThreadId>;
  prByThreadId: ReadonlyMap<ThreadId, ThreadPr | null>;
  temporaryThreadIds: Record<ThreadId, true | undefined>;
  draftThreadsByThreadId: Record<ThreadId, { isTemporary?: boolean } | undefined>;
  visibleThreadJumpLabelByThreadId: ReadonlyMap<ThreadId, string>;
  visibleThreadJumpLabelPartsByThreadId: ReadonlyMap<ThreadId, readonly string[]>;
  renamingThreadId: ThreadId | null;
  renamingTitle: string;
  renamingInputRef: MutableRefObject<HTMLInputElement | null>;
  renamingCommittedRef: MutableRefObject<boolean>;

  resolveThreadStatus: (thread: SidebarThreadSummary) => ThreadStatusPill | null;
  onOpenPrLink: (event: React.MouseEvent<HTMLElement>, prUrl: string) => void;
  onThreadClick: (
    event: React.MouseEvent,
    threadId: ThreadId,
    orderedProjectThreadIds: readonly ThreadId[],
    options: { isActive: boolean; canToggleSubagents: boolean },
  ) => void;
  onPrimeThreadActivation: (event: React.PointerEvent<HTMLElement>, threadId: ThreadId) => void;
  onOpenRenameThreadDialog: (threadId: ThreadId) => void;
  onThreadRenamePointerUp: (event: React.PointerEvent<HTMLElement>, threadId: ThreadId) => void;
  onActivateThreadFromSidebarIntent: (threadId: ThreadId) => void;
  onMultiSelectContextMenu: (position: { x: number; y: number }) => void;
  onClearSelection: () => void;
  onThreadContextMenu: (threadId: ThreadId, position: { x: number; y: number }) => void;
  onChangeRenamingTitle: (value: string) => void;
  onCommitRename: (threadId: ThreadId, nextTitle: string, previousTitle: string) => void;
  onCancelRename: () => void;
  onToggleSubagentParent: (threadId: ThreadId) => void;
  renderHoverActions: (input: {
    threadId: ThreadId;
    toneClassName: string;
    pinned: boolean;
    compact?: boolean;
  }) => ReactNode;
}

export function SidebarThreadRow({
  thread,
  orderedProjectThreadIds,
  depth = 0,
  childCount = 0,
  isExpanded = false,
  terminalStateByThreadId,
  pendingArchiveConfirmationThreadId,
  visualActiveSidebarThreadId,
  pinnedThreadIdSet,
  selectedThreadIds,
  prByThreadId,
  temporaryThreadIds,
  draftThreadsByThreadId,
  visibleThreadJumpLabelByThreadId,
  visibleThreadJumpLabelPartsByThreadId,
  renamingThreadId,
  renamingTitle,
  renamingInputRef,
  renamingCommittedRef,
  resolveThreadStatus,
  onOpenPrLink,
  onThreadClick,
  onPrimeThreadActivation,
  onOpenRenameThreadDialog,
  onThreadRenamePointerUp,
  onActivateThreadFromSidebarIntent,
  onMultiSelectContextMenu,
  onClearSelection,
  onThreadContextMenu,
  onChangeRenamingTitle,
  onCommitRename,
  onCancelRename,
  onToggleSubagentParent,
  renderHoverActions,
}: SidebarThreadRowProps) {
  const threadTerminalState = selectThreadTerminalState(terminalStateByThreadId, thread.id);
  const threadEntryPoint = threadTerminalState.entryPoint;
  const isPendingArchiveConfirmation = pendingArchiveConfirmationThreadId === thread.id;
  const isActive = visualActiveSidebarThreadId === thread.id;
  const isPinned = pinnedThreadIdSet.has(thread.id);
  const isSelected = selectedThreadIds.has(thread.id);
  const isHighlighted = isActive || isSelected;
  const threadStatus = resolveThreadStatus(thread);
  const prStatus = prStatusIndicator(prByThreadId.get(thread.id) ?? null);
  const terminalStatus = terminalStatusFromThreadState({
    runningTerminalIds: threadTerminalState.runningTerminalIds,
    terminalAttentionStatesById: threadTerminalState.terminalAttentionStatesById,
  });
  const terminalCount = threadTerminalState.terminalIds.length;
  const isDisposableThread =
    temporaryThreadIds[thread.id] === true ||
    draftThreadsByThreadId[thread.id]?.isTemporary === true;
  const secondaryMetaClass = isHighlighted
    ? "text-foreground/72 dark:text-foreground/78"
    : "text-muted-foreground/70";
  const rightMetaChips = resolveThreadRowMetaChips({
    thread,
    includeHandoffBadge: !isDisposableThread,
    handoffShownInAvatar:
      threadEntryPoint !== "terminal" &&
      !isGenericChatThreadTitle(thread.title) &&
      Boolean(thread.handoff?.sourceProvider),
  });
  const isSubagentThread = Boolean(thread.parentThreadId);
  const leadingPrStatus =
    isSubagentThread || thread.forkSourceThreadId || thread.sidechatSourceThreadId
      ? null
      : prStatus;
  const handoffBadgeLabel = resolveThreadHandoffBadgeLabel(thread);
  const subagentPresentation = isSubagentThread
    ? resolveSubagentPresentationForThread({
        thread: {
          id: thread.id,
          parentThreadId: thread.parentThreadId,
          subagentAgentId: thread.subagentAgentId,
          subagentNickname: thread.subagentNickname,
          subagentRole: thread.subagentRole,
          title: thread.title,
        },
      })
    : null;
  const canToggleSubagents = childCount > 0;
  const subagentIndentPx = Math.max(0, Math.min(depth - 1, 3) * 10);
  const showCompactMeta = !isSubagentThread;
  const threadJumpLabel = visibleThreadJumpLabelByThreadId.get(thread.id) ?? null;
  const threadJumpLabelParts =
    visibleThreadJumpLabelPartsByThreadId.get(thread.id) ?? EMPTY_SHORTCUT_PARTS;
  // Untouched draft chat threads are intentionally text-only until they get a real title.
  const showThreadProviderAvatar = !isGenericChatThreadTitle(thread.title);
  const childCountLabel = `${childCount} subagent${childCount === 1 ? "" : "s"}`;
  const trailingTimestampClassName = isSubagentThread
    ? cn(
        "mr-1 w-[1.2rem] text-right text-[10px] leading-none tabular-nums tracking-[-0.01em] transition-opacity group-hover/thread-row:opacity-0 group-focus-within/thread-row:opacity-0",
        isHighlighted ? "text-foreground/70 dark:text-foreground/72" : "text-muted-foreground/75",
      )
    : cn(
        "mr-1 w-[1.625rem] text-right text-[length:var(--app-font-size-ui-meta,11px)] leading-none tabular-nums transition-opacity group-hover/thread-row:opacity-0 group-focus-within/thread-row:opacity-0",
        secondaryMetaClass,
      );
  const toggleButtonClassName = isHighlighted
    ? "border-[color:var(--color-border)] bg-[var(--color-background-button-secondary)] text-[var(--color-text-foreground-secondary)] hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)]"
    : "border-[color:var(--color-border-light)] bg-[var(--color-background-elevated-secondary)] text-[var(--color-text-foreground-secondary)] hover:border-[color:var(--color-border)] hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)]";

  return (
    <SidebarMenuSubItem
      key={thread.id}
      className="group/thread-row w-full opacity-85"
      data-thread-item
    >
      {leadingPrStatus ? (
        <ThreadPrStatusBadge
          prStatus={leadingPrStatus}
          onOpen={onOpenPrLink}
          className="absolute left-1.5 top-1/2 z-20 size-5 -translate-y-1/2"
        />
      ) : null}
      <SidebarMenuSubButton
        render={<div role="button" tabIndex={0} />}
        data-thread-entry-point={threadEntryPoint}
        size="sm"
        isActive={isActive}
        className={cn(
          resolveThreadRowClassName({
            isActive,
            isSelected,
          }),
          leadingPrStatus && "pl-8",
          isSubagentThread
            ? "pr-7.5"
            : resolveThreadRowTrailingReserveClass(showCompactMeta ? rightMetaChips.length : 0),
        )}
        draggable={renamingThreadId !== thread.id}
        onDragStart={(event) => {
          const dragImage = event.currentTarget as HTMLElement | null;
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData(THREAD_DRAG_MIME, JSON.stringify({ threadId: thread.id }));
          if (dragImage) {
            const rect = dragImage.getBoundingClientRect();
            event.dataTransfer.setDragImage(
              dragImage,
              Math.max(0, event.clientX - rect.left),
              Math.max(0, event.clientY - rect.top),
            );
          }
        }}
        onClick={(event) => {
          onThreadClick(event, thread.id, orderedProjectThreadIds, {
            isActive,
            canToggleSubagents,
          });
        }}
        onPointerDown={(event) => onPrimeThreadActivation(event, thread.id)}
        onDoubleClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onOpenRenameThreadDialog(thread.id);
        }}
        onPointerUp={(event) => onThreadRenamePointerUp(event, thread.id)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          onActivateThreadFromSidebarIntent(thread.id);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          if (selectedThreadIds.size > 0 && selectedThreadIds.has(thread.id)) {
            onMultiSelectContextMenu({
              x: event.clientX,
              y: event.clientY,
            });
          } else {
            if (selectedThreadIds.size > 0) {
              onClearSelection();
            }
            onThreadContextMenu(thread.id, {
              x: event.clientX,
              y: event.clientY,
            });
          }
        }}
      >
        {isSubagentThread ? (
          <span
            aria-hidden="true"
            className="relative inline-flex h-3.5 w-[18px] shrink-0 items-center"
            style={{ marginLeft: `${subagentIndentPx}px` }}
          >
            <span className="absolute left-1.5 top-0 bottom-0 w-px rounded-full bg-border/35" />
            <span className="absolute left-1.5 top-1/2 h-px w-2.5 -translate-y-1/2 bg-border/35" />
            <span
              className="absolute left-1.5 top-1/2 size-[5px] -translate-x-1/2 -translate-y-1/2 rounded-full"
              style={{ backgroundColor: subagentPresentation?.accentColor }}
            />
          </span>
        ) : threadEntryPoint === "terminal" ? (
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
        <div
          className={cn(
            "flex min-w-0 flex-1 items-center text-left",
            isSubagentThread ? "gap-[5px]" : "gap-1.5",
          )}
        >
          {renamingThreadId === thread.id ? (
            <input
              ref={(el) => {
                if (el && renamingInputRef.current !== el) {
                  renamingInputRef.current = el;
                  el.focus();
                  el.select();
                }
              }}
              className="min-w-0 flex-1 truncate rounded-md border border-ring bg-transparent px-1.5 py-0.5 text-[length:var(--app-font-size-ui,12px)] outline-none"
              value={renamingTitle}
              onChange={(e) => onChangeRenamingTitle(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") {
                  e.preventDefault();
                  renamingCommittedRef.current = true;
                  onCommitRename(thread.id, renamingTitle, thread.title);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  renamingCommittedRef.current = true;
                  onCancelRename();
                }
              }}
              onBlur={() => {
                if (!renamingCommittedRef.current) {
                  onCommitRename(thread.id, renamingTitle, thread.title);
                }
              }}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-[length:var(--app-font-size-ui,12px)]",
                // Inactive thread names sit at 92% foreground so they read
                // clearly without competing with the active row, which still
                // pops via the row background and full-foreground color from
                // resolveThreadRowClassName.
                isActive ? "text-foreground" : "text-foreground/92",
                isSubagentThread ? "leading-[18px] text-foreground/80" : "leading-5",
              )}
            >
              {isSubagentThread ? (
                <SidebarSubagentLabel
                  threadId={thread.id}
                  parentThreadId={thread.parentThreadId}
                  agentId={thread.subagentAgentId}
                  nickname={thread.subagentNickname}
                  role={thread.subagentRole}
                  title={thread.title}
                  roleClassName="text-muted-foreground/70"
                />
              ) : (
                thread.title
              )}
            </span>
          )}
          {!isSubagentThread && threadStatus?.label === "Pending Approval" ? (
            <span
              aria-label="Pending approval"
              className={cn("shrink-0 text-[10px] font-medium", threadStatus.colorClass)}
            >
              Pending
            </span>
          ) : null}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5 pr-1">
          {canToggleSubagents ? (
            <button
              type="button"
              data-thread-selection-safe
              aria-label={`${isExpanded ? "Collapse" : "Expand"} ${childCountLabel}`}
              title={childCountLabel}
              className={cn(
                "inline-flex h-5 min-w-5 items-center justify-center gap-0.5 rounded-full border px-[5px] transition-colors",
                toggleButtonClassName,
              )}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onToggleSubagentParent(thread.id);
              }}
            >
              <span className="text-[9px] font-medium leading-none tabular-nums">{childCount}</span>
              {isExpanded ? (
                <SidebarGlyph icon={ChevronDownIcon} variant="chevron" />
              ) : (
                <SidebarGlyph icon={ChevronRightIcon} variant="chevron" />
              )}
            </button>
          ) : null}
          {showCompactMeta && isDisposableThread ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="inline-flex shrink-0 items-center text-muted-foreground/70">
                    <DisposableThreadIcon />
                  </span>
                }
              />
              <TooltipPopup side="top">Disposable chat</TooltipPopup>
            </Tooltip>
          ) : null}
        </div>
        <div className={cn("absolute top-1/2 flex -translate-y-1/2 items-center", "right-1.5")}>
          <div className="relative flex shrink-0 items-center justify-end gap-1">
            {showCompactMeta && !isPendingArchiveConfirmation && rightMetaChips.length > 0 ? (
              <SidebarMetaChipStack chips={rightMetaChips} />
            ) : null}
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
                <span className={trailingTimestampClassName}>
                  {formatRelativeTime(thread.updatedAt ?? thread.createdAt)}
                </span>
              )
            ) : null}
            {renderHoverActions({
              threadId: thread.id,
              toneClassName: secondaryMetaClass,
              pinned: isPinned,
              compact: isSubagentThread,
            })}
          </div>
        </div>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
}
