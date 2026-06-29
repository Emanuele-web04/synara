// FILE: MessagesTimeline.tsx
// Purpose: Renders the chat transcript rows and lets LegendList own scrolling/follow behavior.
// Layer: Web chat presentation component
// Exports: MessagesTimeline

import {
  type MessageId,
  type ProviderMentionReference,
  type ThreadId,
  type ThreadMarker,
  type TurnId,
} from "@t3tools/contracts";
import { resolveLatestTailUserMessageEditTarget } from "@t3tools/shared/conversationEdit";
import { pluralize } from "@t3tools/shared/text";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ComponentProps,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  type ReactNode,
  type TouchEvent,
  type WheelEvent,
} from "react";
import { deriveTimelineEntries, formatClockElapsed, type WorkLogEntry } from "../../session-logic";
import { type TurnDiffSummary } from "../../types";
import ChatMarkdown from "../ChatMarkdown";
import { InlineLinkChip } from "../InlineLinkChip";
import { ChangesIcon, NewThreadIcon, PinIcon, SteerIcon, Undo2Icon } from "~/lib/icons";
import { pinActionLabel } from "~/lib/pin";
import { Button } from "../ui/button";
import { buildExpandedImagePreview, ExpandedImagePreview } from "./ExpandedImagePreview";
import { ProposedPlanCard } from "./ProposedPlanCard";
import { ToolCallDetailsDialog } from "./ToolCallDetailsDialog";
import { DiffStatLabel } from "./DiffStatLabel";
import { ReviewChangesButton } from "./ReviewChangesButton";
import { FileEntryIcon } from "./FileEntryIcon";
import { CentralIcon } from "~/lib/central-icons";
import { InlineMentionChip } from "./InlineMentionChip";
import { InlineSkillChip } from "./InlineSkillChip";
import { InlineAgentChip } from "./InlineAgentChip";
import { MessageActionButton, MESSAGE_ACTION_ICON_CLASS_NAME } from "./MessageActionButton";
import { MessageCopyButton } from "./MessageCopyButton";
import { AssistantSelectionsSummaryChip } from "./AssistantSelectionsSummaryChip";
import { FileAttachmentChip } from "./FileAttachmentChip";
import { FileCommentsSummaryChip } from "./FileCommentsSummaryChip";
import { UserMessagePastedTextCard } from "./PastedTextChip";
import {
  computeStableMessagesTimelineRows,
  deriveMessagesTimelineRows,
  MAX_VISIBLE_WORK_LOG_ENTRIES,
  type CollapsedTurnItem,
  type MessagesTimelineRow,
  resolveAssistantMessageCopyState,
  type StableMessagesTimelineRowsState,
} from "./MessagesTimeline.logic";
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";
import {
  deriveDisplayedUserMessageState,
  type ParsedTerminalContextEntry,
} from "~/lib/terminalContext";
import { cn } from "~/lib/utils";
import {
  DEFAULT_CHAT_FONT_SIZE_PX,
  normalizeChatFontSizePx,
  type TimestampFormat,
} from "../../appSettings";
import {
  CHAT_COLUMN_FRAME_CLASS_NAME,
  CHAT_COLUMN_GUTTER_CLASS_NAME,
  ENVIRONMENT_CONTENT_INSET_MOTION_CLASS,
} from "./composerPickerStyles";
import { formatShortTimestamp } from "../../timestampFormat";
import {
  buildInlineTerminalContextText,
  formatInlineTerminalContextLabel,
  textContainsInlineTerminalContextLabels,
} from "./userMessageTerminalContexts";
import { splitPromptIntoDisplaySegments } from "~/composer-editor-mentions";
import {
  getChatMessageFooterTextStyle,
  getChatTranscriptTextStyle,
  getChatTranscriptUserMessageTextStyle,
  USER_MESSAGE_BUBBLE_RADIUS_CLASS_NAME,
  USER_MESSAGE_BUBBLE_SHELL_CHROME_CLASS_NAME,
} from "./chatTypography";
import { DisclosureChevron } from "../ui/DisclosureChevron";
import { DisclosureRegion } from "../ui/DisclosureRegion";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { disclosureContentClassName } from "~/lib/disclosureMotion";
import { getAppTypographyScale } from "../../lib/appTypography";
import { deriveUserMessagePreviewState } from "./userMessagePreview";
import {
  SimpleWorkEntryRow as CanonicalWorkEntryRow,
  isFileChangeWorkEntry,
  prefersCompactWorkEntryRow,
} from "./workEntryRow";

const MAX_VISIBLE_INLINE_TOOL_ENTRIES = 4;
// Changed-files list in the per-turn card is capped so large turns stay compact;
// the rest are revealed via an inline "Show more" row.
const MAX_VISIBLE_CHANGED_FILES = 5;
// The composer overlaps the transcript by design, so the list needs extra tail
// space beyond the overlap to keep final cards from sitting flush against it.
const MIN_BOTTOM_CONTENT_INSET_PX = 64;
const MESSAGE_HOVER_REVEAL_CLASS_NAME =
  "opacity-0 transition-opacity pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto";
// How long a jumped-to message keeps its highlight tint before fading back out.
const JUMP_HIGHLIGHT_DURATION_MS = 1200;
const MARKER_FINE_SCROLL_RETRY_TIMEOUT_MS = 900;
const MARKER_FINE_SCROLL_MAX_RETRY_FRAMES = 90;
const TRANSCRIPT_DISCLOSURE_TRANSITION_MS = 220;
const TRANSCRIPT_DISCLOSURE_CLEANUP_BUFFER_MS = 40;
const MESSAGE_SEND_ENTER_ANIMATION_MS = 180;
const MESSAGE_SEND_ENTER_CLEANUP_BUFFER_MS = 60;
// The deep-link "active" ring is applied imperatively to the rendered marker spans so jumping
// never re-parses a message's markdown tree (the className is purely a CSS box-shadow).
const ACTIVE_MARKER_CLASS_NAME = "thread-marker-active";
const EMPTY_MESSAGE_MARKERS: readonly ThreadMarker[] = [];
const EMPTY_THREAD_MARKERS_BY_MESSAGE_ID = new Map<MessageId, readonly ThreadMarker[]>();
const EMPTY_MESSAGE_ID_SET: ReadonlySet<MessageId> = new Set();

/**
 * Imperative handle the transcript exposes so the Environment panel's pinned-message
 * checklist can scroll the virtualized list to (and briefly flash) a specific message.
 */
export interface MessagesTimelineController {
  scrollToMessage: (messageId: MessageId) => void;
  scrollToMarker: (marker: ThreadMarker) => void;
}

// Keeps the steer marker visually attached to the whole sent-message stack.
function UserDispatchModeChip({
  dispatchMode,
  hasLeadingMedia,
}: {
  dispatchMode: TimelineMessage["dispatchMode"];
  hasLeadingMedia: boolean;
}) {
  if (dispatchMode !== "steer") {
    return null;
  }

  return (
    <div
      className={cn(
        "inline-flex items-center gap-1.5 self-end px-0 text-[11px] font-normal tracking-[0.01em] text-muted-foreground/78",
        hasLeadingMedia ? "mb-3" : "mb-1.5",
      )}
    >
      <SteerIcon className="size-3 shrink-0 text-muted-foreground/75" />
      <span>Steering conversation</span>
    </div>
  );
}

function basename(value: string): string {
  const slash = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  return slash >= 0 ? value.slice(slash + 1) : value;
}

function cssAttributeSelectorValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function getMonotonicTimeMs(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

// A marker can split into several spans when its range crosses markdown nodes, so collect every
// rendered span for the marker (used both to scroll into view and to decorate the active ring).
function collectThreadMarkerElements(
  root: ParentNode | null,
  marker: Pick<ThreadMarker, "id" | "messageId">,
): HTMLElement[] {
  if (!root) {
    return [];
  }
  const messageId = cssAttributeSelectorValue(marker.messageId);
  const markerId = cssAttributeSelectorValue(marker.id);
  const selector = `[data-assistant-message-id="${messageId}"] [data-thread-marker-id="${markerId}"]`;
  return Array.from(root.querySelectorAll<HTMLElement>(selector));
}

function findVisibleThreadMarkerElement(elements: readonly HTMLElement[]): HTMLElement | null {
  for (const element of elements) {
    if (element.getClientRects().length > 0) {
      return element;
    }
  }
  return null;
}

interface MessagesTimelineProps {
  hasMessages: boolean;
  isWorking: boolean;
  activeTurnInProgress: boolean;
  activeTurnStartedAt: string | null;
  followLiveOutput?: boolean;
  emptyStateContent?: ReactNode;
  listRef?: RefObject<LegendListRef | null>;
  /** Receives the scroll-to-message controller so the Environment panel can jump to a pin. */
  controllerRef?: RefObject<MessagesTimelineController | null>;
  /** Message ids currently pinned for the active thread (drives the footer pin toggle state). */
  pinnedMessageIds?: ReadonlySet<MessageId>;
  /** Excludes transient rows from persistent pin affordances. */
  canPinMessage?: (messageId: MessageId) => boolean;
  /** Toggle a message's pinned state from the assistant footer. */
  onTogglePinMessage?: (messageId: MessageId) => void;
  /** Text markers for assistant messages in the active thread. */
  threadMarkers?: readonly ThreadMarker[];
  /** User messages inserted locally by send actions, eligible for the subtle enter affordance. */
  enteringUserMessageIds?: ReadonlySet<MessageId>;
  timelineEntries: ReturnType<typeof deriveTimelineEntries>;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  nowIso?: string;
  expandedWorkGroups?: Record<string, boolean>;
  onToggleWorkGroup?: (groupId: string) => void;
  onOpenAgentActivity?: (activityId: string) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  onOpenThread?: (threadId: ThreadId) => void;
  /** Open an automation's detail page from a "created automation" transcript card. */
  onOpenAutomation?: (automationId: string) => void;
  revertTurnCountByUserMessageId: Map<MessageId, number>;
  onRevertUserMessage: (messageId: MessageId) => void;
  onEditUserMessage?: (messageId: MessageId, text: string) => boolean | Promise<boolean>;
  activeTurnId?: TurnId | null;
  isRevertingCheckpoint: boolean;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onMarkdownContentReflow?: (() => void) | undefined;
  shouldTailReflow?: (() => boolean) | undefined;
  onIsAtEndChange?: (isAtEnd: boolean) => void;
  onMessagesClickCapture?: ComponentProps<typeof LegendList>["onClickCapture"];
  onMessagesMouseUp?: ComponentProps<typeof LegendList>["onMouseUp"];
  onMessagesPointerCancel?: ComponentProps<typeof LegendList>["onPointerCancel"];
  onMessagesPointerDown?: ComponentProps<typeof LegendList>["onPointerDown"];
  onMessagesPointerUp?: ComponentProps<typeof LegendList>["onPointerUp"];
  onMessagesScroll?: ComponentProps<typeof LegendList>["onScroll"];
  onMessagesKeyDown?: ComponentProps<typeof LegendList>["onKeyDown"];
  onMessagesTouchEnd?: ComponentProps<typeof LegendList>["onTouchEnd"];
  onMessagesTouchMove?: ComponentProps<typeof LegendList>["onTouchMove"];
  onMessagesTouchStart?: ComponentProps<typeof LegendList>["onTouchStart"];
  onMessagesWheel?: ComponentProps<typeof LegendList>["onWheel"];
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  chatFontSizePx?: number;
  timestampFormat: TimestampFormat;
  workspaceRoot: string | undefined;
  bottomContentInsetPx?: number | undefined;
  /**
   * Right padding (px) applied to the scroll viewport so transcript rows clear a right-edge
   * overlay (e.g. the docked Environment card). The scrollbar stays pinned to the viewport's
   * far right; only the content is inset.
   */
  contentInsetRightPx?: number | undefined;
}

export const MessagesTimeline = memo(function MessagesTimeline({
  hasMessages,
  isWorking,
  activeTurnInProgress,
  activeTurnStartedAt,
  listRef,
  controllerRef,
  pinnedMessageIds,
  canPinMessage,
  onTogglePinMessage,
  threadMarkers = [],
  enteringUserMessageIds = EMPTY_MESSAGE_ID_SET,
  timelineEntries,
  turnDiffSummaryByAssistantMessageId,
  nowIso,
  expandedWorkGroups,
  onToggleWorkGroup,
  onOpenAgentActivity,
  onOpenTurnDiff,
  onOpenThread,
  onOpenAutomation,
  revertTurnCountByUserMessageId,
  onRevertUserMessage,
  onEditUserMessage,
  activeTurnId,
  isRevertingCheckpoint,
  onImageExpand,
  onMarkdownContentReflow,
  shouldTailReflow,
  onIsAtEndChange,
  onMessagesClickCapture,
  onMessagesMouseUp,
  onMessagesPointerCancel,
  onMessagesPointerDown,
  onMessagesPointerUp,
  onMessagesScroll,
  onMessagesKeyDown,
  onMessagesTouchEnd,
  onMessagesTouchMove,
  onMessagesTouchStart,
  onMessagesWheel,
  markdownCwd,
  resolvedTheme,
  chatFontSizePx = DEFAULT_CHAT_FONT_SIZE_PX,
  timestampFormat,
  workspaceRoot,
  emptyStateContent,
  bottomContentInsetPx,
  contentInsetRightPx,
}: MessagesTimelineProps) {
  const normalizedChatFontSizePx = normalizeChatFontSizePx(chatFontSizePx);
  // Inset rows from the right (overriding the gutter's right padding) without moving the
  // scroll viewport, so the scrollbar stays pinned to the far right while content clears
  // any right-edge overlay. Kept stable so LegendList isn't re-rendered on unrelated updates.
  const listScrollStyle = useMemo(
    () => (contentInsetRightPx ? { paddingRight: contentInsetRightPx } : undefined),
    [contentInsetRightPx],
  );
  const appTypographyScale = useMemo(
    () => getAppTypographyScale(normalizedChatFontSizePx),
    [normalizedChatFontSizePx],
  );
  const chatTypographyStyle = useMemo(
    () => getChatTranscriptTextStyle(normalizedChatFontSizePx),
    [normalizedChatFontSizePx],
  );
  const userMessageTypographyStyle = useMemo(
    () => getChatTranscriptUserMessageTextStyle(normalizedChatFontSizePx),
    [normalizedChatFontSizePx],
  );
  const chatMessageFooterStyle = useMemo(
    () => getChatMessageFooterTextStyle(normalizedChatFontSizePx),
    [normalizedChatFontSizePx],
  );
  const [localExpandedWorkGroups, setLocalExpandedWorkGroups] = useState<Record<string, boolean>>(
    {},
  );
  const expandedWorkGroupsState = expandedWorkGroups ?? localExpandedWorkGroups;
  const handleToggleWorkGroup = useCallback(
    (groupId: string) => {
      if (onToggleWorkGroup) {
        onToggleWorkGroup(groupId);
        return;
      }
      setLocalExpandedWorkGroups((current) => ({
        ...current,
        [groupId]: !(current[groupId] ?? false),
      }));
    },
    [onToggleWorkGroup],
  );
  const [expandedCollapsedWork, setExpandedCollapsedWork] = useState<Record<string, boolean>>({});
  const setCollapsedWorkExpanded = useCallback((messageId: string, open: boolean) => {
    setExpandedCollapsedWork((current) => ({
      ...current,
      [messageId]: open,
    }));
  }, []);
  const [expandedFileChangesByTurnId, setExpandedFileChangesByTurnId] = useState<
    Record<string, boolean>
  >({});
  // Tracks which turns have their changed-files list expanded past MAX_VISIBLE_CHANGED_FILES.
  const [expandedFileListByTurnId, setExpandedFileListByTurnId] = useState<Record<string, boolean>>(
    {},
  );
  const [expandedUserMessagesById, setExpandedUserMessagesById] = useState<Record<string, boolean>>(
    {},
  );
  const [editingUserMessageId, setEditingUserMessageId] = useState<MessageId | null>(null);
  const [submittingEditedUserMessageId, setSubmittingEditedUserMessageId] =
    useState<MessageId | null>(null);
  const [selectedToolDetailsEntryId, setSelectedToolDetailsEntryId] = useState<string | null>(null);
  const openToolDetails = useCallback((workEntry: TimelineWorkEntry) => {
    setSelectedToolDetailsEntryId(workEntry.id);
  }, []);
  const handleToolDetailsOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setSelectedToolDetailsEntryId(null);
    }
  }, []);
  // Transient highlight applied to a message jumped-to from the pinned-message checklist.
  const [highlightedMessageId, setHighlightedMessageId] = useState<MessageId | null>(null);
  // Index markers once per update so each assistant row avoids a full marker scan.
  const threadMarkersByMessageId = useMemo<ReadonlyMap<MessageId, readonly ThreadMarker[]>>(() => {
    if (threadMarkers.length === 0) {
      return EMPTY_THREAD_MARKERS_BY_MESSAGE_ID;
    }
    const byMessageId = new Map<MessageId, ThreadMarker[]>();
    for (const marker of threadMarkers) {
      const messageMarkers = byMessageId.get(marker.messageId);
      if (messageMarkers) {
        messageMarkers.push(marker);
      } else {
        byMessageId.set(marker.messageId, [marker]);
      }
    }
    return byMessageId;
  }, [threadMarkers]);
  const fallbackListRef = useRef<LegendListRef | null>(null);
  const resolvedListRef = listRef ?? fallbackListRef;
  const timelineRootRef = useRef<HTMLDivElement | null>(null);
  const bottomSpacerHeightPx = Math.max(bottomContentInsetPx ?? 0, MIN_BOTTOM_CONTENT_INSET_PX);
  const listFooter = useMemo(
    () => <div aria-hidden="true" style={{ height: bottomSpacerHeightPx }} />,
    [bottomSpacerHeightPx],
  );

  const rawRows = useMemo(
    () =>
      deriveMessagesTimelineRows({
        timelineEntries,
        isWorking,
        activeTurnInProgress,
        activeTurnId,
        activeTurnStartedAt,
        turnDiffSummaryByAssistantMessageId,
        revertTurnCountByUserMessageId,
      }),
    [
      timelineEntries,
      isWorking,
      activeTurnInProgress,
      activeTurnId,
      activeTurnStartedAt,
      turnDiffSummaryByAssistantMessageId,
      revertTurnCountByUserMessageId,
    ],
  );
  const rows = useStableRows(rawRows);
  const settledTurnCollapseTransitions = useSettledTurnCollapseTransitions(rows);
  const enteringMessageRowIds = useMessageSendEnterAnimations(rows, enteringUserMessageIds);
  const timelineExtraData = useMemo(
    () => ({
      editingUserMessageId,
      enteringMessageRowIds,
      expandedCollapsedWork,
      expandedFileChangesByTurnId,
      expandedFileListByTurnId,
      expandedUserMessagesById,
      expandedWorkGroupsState,
      highlightedMessageId,
      nowIso,
      pinnedMessageIds,
      settledTurnCollapseTransitions,
      submittingEditedUserMessageId,
      threadMarkersByMessageId,
    }),
    [
      editingUserMessageId,
      enteringMessageRowIds,
      expandedCollapsedWork,
      expandedFileChangesByTurnId,
      expandedFileListByTurnId,
      expandedUserMessagesById,
      expandedWorkGroupsState,
      highlightedMessageId,
      nowIso,
      pinnedMessageIds,
      settledTurnCollapseTransitions,
      submittingEditedUserMessageId,
      threadMarkersByMessageId,
    ],
  );
  const selectedToolDetailsEntry = useMemo(
    () => findToolDetailsEntryById(rows, selectedToolDetailsEntryId),
    [rows, selectedToolDetailsEntryId],
  );
  // Latest rows kept in a ref so the imperative scroll controller can look up a message's
  // index lazily without re-installing the controller on every transcript change.
  const rowsRef = useRef(rows);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);
  const jumpHighlightTimeoutRef = useRef<number | null>(null);
  const markerFineScrollFrameRef = useRef<number | null>(null);
  // Marker spans currently carrying the deep-link "active" ring, tracked so the decoration can be
  // toggled imperatively (no markdown re-parse) and reliably cleared on the next jump or teardown.
  const decoratedMarkerElementsRef = useRef<HTMLElement[]>([]);
  const clearActiveMarkerDecoration = useCallback(() => {
    for (const element of decoratedMarkerElementsRef.current) {
      element.classList.remove(ACTIVE_MARKER_CLASS_NAME);
    }
    decoratedMarkerElementsRef.current = [];
  }, []);
  const applyActiveMarkerDecoration = useCallback(
    (elements: readonly HTMLElement[]) => {
      clearActiveMarkerDecoration();
      for (const element of elements) {
        element.classList.add(ACTIVE_MARKER_CLASS_NAME);
      }
      decoratedMarkerElementsRef.current = [...elements];
    },
    [clearActiveMarkerDecoration],
  );
  useEffect(
    () => () => {
      if (jumpHighlightTimeoutRef.current !== null) {
        window.clearTimeout(jumpHighlightTimeoutRef.current);
      }
      if (markerFineScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(markerFineScrollFrameRef.current);
      }
      clearActiveMarkerDecoration();
    },
    [clearActiveMarkerDecoration],
  );
  useEffect(() => {
    if (!controllerRef) {
      return;
    }
    const scrollToMessage = (messageId: MessageId) => {
      const index = rowsRef.current.findIndex(
        (row) => row.kind === "message" && row.message.id === messageId,
      );
      if (index < 0) {
        return false;
      }
      void resolvedListRef.current?.scrollToIndex({
        index,
        animated: true,
        viewPosition: 0.2,
      });
      return true;
    };
    const clearJumpHighlightAfterDelay = () => {
      if (jumpHighlightTimeoutRef.current !== null) {
        window.clearTimeout(jumpHighlightTimeoutRef.current);
      }
      jumpHighlightTimeoutRef.current = window.setTimeout(() => {
        setHighlightedMessageId(null);
        clearActiveMarkerDecoration();
        jumpHighlightTimeoutRef.current = null;
      }, JUMP_HIGHLIGHT_DURATION_MS);
    };
    const cancelPendingMarkerFineScroll = () => {
      if (markerFineScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(markerFineScrollFrameRef.current);
        markerFineScrollFrameRef.current = null;
      }
    };
    const scheduleMarkerFineScroll = (marker: ThreadMarker) => {
      cancelPendingMarkerFineScroll();
      const deadlineMs = getMonotonicTimeMs() + MARKER_FINE_SCROLL_RETRY_TIMEOUT_MS;
      let attempts = 0;
      const tick = () => {
        markerFineScrollFrameRef.current = null;
        const elements = collectThreadMarkerElements(timelineRootRef.current, marker);
        const visibleElement = findVisibleThreadMarkerElement(elements);
        if (visibleElement) {
          applyActiveMarkerDecoration(elements);
          visibleElement.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
          return;
        }
        attempts += 1;
        if (getMonotonicTimeMs() <= deadlineMs && attempts < MARKER_FINE_SCROLL_MAX_RETRY_FRAMES) {
          markerFineScrollFrameRef.current = window.requestAnimationFrame(tick);
        }
      };
      markerFineScrollFrameRef.current = window.requestAnimationFrame(tick);
    };
    const controller: MessagesTimelineController = {
      scrollToMessage: (messageId) => {
        cancelPendingMarkerFineScroll();
        clearActiveMarkerDecoration();
        if (!scrollToMessage(messageId)) {
          return;
        }
        setHighlightedMessageId(messageId);
        clearJumpHighlightAfterDelay();
      },
      scrollToMarker: (marker) => {
        clearActiveMarkerDecoration();
        if (!scrollToMessage(marker.messageId)) {
          return;
        }
        setHighlightedMessageId(marker.messageId);
        clearJumpHighlightAfterDelay();
        scheduleMarkerFineScroll(marker);
      },
    };
    controllerRef.current = controller;
    return () => {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
    };
  }, [controllerRef, resolvedListRef, applyActiveMarkerDecoration, clearActiveMarkerDecoration]);
  const tailContentRowId = useMemo(() => {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index]!;
      if (row.kind !== "working") return row.id;
    }
    return null;
  }, [rows]);
  const tailScrollFrameRef = useRef<number | null>(null);
  const tailScrollTimeoutsRef = useRef<number[]>([]);
  const clearTailExpansionScrollTimers = useCallback(() => {
    if (tailScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(tailScrollFrameRef.current);
      tailScrollFrameRef.current = null;
    }
    for (const timeoutId of tailScrollTimeoutsRef.current) {
      window.clearTimeout(timeoutId);
    }
    tailScrollTimeoutsRef.current = [];
  }, []);
  const scrollTailExpansionToEnd = useCallback(() => {
    if (shouldTailReflow && !shouldTailReflow()) {
      return;
    }
    clearTailExpansionScrollTimers();
    const scrollToEnd = () => {
      void resolvedListRef.current?.scrollToEnd?.({ animated: false });
    };
    tailScrollFrameRef.current = window.requestAnimationFrame(() => {
      tailScrollFrameRef.current = null;
      scrollToEnd();
    });
    for (const delay of [80, 180, 260]) {
      const timeoutId = window.setTimeout(scrollToEnd, delay);
      tailScrollTimeoutsRef.current.push(timeoutId);
    }
  }, [clearTailExpansionScrollTimers, resolvedListRef, shouldTailReflow]);
  useEffect(() => clearTailExpansionScrollTimers, [clearTailExpansionScrollTimers]);
  const handleMessagesPointerCancel = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      clearTailExpansionScrollTimers();
      onMessagesPointerCancel?.(event);
    },
    [clearTailExpansionScrollTimers, onMessagesPointerCancel],
  );
  const handleMessagesPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      clearTailExpansionScrollTimers();
      onMessagesPointerDown?.(event);
    },
    [clearTailExpansionScrollTimers, onMessagesPointerDown],
  );
  const handleMessagesPointerUp = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      clearTailExpansionScrollTimers();
      onMessagesPointerUp?.(event);
    },
    [clearTailExpansionScrollTimers, onMessagesPointerUp],
  );
  const handleMessagesTouchMove = useCallback(
    (event: TouchEvent<HTMLDivElement>) => {
      clearTailExpansionScrollTimers();
      onMessagesTouchMove?.(event);
    },
    [clearTailExpansionScrollTimers, onMessagesTouchMove],
  );
  const handleMessagesTouchEnd = useCallback(
    (event: TouchEvent<HTMLDivElement>) => {
      clearTailExpansionScrollTimers();
      onMessagesTouchEnd?.(event);
    },
    [clearTailExpansionScrollTimers, onMessagesTouchEnd],
  );
  const handleMessagesTouchStart = useCallback(
    (event: TouchEvent<HTMLDivElement>) => {
      clearTailExpansionScrollTimers();
      onMessagesTouchStart?.(event);
    },
    [clearTailExpansionScrollTimers, onMessagesTouchStart],
  );
  const handleMessagesWheel = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      clearTailExpansionScrollTimers();
      onMessagesWheel?.(event);
    },
    [clearTailExpansionScrollTimers, onMessagesWheel],
  );
  const handleMessagesKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      clearTailExpansionScrollTimers();
      onMessagesKeyDown?.(event);
    },
    [clearTailExpansionScrollTimers, onMessagesKeyDown],
  );
  const ignoreTimelineImageLoad = useCallback(() => {}, []);
  const latestEditableUserMessageId = useMemo(() => {
    const messages = rows.flatMap((row) => (row.kind === "message" ? [row.message] : []));
    const editTarget = resolveLatestTailUserMessageEditTarget({
      messages,
      activeTurnId,
    });
    return editTarget.editable ? (editTarget.messageId as MessageId) : null;
  }, [activeTurnId, rows]);
  const userMessageIdByAssistantMessageId = useMemo(() => {
    const map = new Map<MessageId, MessageId>();
    let lastUserMessageId: MessageId | null = null;
    for (const row of rows) {
      if (row.kind !== "message") continue;
      if (row.message.role === "user") {
        lastUserMessageId = row.message.id;
      } else if (row.message.role === "assistant" && lastUserMessageId) {
        map.set(row.message.id, lastUserMessageId);
      }
    }
    return map;
  }, [rows]);
  const previousRowCountRef = useRef(rows.length);
  useEffect(() => {
    const previousRowCount = previousRowCountRef.current;
    previousRowCountRef.current = rows.length;
    if (previousRowCount > 0 || rows.length === 0) {
      return;
    }
    onIsAtEndChange?.(true);
    const frameId = window.requestAnimationFrame(() => {
      void resolvedListRef.current?.scrollToEnd?.({ animated: false });
    });
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [onIsAtEndChange, resolvedListRef, rows.length]);
  const handleListScroll = useCallback<NonNullable<MessagesTimelineProps["onMessagesScroll"]>>(
    (event) => {
      onMessagesScroll?.(event);
      const state = resolvedListRef.current?.getState?.();
      if (state) {
        onIsAtEndChange?.(state.isAtEnd);
      }
    },
    [onIsAtEndChange, onMessagesScroll, resolvedListRef],
  );
  const toggleFileChangesExpanded = useCallback((turnId: TurnId) => {
    setExpandedFileChangesByTurnId((current) => ({
      ...current,
      [turnId]: !(current[turnId] ?? true),
    }));
  }, []);
  const toggleFileListExpanded = useCallback((turnId: TurnId) => {
    setExpandedFileListByTurnId((current) => ({
      ...current,
      [turnId]: !(current[turnId] ?? false),
    }));
  }, []);
  const cancelUserMessageEdit = useCallback(() => {
    setEditingUserMessageId(null);
  }, []);
  const startUserMessageEdit = useCallback((messageId: MessageId) => {
    setEditingUserMessageId(messageId);
  }, []);
  const submitUserMessageEdit = useCallback(
    async (messageId: MessageId, text: string) => {
      if (!onEditUserMessage) {
        return;
      }
      const nextText = text.trim();
      if (!nextText) {
        return;
      }
      setSubmittingEditedUserMessageId(messageId);
      try {
        const saved = await onEditUserMessage(messageId, nextText);
        if (saved) {
          cancelUserMessageEdit();
        }
      } finally {
        setSubmittingEditedUserMessageId(null);
      }
    },
    [cancelUserMessageEdit, onEditUserMessage],
  );

  const renderRowContent = (row: MessagesTimelineRow) => (
    <div
      className={cn(
        CHAT_COLUMN_FRAME_CLASS_NAME,
        "px-1 transition-colors duration-500",
        row.kind === "work" || (row.kind === "message" && row.message.role === "assistant")
          ? "pb-2"
          : "pb-4",
        row.kind === "message" && row.message.role === "assistant" ? "group/assistant" : null,
        row.kind === "message" && row.message.id === highlightedMessageId
          ? "rounded-xl bg-[var(--color-background-elevated-secondary)]"
          : null,
        enteringMessageRowIds.has(row.id) ? "chat-message-send-enter" : null,
      )}
      data-timeline-row-kind={row.kind}
      data-message-id={row.kind === "message" ? row.message.id : undefined}
      data-message-role={row.kind === "message" ? row.message.role : undefined}
    >
      {row.kind === "work" &&
        (() => {
          const groupId = row.id;
          const groupedEntries = row.groupedEntries;
          const isExpanded = expandedWorkGroupsState[groupId] ?? false;
          const hasOverflow = groupedEntries.length > MAX_VISIBLE_WORK_LOG_ENTRIES;
          const visibleEntries =
            hasOverflow && !isExpanded
              ? groupedEntries.slice(-MAX_VISIBLE_WORK_LOG_ENTRIES)
              : groupedEntries;
          const hiddenCount = groupedEntries.length - visibleEntries.length;
          const showOverflowToggle = hasOverflow;

          return (
            <div>
              <div className="space-y-0.5">
                {visibleEntries.map((workEntry) => (
                  <CanonicalWorkEntryRow
                    key={`work-row:${workEntry.id}`}
                    workEntry={workEntry}
                    chatMetaFontSizePx={appTypographyScale.chatMetaPx}
                    textFontSizePx={normalizedChatFontSizePx}
                    density={prefersCompactWorkEntryRow(workEntry) ? "compact" : "default"}
                    markdownCwd={markdownCwd}
                    onImageExpand={onImageExpand}
                    onMarkdownContentReflow={onMarkdownContentReflow}
                    onOpenToolDetails={openToolDetails}
                    {...(onOpenAgentActivity ? { onOpenAgentActivity } : {})}
                    {...(onOpenThread ? { onOpenThread } : {})}
                    {...(onOpenAutomation ? { onOpenAutomation } : {})}
                  />
                ))}
              </div>
              {showOverflowToggle && (
                <div className="mt-1.5 flex items-center justify-start gap-2 px-0.5">
                  <button
                    type="button"
                    className="font-system-ui text-muted-foreground/55 transition-colors duration-150 hover:text-foreground/75"
                    style={{ fontSize: `${appTypographyScale.uiSmPx}px` }}
                    onClick={() => handleToggleWorkGroup(groupId)}
                  >
                    {isExpanded ? "Show less" : `Show ${hiddenCount} more`}
                  </button>
                </div>
              )}
            </div>
          );
        })()}

      {row.kind === "message" &&
        row.message.role === "user" &&
        (() => {
          const userImages = (row.message.attachments ?? []).filter(
            (
              attachment,
            ): attachment is Extract<
              NonNullable<TimelineMessage["attachments"]>[number],
              { type: "image" }
            > => attachment.type === "image",
          );
          const assistantSelections = (row.message.attachments ?? []).filter(
            (
              attachment,
            ): attachment is Extract<
              NonNullable<TimelineMessage["attachments"]>[number],
              { type: "assistant-selection" }
            > => attachment.type === "assistant-selection",
          );
          const userFiles = (row.message.attachments ?? []).filter(
            (
              attachment,
            ): attachment is Extract<
              NonNullable<TimelineMessage["attachments"]>[number],
              { type: "file" }
            > => attachment.type === "file",
          );
          const displayedUserMessage = deriveDisplayedUserMessageState(row.message.text, {
            hideImageOnlyBootstrapPrompt:
              userImages.length > 0 || userFiles.length > 0 || assistantSelections.length > 0,
          });
          const renderedAssistantSelections =
            assistantSelections.length > 0
              ? assistantSelections
              : displayedUserMessage.assistantSelections.map((selection, index) => ({
                  type: "assistant-selection" as const,
                  id: `fallback-selection-${row.message.id}-${index}`,
                  assistantMessageId: selection.assistantMessageId,
                  text: selection.text,
                }));
          const terminalContexts = displayedUserMessage.contexts;
          const renderedFileComments = displayedUserMessage.fileComments;
          const renderedPastedTexts = displayedUserMessage.pastedTexts;
          const userMessagePreview = deriveUserMessagePreviewState(
            displayedUserMessage.visibleText,
            {
              expanded: expandedUserMessagesById[row.message.id] ?? false,
            },
          );
          const userMessageExpanded = expandedUserMessagesById[row.message.id] ?? false;
          const showUserText =
            userMessagePreview.text.trim().length > 0 || terminalContexts.length > 0;
          const bubbleIsChipOnly =
            showUserText &&
            terminalContexts.length === 0 &&
            hasOnlyInlineSkillChips(userMessagePreview.text, row.message.mentions ?? []);
          const canRevertAgentWork = typeof row.revertTurnCount === "number";
          const isEditingThisMessage = editingUserMessageId === row.message.id;
          const isSubmittingThisEdit = submittingEditedUserMessageId === row.message.id;
          const showEditUserMessage =
            Boolean(onEditUserMessage) &&
            row.message.id === latestEditableUserMessageId &&
            displayedUserMessage.copyText.trim().length > 0;
          const hasLeadingMedia =
            renderedAssistantSelections.length > 0 ||
            renderedFileComments.length > 0 ||
            renderedPastedTexts.length > 0 ||
            userImages.length > 0;
          const isTailContentRow = row.id === tailContentRowId;
          return (
            <div className="flex w-full justify-end">
              <div
                className={cn(
                  "group flex flex-col items-end gap-px",
                  isEditingThisMessage ? "w-full max-w-full" : "max-w-[80%]",
                )}
              >
                {/* Keep user-message chrome outside the bubble so the message reads as one simple block. */}
                <UserDispatchModeChip
                  dispatchMode={row.message.dispatchMode}
                  hasLeadingMedia={hasLeadingMedia}
                />
                {renderedAssistantSelections.length > 0 && (
                  <div className="mb-1 flex max-w-[240px] flex-wrap justify-end gap-1.5 self-end">
                    <AssistantSelectionsSummaryChip selections={renderedAssistantSelections} />
                  </div>
                )}
                {renderedFileComments.length > 0 && (
                  <div className="mb-1 flex max-w-[240px] flex-wrap justify-end gap-1.5 self-end">
                    <FileCommentsSummaryChip comments={renderedFileComments} />
                  </div>
                )}
                {renderedPastedTexts.length > 0 && (
                  <div className="mb-1 flex max-w-full flex-col items-end gap-1.5 self-end">
                    {renderedPastedTexts.map((pasted) => (
                      <UserMessagePastedTextCard
                        key={pasted.index}
                        text={pasted.text}
                        metrics={{ lineCount: pasted.lineCount, charCount: pasted.charCount }}
                      />
                    ))}
                  </div>
                )}
                {userFiles.length > 0 && (
                  <div className="mb-1 flex max-w-[280px] flex-wrap justify-end gap-1.5 self-end">
                    {userFiles.map((file) => (
                      <FileAttachmentChip key={file.id} file={file} />
                    ))}
                  </div>
                )}
                {userImages.length > 0 && (
                  <div
                    className={cn(
                      "flex max-w-[240px] flex-wrap justify-end gap-2 self-end",
                      showUserText && "mb-1",
                    )}
                  >
                    {userImages.map((image) => (
                      <UserImageAttachmentThumbnail
                        key={image.id}
                        image={image}
                        userImages={userImages}
                        onImageExpand={onImageExpand}
                        onTimelineImageLoad={
                          isTailContentRow ? scrollTailExpansionToEnd : ignoreTimelineImageLoad
                        }
                        resolvedTheme={resolvedTheme}
                      />
                    ))}
                  </div>
                )}
                {isEditingThisMessage ? (
                  <UserMessageEditForm
                    key={row.message.id}
                    initialValue={displayedUserMessage.copyText}
                    disabled={isSubmittingThisEdit || isRevertingCheckpoint}
                    chatTypographyStyle={userMessageTypographyStyle}
                    onCancel={cancelUserMessageEdit}
                    onSubmit={(text) => void submitUserMessageEdit(row.message.id, text)}
                  />
                ) : showUserText ? (
                  <div
                    className={cn(
                      "w-max max-w-full min-w-0 self-end bg-[var(--app-user-message-background)]",
                      USER_MESSAGE_BUBBLE_RADIUS_CLASS_NAME,
                      bubbleIsChipOnly
                        ? "py-1 px-3.5"
                        : USER_MESSAGE_BUBBLE_SHELL_CHROME_CLASS_NAME,
                    )}
                  >
                    <UserMessageBody
                      text={userMessagePreview.text}
                      mentionReferences={row.message.mentions ?? []}
                      terminalContexts={terminalContexts}
                      chatTypographyStyle={userMessageTypographyStyle}
                      resolvedTheme={resolvedTheme}
                    />
                    {userMessagePreview.collapsible && (
                      <button
                        type="button"
                        data-scroll-anchor-ignore
                        className="mt-1 block text-muted-foreground/55 transition-colors duration-150 hover:text-foreground/72"
                        style={{ fontSize: `${normalizedChatFontSizePx}px` }}
                        onClick={() => {
                          setExpandedUserMessagesById((previous) => ({
                            ...previous,
                            [row.message.id]: !(previous[row.message.id] ?? false),
                          }));
                        }}
                      >
                        {userMessageExpanded ? "Show less" : "Show more"}
                      </button>
                    )}
                  </div>
                ) : null}
                {!isEditingThisMessage && (
                  <div
                    className="flex items-center justify-end gap-2 pr-0.5 font-system-ui font-normal text-muted-foreground/45"
                    style={chatMessageFooterStyle}
                  >
                    <p className={cn("tabular-nums", MESSAGE_HOVER_REVEAL_CLASS_NAME)}>
                      {formatShortTimestamp(row.message.createdAt, timestampFormat)}
                    </p>
                    <div className="flex items-center gap-2">
                      {displayedUserMessage.copyText && (
                        <MessageCopyButton
                          text={displayedUserMessage.copyText}
                          className={MESSAGE_HOVER_REVEAL_CLASS_NAME}
                        />
                      )}
                      {showEditUserMessage && (
                        <MessageActionButton
                          label="Edit message"
                          tooltip="Edit and resend"
                          disabled={isRevertingCheckpoint}
                          className={cn(
                            MESSAGE_HOVER_REVEAL_CLASS_NAME,
                            "disabled:text-muted-foreground/35",
                          )}
                          onClick={() => startUserMessageEdit(row.message.id)}
                        >
                          <NewThreadIcon className={MESSAGE_ACTION_ICON_CLASS_NAME} />
                        </MessageActionButton>
                      )}
                      {canRevertAgentWork ? (
                        <MessageActionButton
                          label="Revert to this message"
                          tooltip="Revert to this message"
                          disabled={isRevertingCheckpoint || isWorking}
                          className={cn(
                            MESSAGE_HOVER_REVEAL_CLASS_NAME,
                            "disabled:text-muted-foreground/35",
                          )}
                          onClick={() => onRevertUserMessage(row.message.id)}
                        >
                          <Undo2Icon className={MESSAGE_ACTION_ICON_CLASS_NAME} />
                        </MessageActionButton>
                      ) : null}
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })()}

      {row.kind === "message" &&
        row.message.role === "assistant" &&
        (() => {
          const messageText = row.message.text || (row.message.streaming ? "" : "(empty response)");
          const messageMarkers =
            threadMarkersByMessageId.get(row.message.id) ?? EMPTY_MESSAGE_MARKERS;
          const buildWorkDisplay = (workEntries: WorkLogEntry[], workGroupId: string | null) => {
            const toolEntries = workEntries.filter((entry) => entry.tone === "tool");
            const statusEntries = workEntries.filter((entry) => entry.tone !== "tool");
            const toolGroupId = toolEntries.length > 0 ? workGroupId : null;
            const toolExpanded =
              toolGroupId !== null ? (expandedWorkGroupsState[toolGroupId] ?? false) : false;
            const visibleToolEntries =
              toolExpanded || toolEntries.length <= MAX_VISIBLE_INLINE_TOOL_ENTRIES
                ? toolEntries
                : activeTurnInProgress
                  ? toolEntries.slice(-MAX_VISIBLE_INLINE_TOOL_ENTRIES)
                  : toolEntries.slice(0, MAX_VISIBLE_INLINE_TOOL_ENTRIES);
            const hasGenericFileChangeEntry = toolEntries.some(
              (workEntry) =>
                isFileChangeWorkEntry(workEntry) && (workEntry.changedFiles?.length ?? 0) === 0,
            );
            const visibleRenderableToolEntries = visibleToolEntries.filter(
              (workEntry) =>
                !(
                  hasGenericFileChangeEntry &&
                  isFileChangeWorkEntry(workEntry) &&
                  (workEntry.changedFiles?.length ?? 0) === 0
                ),
            );
            return {
              toolEntries,
              statusEntries,
              toolGroupId,
              toolExpanded,
              visibleRenderableToolEntries,
              hiddenToolCount: toolEntries.length - visibleToolEntries.length,
              hasGenericFileChangeEntry,
            };
          };
          const leadingWorkDisplay = buildWorkDisplay(
            row.leadingWorkEntries ?? [],
            row.leadingWorkGroupId ?? null,
          );
          const inlineWorkDisplay = buildWorkDisplay(
            row.inlineWorkEntries ?? [],
            row.inlineWorkGroupId ?? null,
          );
          const inlineWorkSummary =
            leadingWorkDisplay.toolEntries.length + inlineWorkDisplay.toolEntries.length > 0
              ? null
              : formatInlineWorkSummary([
                  ...leadingWorkDisplay.statusEntries,
                  ...inlineWorkDisplay.statusEntries,
                ]);
          const assistantCopyState = resolveAssistantMessageCopyState({
            text: row.message.text ?? null,
            showCopyButton: row.showAssistantCopyButton,
            streaming: row.assistantCopyStreaming,
          });
          const messagePinned = pinnedMessageIds?.has(row.message.id) ?? false;
          const messageCanPin = canPinMessage?.(row.message.id) ?? true;
          // Offer the pin toggle wherever copy is offered (a complete, terminal answer);
          // keep it visible for an already-pinned message so it can always be unpinned.
          const showPinToggle =
            messageCanPin &&
            Boolean(onTogglePinMessage) &&
            (assistantCopyState.visible || messagePinned);
          const turnSummary = row.assistantTurnDiffSummary;
          const fileDiffStatByPath = new Map(
            (turnSummary?.files ?? []).map((file) => [
              file.path,
              {
                additions: file.additions ?? 0,
                deletions: file.deletions ?? 0,
              },
            ]),
          );
          const inlineEditedFilesFromTurnSummary =
            (leadingWorkDisplay.hasGenericFileChangeEntry ||
              inlineWorkDisplay.hasGenericFileChangeEntry) &&
            (turnSummary?.files.length ?? 0) > 0
              ? turnSummary!.files
              : [];
          // Only the turn's final answer carries a timestamp. Intermediate
          // working preambles (and their inline tool calls) stay timestamp-free
          // so a live turn reads as one block, not a stack of timestamped
          // fragments. `showAssistantCopyButton` is exactly the terminal-message
          // signal (see deriveTerminalAssistantMessageIds).
          const isTerminalAssistantMessage = row.showAssistantCopyButton;
          const assistantMeta = [
            isTerminalAssistantMessage
              ? formatShortTimestamp(row.message.createdAt, timestampFormat)
              : null,
            inlineWorkSummary,
          ]
            .filter((value): value is string => Boolean(value))
            .join(" • ");
          const collapsedTurnItems = row.collapsedTurnItems;
          const hasCollapsedWork = Boolean(collapsedTurnItems && collapsedTurnItems.length > 0);
          const isCollapsedWorkExpanded = hasCollapsedWork
            ? (expandedCollapsedWork[row.message.id] ?? false)
            : false;
          const assistantMarkdownStreaming =
            Boolean(row.message.streaming) &&
            activeTurnInProgress &&
            (activeTurnId == null || row.message.turnId === activeTurnId);
          const settledCollapseTransition = isCollapsedWorkExpanded
            ? undefined
            : settledTurnCollapseTransitions[row.message.id];
          const isTailContentRow = row.id === tailContentRowId;
          const renderWorkDisplay = (
            display: typeof leadingWorkDisplay,
            placement: "leading" | "inline",
          ) => (
            <>
              {!hasCollapsedWork && display.visibleRenderableToolEntries.length > 0 && (
                <div className={placement === "leading" ? "mb-1.5" : "mt-1.5"}>
                  <div className="space-y-px">
                    {display.visibleRenderableToolEntries.map((workEntry) => (
                      <CanonicalWorkEntryRow
                        key={`${placement}-tool-row:${row.message.id}:${workEntry.id}`}
                        workEntry={workEntry}
                        chatMetaFontSizePx={appTypographyScale.chatMetaPx}
                        textFontSizePx={normalizedChatFontSizePx}
                        density="compact"
                        fileDiffStatByPath={fileDiffStatByPath}
                        markdownCwd={markdownCwd}
                        onImageExpand={onImageExpand}
                        onMarkdownContentReflow={onMarkdownContentReflow}
                        onOpenTurnDiff={onOpenTurnDiff}
                        onOpenToolDetails={openToolDetails}
                        {...(onOpenAgentActivity ? { onOpenAgentActivity } : {})}
                        {...(onOpenThread ? { onOpenThread } : {})}
                        {...(onOpenAutomation ? { onOpenAutomation } : {})}
                        {...(turnSummary?.turnId ? { turnId: turnSummary.turnId } : {})}
                      />
                    ))}
                  </div>
                  {display.toolGroupId &&
                    display.toolEntries.length > MAX_VISIBLE_INLINE_TOOL_ENTRIES && (
                      <div className="py-0.5">
                        <button
                          type="button"
                          className="text-muted-foreground/50 transition-colors duration-150 hover:text-foreground/72"
                          style={{ fontSize: `${normalizedChatFontSizePx}px` }}
                          onClick={() => handleToggleWorkGroup(display.toolGroupId!)}
                        >
                          {display.toolExpanded
                            ? "Show less"
                            : `+${display.hiddenToolCount} more tool calls`}
                        </button>
                      </div>
                    )}
                </div>
              )}
              {!hasCollapsedWork && display.statusEntries.length > 0 && (
                <div className={cn("space-y-0.5", placement === "leading" ? "mb-2" : "mt-2")}>
                  {display.statusEntries.map((workEntry) => (
                    <CanonicalWorkEntryRow
                      key={`${placement}-status-row:${row.message.id}:${workEntry.id}`}
                      workEntry={workEntry}
                      chatMetaFontSizePx={appTypographyScale.chatMetaPx}
                      textFontSizePx={normalizedChatFontSizePx}
                      density={prefersCompactWorkEntryRow(workEntry) ? "compact" : "default"}
                      markdownCwd={markdownCwd}
                      onImageExpand={onImageExpand}
                      onMarkdownContentReflow={onMarkdownContentReflow}
                      onOpenToolDetails={openToolDetails}
                      {...(onOpenAgentActivity ? { onOpenAgentActivity } : {})}
                      {...(onOpenThread ? { onOpenThread } : {})}
                      {...(onOpenAutomation ? { onOpenAutomation } : {})}
                    />
                  ))}
                </div>
              )}
            </>
          );
          const renderCollapsedTurnItem = (item: CollapsedTurnItem, keyPrefix: string) =>
            item.kind === "work" ? (
              <CanonicalWorkEntryRow
                key={`${keyPrefix}:work:${row.message.id}:${item.id}`}
                workEntry={item.entry}
                chatMetaFontSizePx={appTypographyScale.chatMetaPx}
                textFontSizePx={normalizedChatFontSizePx}
                density={prefersCompactWorkEntryRow(item.entry) ? "compact" : "default"}
                markdownCwd={markdownCwd}
                onImageExpand={onImageExpand}
                onMarkdownContentReflow={onMarkdownContentReflow}
                onOpenToolDetails={openToolDetails}
                {...(onOpenAgentActivity ? { onOpenAgentActivity } : {})}
                {...(onOpenThread ? { onOpenThread } : {})}
                {...(onOpenAutomation ? { onOpenAutomation } : {})}
              />
            ) : (
              <div
                key={`${keyPrefix}:narration:${row.message.id}:${item.id}`}
                className="text-muted-foreground/80"
                data-assistant-message-id={item.message.id}
              >
                <ChatMarkdown
                  text={item.message.text}
                  cwd={markdownCwd}
                  isStreaming={false}
                  style={chatTypographyStyle}
                  onImageExpand={onImageExpand}
                  onContentReflow={onMarkdownContentReflow}
                  markers={threadMarkersByMessageId.get(item.message.id) ?? EMPTY_MESSAGE_MARKERS}
                />
              </div>
            );
          return (
            <>
              {settledCollapseTransition && (
                <div
                  aria-hidden="true"
                  inert
                  // The clone is visual-only for the entire close transition; keep it inert
                  // even while the inner DisclosureRegion starts open for its first frame.
                  className="pointer-events-none mb-3 select-none"
                  data-settled-turn-collapse-transition="true"
                >
                  <DisclosureRegion
                    open={settledCollapseTransition.open}
                    contentClassName="space-y-1.5 pb-2.5"
                  >
                    {settledCollapseTransition.items.map((item) =>
                      renderCollapsedTurnItem(item, "settling-turn-close"),
                    )}
                  </DisclosureRegion>
                </div>
              )}
              {hasCollapsedWork && (
                <div className="mb-3">
                  <Collapsible
                    className="group/collapsed-work"
                    open={isCollapsedWorkExpanded}
                    onOpenChange={(open) => {
                      setCollapsedWorkExpanded(row.message.id, open);
                    }}
                  >
                    <CollapsibleTrigger
                      // ChatView's click anchor preserves this trigger's screen position
                      // while the disclosure height animates, so opening it should not tail-scroll.
                      // -ml-0.5 optically aligns the leading "W" with the reply
                      // text below: the box is already flush, but the W glyph
                      // carries a left side-bearing that reads as an inset.
                      data-scroll-anchor-ignore
                      className="-ml-0.5 inline-flex items-center gap-1 pb-2 text-left text-muted-foreground/70 transition-colors duration-200 hover:text-muted-foreground/90"
                      style={{ fontSize: chatTypographyStyle.fontSize }}
                    >
                      <span>
                        {row.collapsedWorkElapsed
                          ? `Worked for ${row.collapsedWorkElapsed}`
                          : "Details"}
                      </span>
                      <DisclosureChevron
                        open={isCollapsedWorkExpanded}
                        className="text-muted-foreground/55"
                      />
                    </CollapsibleTrigger>
                    <CollapsiblePanel>
                      <div
                        className={disclosureContentClassName(
                          isCollapsedWorkExpanded,
                          "mb-2.5 space-y-1.5",
                        )}
                      >
                        {collapsedTurnItems!.map((item) =>
                          renderCollapsedTurnItem(item, "collapsed-panel"),
                        )}
                      </div>
                    </CollapsiblePanel>
                  </Collapsible>
                  <div className="h-px w-full bg-border" />
                </div>
              )}
              <div className="group min-w-0 py-0.5">
                {renderWorkDisplay(leadingWorkDisplay, "leading")}
                <div data-assistant-message-id={row.message.id}>
                  <ChatMarkdown
                    text={messageText}
                    cwd={markdownCwd}
                    isStreaming={assistantMarkdownStreaming}
                    style={chatTypographyStyle}
                    onImageExpand={onImageExpand}
                    onContentReflow={onMarkdownContentReflow}
                    markers={messageMarkers}
                  />
                </div>
                {renderWorkDisplay(inlineWorkDisplay, "inline")}
                {inlineEditedFilesFromTurnSummary.length > 0 && (
                  <div className="mt-2 space-y-0.5">
                    {inlineEditedFilesFromTurnSummary.map((file) => (
                      <button
                        key={`inline-summary-edit:${row.message.id}:${file.path}`}
                        type="button"
                        className="group/file-row flex w-full max-w-full items-center gap-2 px-0 py-1.5 text-left transition-colors duration-150 focus-visible:outline-none"
                        title={file.path}
                        onClick={() => onOpenTurnDiff(turnSummary!.turnId, file.path)}
                      >
                        <EditedFileRowContent
                          filePath={file.path}
                          additions={file.additions}
                          deletions={file.deletions}
                          fontSizePx={normalizedChatFontSizePx}
                          compact={false}
                        />
                      </button>
                    ))}
                  </div>
                )}
                {(showPinToggle || assistantCopyState.visible || assistantMeta.length > 0) && (
                  <div
                    className="mt-0.5 flex items-center gap-2 font-system-ui font-normal text-muted-foreground/45"
                    style={chatMessageFooterStyle}
                  >
                    {showPinToggle ? (
                      // Pin sits at the left edge of the footer, before the copy action. It stays
                      // visible when pinned so it reads as a persistent "this is pinned" marker; an
                      // unpinned message only reveals it on hover, like the other footer actions.
                      // Same Central pin glyph in both states — persistence signals the pinned state.
                      <MessageActionButton
                        label={pinActionLabel("message", messagePinned)}
                        tooltip={messagePinned ? "Unpin from panel" : "Pin to panel"}
                        aria-pressed={messagePinned}
                        className={
                          messagePinned
                            ? "text-muted-foreground/80"
                            : MESSAGE_HOVER_REVEAL_CLASS_NAME
                        }
                        onClick={() => onTogglePinMessage?.(row.message.id)}
                      >
                        <PinIcon className={MESSAGE_ACTION_ICON_CLASS_NAME} />
                      </MessageActionButton>
                    ) : null}
                    {assistantCopyState.visible ? (
                      <MessageCopyButton
                        text={assistantCopyState.text ?? ""}
                        className={MESSAGE_HOVER_REVEAL_CLASS_NAME}
                      />
                    ) : null}
                    {assistantMeta.length > 0 ? (
                      <p className={cn("tabular-nums", MESSAGE_HOVER_REVEAL_CLASS_NAME)}>
                        {assistantMeta}
                      </p>
                    ) : null}
                  </div>
                )}
                {(() => {
                  // Hold the end-of-turn changes card (Undo / Review) until the
                  // turn settles. While the turn is live the composer's own
                  // live-changes strip owns this surface; showing the card too
                  // would duplicate it and pre-empt the strip mid-turn.
                  if (!turnSummary || row.assistantTurnInProgress) return null;
                  const checkpointFiles = turnSummary.files;
                  if (checkpointFiles.length === 0) return null;
                  const fileChangesExpanded =
                    expandedFileChangesByTurnId[turnSummary.turnId] ?? true;
                  const fileListExpanded = expandedFileListByTurnId[turnSummary.turnId] ?? false;
                  const correspondingUserMessageId = userMessageIdByAssistantMessageId.get(
                    row.message.id,
                  );
                  const canUndo =
                    correspondingUserMessageId != null &&
                    revertTurnCountByUserMessageId.has(correspondingUserMessageId);
                  const totalAdditions = checkpointFiles.reduce(
                    (sum, file) => sum + (file.additions ?? 0),
                    0,
                  );
                  const totalDeletions = checkpointFiles.reduce(
                    (sum, file) => sum + (file.deletions ?? 0),
                    0,
                  );
                  const editedFilesLabel = `Edited ${checkpointFiles.length} ${pluralize(
                    checkpointFiles.length,
                    "file",
                  )}`;
                  const firstCheckpointFiles = checkpointFiles.slice(0, MAX_VISIBLE_CHANGED_FILES);
                  const overflowCheckpointFiles = checkpointFiles.slice(MAX_VISIBLE_CHANGED_FILES);
                  const renderCheckpointFileRow = (
                    file: (typeof checkpointFiles)[number],
                    withFirstReset: boolean,
                  ) => (
                    <button
                      key={file.path}
                      type="button"
                      className={cn(
                        "group/file-row flex w-full items-center gap-2 border-t border-[color:var(--color-border-light)] bg-transparent px-3 py-2.5 text-left transition-colors hover:bg-[var(--color-background-button-secondary-hover)] dark:bg-transparent dark:hover:bg-transparent",
                        withFirstReset && "first:border-t-0",
                      )}
                      onClick={() => onOpenTurnDiff(turnSummary.turnId, file.path)}
                    >
                      <FileEntryIcon
                        pathValue={file.path}
                        kind="file"
                        theme={resolvedTheme}
                        colorMode="inherit"
                        className="size-4 shrink-0 text-[var(--color-text-foreground)] opacity-70 dark:opacity-80"
                      />
                      <span
                        className="font-system-ui truncate font-normal text-[var(--color-text-foreground)] underline-offset-2 group-hover/file-row:underline group-focus-visible/file-row:underline"
                        style={{ fontSize: chatTypographyStyle.fontSize }}
                      >
                        {file.path}
                      </span>
                      {(file.additions ?? 0) + (file.deletions ?? 0) > 0 && (
                        <span
                          className="font-system-ui ml-auto shrink-0 tabular-nums"
                          style={{ fontSize: chatTypographyStyle.fontSize }}
                        >
                          <DiffStatLabel
                            additions={file.additions ?? 0}
                            deletions={file.deletions ?? 0}
                          />
                        </span>
                      )}
                    </button>
                  );
                  return (
                    <div className="mt-1 mb-4 overflow-hidden rounded-[0.65rem] border border-[color:var(--color-border-light)] dark:border-[color:color-mix(in_srgb,var(--color-border-light)_55%,transparent)]">
                      <div
                        className={cn(
                          "flex items-center justify-between gap-3 bg-[var(--app-user-message-background)] px-3 py-1.5",
                          fileChangesExpanded &&
                            "border-b border-[color:var(--color-border-light)]",
                        )}
                      >
                        <div className="flex min-w-0 items-center gap-2.5">
                          <ChangesIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
                          <div className="min-w-0">
                            <div
                              className="truncate font-normal text-foreground/92"
                              style={{ fontSize: chatTypographyStyle.fontSize }}
                            >
                              {editedFilesLabel}
                            </div>
                            {totalAdditions + totalDeletions > 0 ? (
                              <div
                                className="font-system-ui tabular-nums"
                                style={{ fontSize: chatTypographyStyle.fontSize }}
                              >
                                <DiffStatLabel
                                  additions={totalAdditions}
                                  deletions={totalDeletions}
                                />
                              </div>
                            ) : null}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {canUndo && (
                            <button
                              type="button"
                              className="flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
                              style={{ fontSize: chatTypographyStyle.fontSize }}
                              onClick={() => onRevertUserMessage(correspondingUserMessageId)}
                            >
                              Undo
                              <Undo2Icon className="size-3" />
                            </button>
                          )}
                          <ReviewChangesButton
                            style={{ fontSize: chatTypographyStyle.fontSize }}
                            onClick={() => onOpenTurnDiff(turnSummary.turnId)}
                          />
                          <button
                            type="button"
                            className="inline-flex items-center justify-center rounded-md p-1 text-muted-foreground/70 transition-colors hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground/80"
                            aria-expanded={fileChangesExpanded}
                            aria-label={
                              fileChangesExpanded
                                ? "Collapse changed files list"
                                : "Expand changed files list"
                            }
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              if (!fileChangesExpanded && isTailContentRow) {
                                scrollTailExpansionToEnd();
                              }
                              toggleFileChangesExpanded(turnSummary.turnId);
                            }}
                            data-scroll-anchor-ignore={isTailContentRow ? true : undefined}
                          >
                            <DisclosureChevron
                              open={fileChangesExpanded}
                              className="dark:text-muted-foreground/50"
                            />
                          </button>
                        </div>
                      </div>
                      <DisclosureRegion open={fileChangesExpanded}>
                        {firstCheckpointFiles.map((file) => renderCheckpointFileRow(file, true))}
                        {overflowCheckpointFiles.length > 0 ? (
                          <DisclosureRegion open={fileListExpanded}>
                            {overflowCheckpointFiles.map((file) =>
                              renderCheckpointFileRow(file, false),
                            )}
                          </DisclosureRegion>
                        ) : null}
                        {overflowCheckpointFiles.length > 0 ? (
                          <button
                            type="button"
                            className="flex w-full items-center justify-start gap-1.5 border-t border-[color:var(--color-border-light)] bg-transparent px-3 py-2 font-system-ui font-normal text-muted-foreground transition-colors hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground"
                            style={{ fontSize: chatTypographyStyle.fontSize }}
                            aria-expanded={fileListExpanded}
                            onClick={() => toggleFileListExpanded(turnSummary.turnId)}
                          >
                            <DisclosureChevron open={fileListExpanded} />
                            <span>
                              {fileListExpanded
                                ? "Show less"
                                : `Show ${overflowCheckpointFiles.length} more ${pluralize(
                                    overflowCheckpointFiles.length,
                                    "file",
                                  )}`}
                            </span>
                          </button>
                        ) : null}
                      </DisclosureRegion>
                    </div>
                  );
                })()}
              </div>
            </>
          );
        })()}

      {row.kind === "proposed-plan" && (
        <div className="min-w-0 py-0.5">
          <ProposedPlanCard
            planMarkdown={row.proposedPlan.planMarkdown}
            cwd={markdownCwd}
            workspaceRoot={workspaceRoot}
            chatTypographyStyle={chatTypographyStyle}
          />
        </div>
      )}

      {row.kind === "working" && (
        <div
          className="shimmer pt-0.5 text-muted-foreground/70 font-system-ui"
          style={{ fontSize: `${appTypographyScale.chatPx}px` }}
        >
          {row.createdAt ? (
            <>
              {row.label ?? "Working"} for{" "}
              {nowIso ? (
                (formatWorkingTimer(row.createdAt, nowIso) ?? "0s")
              ) : (
                <WorkingTimer createdAt={row.createdAt} />
              )}
            </>
          ) : (
            `${row.label ?? "Working"}...`
          )}
        </div>
      )}
    </div>
  );

  if (!hasMessages && !isWorking) {
    if (emptyStateContent) {
      return <div className="flex h-full items-center justify-center">{emptyStateContent}</div>;
    }
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground/30">
          Send a message to start the conversation.
        </p>
      </div>
    );
  }

  return (
    <div ref={timelineRootRef} className="contents" data-messages-timeline-root="true">
      <LegendList<MessagesTimelineRow>
        ref={resolvedListRef}
        data={rows}
        keyExtractor={(row) => row.id}
        renderItem={({ item }) => renderRowContent(item)}
        estimatedItemSize={90}
        // LegendList caches rendered rows, so every local expansion map that changes row content
        // has to be surfaced through extraData.
        extraData={timelineExtraData}
        initialScrollAtEnd
        maintainVisibleContentPosition
        onClickCapture={onMessagesClickCapture}
        onMouseUp={onMessagesMouseUp}
        onPointerCancel={handleMessagesPointerCancel}
        onPointerDown={handleMessagesPointerDown}
        onPointerUp={handleMessagesPointerUp}
        onScroll={handleListScroll}
        onKeyDown={handleMessagesKeyDown}
        onTouchEnd={handleMessagesTouchEnd}
        onTouchMove={handleMessagesTouchMove}
        onTouchStart={handleMessagesTouchStart}
        onWheel={handleMessagesWheel}
        data-chat-scroll-container="true"
        ListFooterComponent={listFooter}
        // `scroll-fade-b` (vendored shadcn 4.12.0 util in index.css) masks the bottom
        // edge so streamed content dissolves toward the composer. It is scroll-aware
        // via `animation-timeline: scroll()`, so the fade clears at the live edge and a
        // pinned or non-scrollable transcript stays crisp (no permanent shadow).
        className={cn(
          "scroll-fade-b h-full overflow-x-hidden overscroll-y-contain py-3 [scrollbar-gutter:stable] sm:py-4",
          ENVIRONMENT_CONTENT_INSET_MOTION_CLASS,
          CHAT_COLUMN_GUTTER_CLASS_NAME,
        )}
        {...(listScrollStyle ? { style: listScrollStyle } : {})}
      />
      <ToolCallDetailsDialog
        entry={selectedToolDetailsEntry}
        open={selectedToolDetailsEntry !== null}
        onOpenChange={handleToolDetailsOpenChange}
      />
    </div>
  );
});

type TimelineMessage = Extract<MessagesTimelineRow, { kind: "message" }>["message"];
type TimelineWorkEntry = Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"][number];
type SettledTurnCollapseTransition = {
  open: boolean;
  items: readonly CollapsedTurnItem[];
};
type SettledTurnCollapseTimer = {
  closeFrame: number | null;
  cleanupTimeout: number | null;
};

export function findToolDetailsEntryById(
  rows: ReadonlyArray<MessagesTimelineRow>,
  entryId: string | null,
): TimelineWorkEntry | null {
  if (!entryId) {
    return null;
  }
  for (const row of rows) {
    if (row.kind === "work") {
      const matchingEntry = row.groupedEntries.find((entry) => entry.id === entryId);
      if (matchingEntry) {
        return matchingEntry;
      }
      continue;
    }
    if (row.kind !== "message") {
      continue;
    }
    const matchingLeadingEntry = row.leadingWorkEntries?.find((entry) => entry.id === entryId);
    if (matchingLeadingEntry) {
      return matchingLeadingEntry;
    }
    const matchingInlineEntry = row.inlineWorkEntries?.find((entry) => entry.id === entryId);
    if (matchingInlineEntry) {
      return matchingInlineEntry;
    }
    const matchingCollapsedEntry = row.collapsedTurnItems?.find(
      (item) => item.kind === "work" && item.entry.id === entryId,
    );
    if (matchingCollapsedEntry?.kind === "work") {
      return matchingCollapsedEntry.entry;
    }
  }
  return null;
}

// Reuse stable row references so streaming updates only force React work for
// rows whose visible content actually changed.
function useStableRows(rows: MessagesTimelineRow[]): MessagesTimelineRow[] {
  const previousStateRef = useRef<StableMessagesTimelineRowsState>({
    byId: new Map<string, MessagesTimelineRow>(),
    result: [],
  });

  return useMemo(() => {
    const nextState = computeStableMessagesTimelineRows(rows, previousStateRef.current);
    previousStateRef.current = nextState;
    return nextState.result;
  }, [rows]);
}

// Animates only user rows that ChatView identifies as local optimistic sends;
// transcript hydration can add rows too, but should not replay send motion.
function useMessageSendEnterAnimations(
  rows: readonly MessagesTimelineRow[],
  enteringUserMessageIds: ReadonlySet<MessageId>,
): ReadonlySet<string> {
  const [enteringRowIds, setEnteringRowIds] = useState<ReadonlySet<string>>(() => new Set());
  const previousRowIdsRef = useRef<ReadonlySet<string> | null>(null);
  const cleanupTimeoutsRef = useRef<number[]>([]);

  useLayoutEffect(() => {
    const currentRowIds = new Set(rows.map((row) => row.id));
    const previousRowIds = previousRowIdsRef.current;
    previousRowIdsRef.current = currentRowIds;

    const freshUserRowIds = rows
      .filter(
        (row) =>
          row.kind === "message" &&
          row.message.role === "user" &&
          enteringUserMessageIds.has(row.message.id) &&
          (previousRowIds === null || !previousRowIds.has(row.id)),
      )
      .map((row) => row.id);
    if (freshUserRowIds.length === 0) {
      return;
    }

    setEnteringRowIds((current) => {
      const next = new Set(current);
      for (const rowId of freshUserRowIds) {
        next.add(rowId);
      }
      return next;
    });

    const cleanupTimeout = window.setTimeout(() => {
      cleanupTimeoutsRef.current = cleanupTimeoutsRef.current.filter((id) => id !== cleanupTimeout);
      setEnteringRowIds((current) => {
        const next = new Set(current);
        for (const rowId of freshUserRowIds) {
          next.delete(rowId);
        }
        return next.size === current.size ? current : next;
      });
    }, MESSAGE_SEND_ENTER_ANIMATION_MS + MESSAGE_SEND_ENTER_CLEANUP_BUFFER_MS);
    cleanupTimeoutsRef.current.push(cleanupTimeout);
  }, [enteringUserMessageIds, rows]);

  useEffect(
    () => () => {
      for (const timeoutId of cleanupTimeoutsRef.current) {
        window.clearTimeout(timeoutId);
      }
      cleanupTimeoutsRef.current = [];
    },
    [],
  );

  return enteringRowIds;
}

// Keeps newly folded turn details mounted for one shared-disclosure close
// animation, so settled turns do not disappear in one height recalculation.
function useSettledTurnCollapseTransitions(
  rows: readonly MessagesTimelineRow[],
): Readonly<Record<string, SettledTurnCollapseTransition>> {
  const [transitions, setTransitions] = useState<Record<string, SettledTurnCollapseTransition>>({});
  const previousAssistantMessageIdsRef = useRef<ReadonlySet<string>>(new Set());
  const previousCollapsedSignaturesRef = useRef<ReadonlyMap<string, string>>(new Map());
  const timersRef = useRef(new Map<string, SettledTurnCollapseTimer>());

  const clearTransitionTimer = useCallback((messageId: string) => {
    const timer = timersRef.current.get(messageId);
    if (!timer) {
      return;
    }
    if (timer.closeFrame !== null) {
      window.cancelAnimationFrame(timer.closeFrame);
    }
    if (timer.cleanupTimeout !== null) {
      window.clearTimeout(timer.cleanupTimeout);
    }
    timersRef.current.delete(messageId);
  }, []);

  const scheduleTransitionClose = useCallback(
    (messageId: string) => {
      clearTransitionTimer(messageId);
      const closeFrame = window.requestAnimationFrame(() => {
        const timer = timersRef.current.get(messageId);
        if (!timer) {
          return;
        }
        timersRef.current.set(messageId, { ...timer, closeFrame: null });
        setTransitions((current) => {
          const transition = current[messageId];
          if (!transition || !transition.open) {
            return current;
          }
          return {
            ...current,
            [messageId]: { ...transition, open: false },
          };
        });

        const cleanupTimeout = window.setTimeout(() => {
          timersRef.current.delete(messageId);
          setTransitions((current) => {
            if (!current[messageId]) {
              return current;
            }
            const next = { ...current };
            delete next[messageId];
            return next;
          });
        }, TRANSCRIPT_DISCLOSURE_TRANSITION_MS + TRANSCRIPT_DISCLOSURE_CLEANUP_BUFFER_MS);
        timersRef.current.set(messageId, { closeFrame: null, cleanupTimeout });
      });
      timersRef.current.set(messageId, { closeFrame, cleanupTimeout: null });
    },
    [clearTransitionTimer],
  );

  useLayoutEffect(() => {
    const currentAssistantMessageIds = new Set<string>();
    const currentCollapsed = new Map<
      string,
      { signature: string; items: readonly CollapsedTurnItem[] }
    >();

    for (const row of rows) {
      if (row.kind !== "message" || row.message.role !== "assistant") {
        continue;
      }
      const messageId = row.message.id;
      currentAssistantMessageIds.add(messageId);
      if (row.collapsedTurnItems && row.collapsedTurnItems.length > 0) {
        currentCollapsed.set(messageId, {
          signature: collapsedTurnItemsSignature(row.collapsedTurnItems),
          items: row.collapsedTurnItems,
        });
      }
    }

    const previousAssistantMessageIds = previousAssistantMessageIdsRef.current;
    const previousCollapsedSignatures = previousCollapsedSignaturesRef.current;
    const startedTransitions: Array<{
      messageId: string;
      items: readonly CollapsedTurnItem[];
    }> = [];

    for (const [messageId, collapsed] of currentCollapsed) {
      if (
        previousAssistantMessageIds.has(messageId) &&
        !previousCollapsedSignatures.has(messageId)
      ) {
        startedTransitions.push({ messageId, items: collapsed.items });
      }
    }

    previousAssistantMessageIdsRef.current = currentAssistantMessageIds;
    previousCollapsedSignaturesRef.current = new Map(
      Array.from(currentCollapsed, ([messageId, collapsed]) => [messageId, collapsed.signature]),
    );

    setTransitions((current) => {
      let next: Record<string, SettledTurnCollapseTransition> | null = null;
      const ensureNext = () => {
        next ??= { ...current };
        return next;
      };

      for (const messageId of Object.keys(current)) {
        if (!currentCollapsed.has(messageId)) {
          clearTransitionTimer(messageId);
          delete ensureNext()[messageId];
        }
      }

      for (const transition of startedTransitions) {
        ensureNext()[transition.messageId] = {
          open: true,
          items: transition.items,
        };
      }

      return next ?? current;
    });

    for (const transition of startedTransitions) {
      scheduleTransitionClose(transition.messageId);
    }
  }, [clearTransitionTimer, rows, scheduleTransitionClose]);

  useEffect(
    () => () => {
      for (const messageId of Array.from(timersRef.current.keys())) {
        clearTransitionTimer(messageId);
      }
    },
    [clearTransitionTimer],
  );

  return transitions;
}

function collapsedTurnItemsSignature(items: readonly CollapsedTurnItem[]): string {
  return items.map((item) => `${item.kind}:${item.id}`).join("|");
}

// Keep the live clock scoped to tiny leaf components so active Claude turns do
// not force the full transcript tree to re-render every second.
function WorkingTimer({ createdAt }: { createdAt: string }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const initialText = formatWorkingTimerNow(createdAt);

  useEffect(() => {
    const updateText = () => {
      if (textRef.current) {
        textRef.current.textContent = formatWorkingTimerNow(createdAt);
      }
    };
    updateText();
    const id = window.setInterval(updateText, 1000);
    return () => {
      window.clearInterval(id);
    };
  }, [createdAt]);

  return <span ref={textRef}>{initialText}</span>;
}

function formatWorkingTimer(startIso: string, endIso: string): string | null {
  return formatClockElapsed(startIso, endIso);
}

function formatWorkingTimerNow(startIso: string): string {
  return formatWorkingTimer(startIso, new Date().toISOString()) ?? "0s";
}

function formatInlineWorkSummary(_groupedEntries: TimelineWorkEntry[]): string | null {
  return null;
}

const UserMessageTerminalContextInlineLabel = memo(
  function UserMessageTerminalContextInlineLabel(props: { context: ParsedTerminalContextEntry }) {
    const tooltipText =
      props.context.body.length > 0
        ? `${props.context.header}\n${props.context.body}`
        : props.context.header;

    return <TerminalContextInlineChip label={props.context.header} tooltipText={tooltipText} />;
  },
);

const UserImageAttachmentThumbnail = memo(function UserImageAttachmentThumbnail(props: {
  image: Extract<NonNullable<TimelineMessage["attachments"]>[number], { type: "image" }>;
  userImages: Array<
    Extract<NonNullable<TimelineMessage["attachments"]>[number], { type: "image" }>
  >;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onTimelineImageLoad: () => void;
  resolvedTheme: "light" | "dark";
}) {
  return (
    <button
      type="button"
      className="flex size-15 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border/70 bg-background/82 text-left shadow-[0_1px_0_rgba(255,255,255,0.2)_inset] transition-colors hover:bg-background/94"
      aria-label={`Preview ${props.image.name}`}
      title={props.image.name}
      onClick={() => {
        const preview = buildExpandedImagePreview(props.userImages, props.image.id);
        if (!preview) return;
        props.onImageExpand(preview);
      }}
    >
      {props.image.previewUrl ? (
        <img
          src={props.image.previewUrl}
          alt={props.image.name}
          className="size-full object-cover"
          onLoad={props.onTimelineImageLoad}
          onError={props.onTimelineImageLoad}
        />
      ) : (
        <div className="flex size-full items-center justify-center">
          <FileEntryIcon
            pathValue={props.image.name}
            kind="file"
            theme={props.resolvedTheme}
            className="size-4 opacity-70"
          />
        </div>
      )}
    </button>
  );
});

// Renders read-only user text with the same inline skill pill treatment as the composer.
function renderUserMessageInlineText(
  text: string,
  keyPrefix: string,
  resolvedTheme: "light" | "dark",
  mentionReferences: ReadonlyArray<ProviderMentionReference> = [],
): ReactNode[] {
  return splitPromptIntoDisplaySegments(text, mentionReferences).flatMap((segment, index) => {
    const key = `${keyPrefix}:${index}`;
    if (segment.type === "text") {
      return segment.text.length > 0 ? [<span key={`${key}:text`}>{segment.text}</span>] : [];
    }
    if (segment.type === "skill") {
      return [<InlineSkillChip key={`${key}:skill`} skillName={segment.name} />];
    }
    if (segment.type === "mention") {
      return [
        <InlineMentionChip
          key={`${key}:mention`}
          path={segment.path}
          theme={resolvedTheme}
          mentionReferences={mentionReferences}
          {...(segment.kind ? { kind: segment.kind } : {})}
        />,
      ];
    }
    if (segment.type === "agent-mention") {
      return [<InlineAgentChip key={`${key}:agent`} alias={segment.alias} color={segment.color} />];
    }
    if (segment.type === "link") {
      return [<InlineLinkChip key={`${key}:link`} url={segment.url} interactive />];
    }
    return [];
  });
}

function hasOnlyInlineSkillChips(
  text: string,
  mentionReferences: ReadonlyArray<ProviderMentionReference> = [],
): boolean {
  const segments = splitPromptIntoDisplaySegments(text, mentionReferences);
  let skillCount = 0;

  for (const segment of segments) {
    if (segment.type === "skill") {
      skillCount += 1;
      continue;
    }
    if (segment.type === "text" && segment.text.trim().length === 0) {
      continue;
    }
    return false;
  }

  return skillCount > 0;
}

// Inline editor for replaying a user message after the following assistant turn is rolled back.
const UserMessageEditForm = memo(function UserMessageEditForm(props: {
  initialValue: string;
  disabled: boolean;
  chatTypographyStyle: CSSProperties;
  onCancel: () => void;
  onSubmit: (value: string) => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState(props.initialValue);
  const canSubmit = draft.trim().length > 0 && !props.disabled;

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, []);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [draft]);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      props.onCancel();
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (canSubmit) {
        props.onSubmit(draft);
      }
    }
  };

  return (
    <form
      className={cn(
        "w-full bg-[var(--app-user-message-background)]",
        USER_MESSAGE_BUBBLE_RADIUS_CLASS_NAME,
        USER_MESSAGE_BUBBLE_SHELL_CHROME_CLASS_NAME,
      )}
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit) {
          props.onSubmit(draft);
        }
      }}
    >
      <textarea
        ref={textareaRef}
        value={draft}
        disabled={props.disabled}
        rows={1}
        aria-label="Edit message"
        className="max-h-60 min-h-0 w-full resize-none overflow-y-auto border-0 bg-transparent p-0 font-system-ui text-foreground outline-none placeholder:text-muted-foreground/45 disabled:opacity-70"
        style={props.chatTypographyStyle}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="mt-2 flex justify-end gap-2">
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="rounded-full px-2.5"
          style={props.chatTypographyStyle}
          disabled={props.disabled}
          onClick={props.onCancel}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          size="xs"
          className="rounded-full px-2.5"
          style={props.chatTypographyStyle}
          disabled={!canSubmit}
        >
          Send
        </Button>
      </div>
    </form>
  );
});

const UserMessageBody = memo(function UserMessageBody(props: {
  text: string;
  mentionReferences: ReadonlyArray<ProviderMentionReference>;
  terminalContexts: ParsedTerminalContextEntry[];
  chatTypographyStyle: CSSProperties;
  resolvedTheme: "light" | "dark";
}) {
  if (props.terminalContexts.length > 0) {
    const hasEmbeddedInlineLabels = textContainsInlineTerminalContextLabels(
      props.text,
      props.terminalContexts,
    );
    const inlinePrefix = buildInlineTerminalContextText(props.terminalContexts);
    const inlineNodes: ReactNode[] = [];

    if (hasEmbeddedInlineLabels) {
      let cursor = 0;

      for (const context of props.terminalContexts) {
        const label = formatInlineTerminalContextLabel(context.header);
        const matchIndex = props.text.indexOf(label, cursor);
        if (matchIndex === -1) {
          inlineNodes.length = 0;
          break;
        }
        if (matchIndex > cursor) {
          inlineNodes.push(
            ...renderUserMessageInlineText(
              props.text.slice(cursor, matchIndex),
              `user-terminal-context-inline-before:${context.header}:${cursor}`,
              props.resolvedTheme,
              props.mentionReferences,
            ),
          );
        }
        inlineNodes.push(
          <UserMessageTerminalContextInlineLabel
            key={`user-terminal-context-inline:${context.header}`}
            context={context}
          />,
        );
        cursor = matchIndex + label.length;
      }

      if (inlineNodes.length > 0) {
        if (cursor < props.text.length) {
          inlineNodes.push(
            ...renderUserMessageInlineText(
              props.text.slice(cursor),
              `user-message-terminal-context-inline-rest:${cursor}`,
              props.resolvedTheme,
              props.mentionReferences,
            ),
          );
        }

        return (
          <div
            className="block max-w-full min-w-0 wrap-break-word whitespace-pre-wrap font-system-ui text-foreground"
            style={props.chatTypographyStyle}
          >
            {inlineNodes}
          </div>
        );
      }
    }

    for (const context of props.terminalContexts) {
      inlineNodes.push(
        <UserMessageTerminalContextInlineLabel
          key={`user-terminal-context-inline:${context.header}`}
          context={context}
        />,
      );
      inlineNodes.push(
        <span key={`user-terminal-context-inline-space:${context.header}`} aria-hidden="true">
          {" "}
        </span>,
      );
    }

    if (props.text.length > 0) {
      inlineNodes.push(
        ...renderUserMessageInlineText(
          props.text,
          "user-message-terminal-context-inline-text",
          props.resolvedTheme,
          props.mentionReferences,
        ),
      );
    } else if (inlinePrefix.length === 0) {
      return null;
    }

    return (
      <div
        className="block max-w-full min-w-0 wrap-break-word whitespace-pre-wrap font-system-ui text-foreground"
        style={props.chatTypographyStyle}
      >
        {inlineNodes}
      </div>
    );
  }

  if (props.text.length === 0) {
    return null;
  }

  if (
    props.terminalContexts.length === 0 &&
    hasOnlyInlineSkillChips(props.text, props.mentionReferences)
  ) {
    return (
      <div
        className="flex max-w-full min-w-0 items-center leading-none text-foreground [&>span]:translate-y-0"
        style={props.chatTypographyStyle}
      >
        {renderUserMessageInlineText(
          props.text,
          "user-message-inline-chip-only",
          props.resolvedTheme,
          props.mentionReferences,
        )}
      </div>
    );
  }

  return (
    <div
      className="block max-w-full min-w-0 whitespace-pre-wrap break-words font-system-ui text-foreground"
      style={props.chatTypographyStyle}
    >
      {renderUserMessageInlineText(
        props.text,
        "user-message-inline",
        props.resolvedTheme,
        props.mentionReferences,
      )}
    </div>
  );
});

// Inner content for an "Edited <file> +n/-m" row. Mirrors the tool-call row treatment
// (muted leading icon + label that brightens to foreground on hover/focus, same font
// size) so edited rows read as the same visual unit. Callers own the interactive wrapper
// (`group/file-row` button or disclosure summary) and pass the diff stat when available.
function EditedFileRowContent(props: {
  filePath: string;
  additions: number | undefined;
  deletions: number | undefined;
  fontSizePx: number;
  compact: boolean;
}) {
  const { filePath, additions, deletions, fontSizePx, compact } = props;
  const hasStat = (additions ?? 0) + (deletions ?? 0) > 0;
  return (
    <>
      <span
        className={cn(
          "flex shrink-0 items-center justify-center text-muted-foreground/40 transition-colors group-hover/file-row:text-foreground group-focus-visible/file-row:text-foreground",
          compact ? "size-4" : "size-5",
        )}
        data-tool-icon="edit"
      >
        <CentralIcon name="pencil" className={compact ? "size-3.5" : "size-4"} />
      </span>
      <span
        className="font-system-ui shrink-0 text-muted-foreground/40 transition-colors group-hover/file-row:text-foreground group-focus-visible/file-row:text-foreground"
        style={{ fontSize: `${fontSizePx}px` }}
      >
        Edited
      </span>
      <span
        className="font-system-ui max-w-[28rem] truncate text-muted-foreground/40 underline-offset-2 transition-colors group-hover/file-row:text-foreground group-hover/file-row:underline group-focus-visible/file-row:text-foreground group-focus-visible/file-row:underline"
        style={{ fontSize: `${fontSizePx}px` }}
      >
        {basename(filePath)}
      </span>
      {hasStat ? (
        <span
          className="font-system-ui shrink-0 tabular-nums whitespace-nowrap"
          style={{ fontSize: `${fontSizePx}px` }}
        >
          <DiffStatLabel additions={additions ?? 0} deletions={deletions ?? 0} />
        </span>
      ) : null}
    </>
  );
}
