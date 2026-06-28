// FILE: MessagesTimeline.tsx
// Purpose: Renders the chat transcript rows and lets LegendList own scrolling/follow behavior.
// Layer: Web chat presentation component
// Exports: MessagesTimeline

import {
  type MessageId,
  type ProviderMentionReference,
  ThreadId,
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
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ComponentProps,
  type KeyboardEvent,
  type RefObject,
  type ReactNode,
} from "react";
import {
  deriveTimelineEntries,
  formatClockElapsed,
  isFileChangeWorkLogEntry,
  type WorkLogEntry,
} from "../../session-logic";
import { type TurnDiffSummary } from "../../types";
import ChatMarkdown from "../ChatMarkdown";
import { InlineLinkChip } from "../InlineLinkChip";
import {
  BotIcon,
  CheckIcon,
  ChangesIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  EyeIcon,
  GitHubIcon,
  HammerIcon,
  type LucideIcon,
  McpIcon,
  NewThreadIcon,
  PinIcon,
  SearchIcon,
  SkillCubeIcon,
  SquarePenIcon,
  SteerIcon,
  TerminalIcon,
  Undo2Icon,
  WebSearchIcon,
  ZapIcon,
} from "~/lib/icons";
import { pinActionLabel } from "~/lib/pin";
import { Button } from "../ui/button";
import { AutomationCreatedCard } from "./AutomationCreatedCard";
import { buildExpandedImagePreview, ExpandedImagePreview } from "./ExpandedImagePreview";
import { ProposedPlanCard } from "./ProposedPlanCard";
import { ToolCallDetailsContent, ToolCallDetailsDialog } from "./ToolCallDetailsDialog";
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
  type MessagesTimelineRow,
  normalizeCompactToolLabel,
  resolveAssistantMessageCopyState,
  type StableMessagesTimelineRowsState,
} from "./MessagesTimeline.logic";
import { deriveReadableCommandDisplay } from "../../lib/toolCallLabel";
import { openWorkspaceFileReference, useWorkspaceFileOpener } from "../../lib/workspaceFileOpener";
import { isAgentActivityWorkEntry } from "./agentActivity.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
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
import {
  formatSubagentModelLabel,
  humanizeSubagentStatus,
  normalizeSubagentStatusKind,
  resolveSubagentPresentation,
} from "../../lib/subagentPresentation";
import { RiRobot3Line } from "react-icons/ri";
import { deriveUserMessagePreviewState } from "./userMessagePreview";

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
// The deep-link "active" ring is applied imperatively to the rendered marker spans so jumping
// never re-parses a message's markdown tree (the className is purely a CSS box-shadow).
const ACTIVE_MARKER_CLASS_NAME = "thread-marker-active";
const EMPTY_MESSAGE_MARKERS: readonly ThreadMarker[] = [];
const EMPTY_THREAD_MARKERS_BY_MESSAGE_ID = new Map<MessageId, readonly ThreadMarker[]>();

/**
 * Imperative handle the transcript exposes so the Environment panel's pinned-message
 * checklist can scroll the virtualized list to (and briefly flash) a specific message.
 */
export interface MessagesTimelineController {
  scrollToMessage: (messageId: MessageId) => void;
  scrollToMarker: (marker: ThreadMarker) => void;
}

const AgentTaskIcon: LucideIcon = (props) => (
  <RiRobot3Line className={props.className} style={props.style} />
);

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
  onIsAtEndChange?: (isAtEnd: boolean) => void;
  onMessagesClickCapture?: ComponentProps<typeof LegendList>["onClickCapture"];
  onMessagesMouseUp?: ComponentProps<typeof LegendList>["onMouseUp"];
  onMessagesPointerCancel?: ComponentProps<typeof LegendList>["onPointerCancel"];
  onMessagesPointerDown?: ComponentProps<typeof LegendList>["onPointerDown"];
  onMessagesPointerUp?: ComponentProps<typeof LegendList>["onPointerUp"];
  onMessagesScroll?: ComponentProps<typeof LegendList>["onScroll"];
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
  followLiveOutput = false,
  listRef,
  controllerRef,
  pinnedMessageIds,
  canPinMessage,
  onTogglePinMessage,
  threadMarkers = [],
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
  onIsAtEndChange,
  onMessagesClickCapture,
  onMessagesMouseUp,
  onMessagesPointerCancel,
  onMessagesPointerDown,
  onMessagesPointerUp,
  onMessagesScroll,
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
  const timelineExtraData = useMemo(
    () => ({
      editingUserMessageId,
      expandedCollapsedWork,
      expandedFileChangesByTurnId,
      expandedFileListByTurnId,
      expandedUserMessagesById,
      expandedWorkGroupsState,
      highlightedMessageId,
      pinnedMessageIds,
      submittingEditedUserMessageId,
      threadMarkersByMessageId,
    }),
    [
      editingUserMessageId,
      expandedCollapsedWork,
      expandedFileChangesByTurnId,
      expandedFileListByTurnId,
      expandedUserMessagesById,
      expandedWorkGroupsState,
      highlightedMessageId,
      pinnedMessageIds,
      submittingEditedUserMessageId,
      threadMarkersByMessageId,
    ],
  );
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
  }, [clearTailExpansionScrollTimers, resolvedListRef]);
  useEffect(() => clearTailExpansionScrollTimers, [clearTailExpansionScrollTimers]);
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
                  <SimpleWorkEntryRow
                    key={`work-row:${workEntry.id}`}
                    workEntry={workEntry}
                    chatMetaFontSizePx={appTypographyScale.chatMetaPx}
                    textFontSizePx={normalizedChatFontSizePx}
                    density={prefersCompactWorkEntryRow(workEntry) ? "compact" : "default"}
                    markdownCwd={markdownCwd}
                    onImageExpand={onImageExpand}
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
          const buildWorkDisplay = (
            workEntries: WorkLogEntry[],
            workGroupId: string | null,
          ) => {
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
                      <SimpleWorkEntryRow
                        key={`${placement}-tool-row:${row.message.id}:${workEntry.id}`}
                        workEntry={workEntry}
                        chatMetaFontSizePx={appTypographyScale.chatMetaPx}
                        textFontSizePx={normalizedChatFontSizePx}
                        density="compact"
                        fileDiffStatByPath={fileDiffStatByPath}
                        markdownCwd={markdownCwd}
                        onImageExpand={onImageExpand}
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
                    <SimpleWorkEntryRow
                      key={`${placement}-status-row:${row.message.id}:${workEntry.id}`}
                      workEntry={workEntry}
                      chatMetaFontSizePx={appTypographyScale.chatMetaPx}
                      textFontSizePx={normalizedChatFontSizePx}
                      density={prefersCompactWorkEntryRow(workEntry) ? "compact" : "default"}
                      markdownCwd={markdownCwd}
                      onImageExpand={onImageExpand}
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
          return (
            <>
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
                          item.kind === "work" ? (
                            <SimpleWorkEntryRow
                              key={`collapsed-work:${row.message.id}:${item.id}`}
                              workEntry={item.entry}
                              chatMetaFontSizePx={appTypographyScale.chatMetaPx}
                              textFontSizePx={normalizedChatFontSizePx}
                              density={
                                prefersCompactWorkEntryRow(item.entry) ? "compact" : "default"
                              }
                              markdownCwd={markdownCwd}
                              onImageExpand={onImageExpand}
                              onOpenToolDetails={openToolDetails}
                              {...(onOpenAgentActivity ? { onOpenAgentActivity } : {})}
                              {...(onOpenThread ? { onOpenThread } : {})}
                              {...(onOpenAutomation ? { onOpenAutomation } : {})}
                            />
                          ) : (
                            <div
                              key={`collapsed-narration:${row.message.id}:${item.id}`}
                              className="text-muted-foreground/80"
                            >
                              <ChatMarkdown
                                text={item.message.text}
                                cwd={markdownCwd}
                                isStreaming={false}
                                style={chatTypographyStyle}
                                onImageExpand={onImageExpand}
                              />
                            </div>
                          ),
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
                    isStreaming={Boolean(row.message.streaming)}
                    style={chatTypographyStyle}
                    onImageExpand={onImageExpand}
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
              Working for{" "}
              {nowIso ? (
                (formatWorkingTimer(row.createdAt, nowIso) ?? "0s")
              ) : (
                <WorkingTimer createdAt={row.createdAt} />
              )}
            </>
          ) : (
            "Working..."
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
        maintainScrollAtEnd={followLiveOutput}
        maintainScrollAtEndThreshold={0.1}
        {...(!followLiveOutput ? { maintainVisibleContentPosition: true } : {})}
        onClickCapture={onMessagesClickCapture}
        onMouseUp={onMessagesMouseUp}
        onPointerCancel={onMessagesPointerCancel}
        onPointerDown={onMessagesPointerDown}
        onPointerUp={onMessagesPointerUp}
        onScroll={handleListScroll}
        onTouchEnd={onMessagesTouchEnd}
        onTouchMove={onMessagesTouchMove}
        onTouchStart={onMessagesTouchStart}
        onWheel={onMessagesWheel}
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

function workToneIcon(tone: TimelineWorkEntry["tone"]): {
  icon: LucideIcon;
  className: string;
} {
  if (tone === "error") {
    return {
      icon: CircleAlertIcon,
      className: "text-muted-foreground/50",
    };
  }
  if (tone === "thinking") {
    return {
      icon: BotIcon,
      className: "text-muted-foreground/40",
    };
  }
  if (tone === "info") {
    return {
      icon: CheckIcon,
      className: "text-muted-foreground/50",
    };
  }
  return {
    icon: ZapIcon,
    className: "text-muted-foreground/45",
  };
}

/**
 * Try to extract a clean file path from a detail string that may contain JSON.
 * Handles patterns like:
 *   Read {"file_path":"/Users/foo/bar.ts","offset":10}
 *   {"file_path":"/path/to/file.ts"}
 */
function extractFilePathFromDetail(detail: string): string | null {
  const plainPathMatch = /^(.+?\.[A-Za-z0-9][A-Za-z0-9._-]*)(?::\d+)?(?::\d+)?$/u.exec(
    detail.trim(),
  );
  if (plainPathMatch?.[1]?.includes("/")) {
    return plainPathMatch[1].trim();
  }

  // Try to find a JSON-like object in the detail
  const jsonStart = detail.indexOf("{");
  if (jsonStart < 0) return null;
  const jsonEnd = detail.lastIndexOf("}");
  if (jsonEnd <= jsonStart) return null;
  try {
    const parsed = JSON.parse(detail.slice(jsonStart, jsonEnd + 1));
    const filePath = parsed.file_path ?? parsed.filePath ?? parsed.path ?? parsed.filename ?? null;
    if (typeof filePath === "string" && filePath.trim().length > 0) {
      return filePath.trim();
    }
  } catch {
    // Not valid JSON — try regex fallback
    const match = /"(?:file_path|filePath|path|filename)"\s*:\s*"([^"]+)"/i.exec(detail);
    if (match?.[1]) return match[1];
  }
  return null;
}

function workEntryPreview(
  workEntry: Pick<
    TimelineWorkEntry,
    | "detail"
    | "command"
    | "rawCommand"
    | "preview"
    | "changedFiles"
    | "requestKind"
    | "itemType"
    | "subagents"
    | "subagentAction"
  >,
): string | null {
  const isFileRelated =
    workEntry.requestKind === "file-read" ||
    workEntry.requestKind === "file-change" ||
    workEntry.itemType === "file_change";

  if (workEntry.itemType === "command_execution" || workEntry.command || workEntry.rawCommand) {
    const command = workEntry.command ?? workEntry.rawCommand;
    if (command) return deriveReadableCommandDisplay(command).target;
  }

  if (workEntry.preview) return workEntry.preview;

  // Prefer clean basenames from changedFiles
  if (workEntry.changedFiles && workEntry.changedFiles.length > 0) {
    const names = workEntry.changedFiles.map((p) => basename(p));
    if (names.length === 1) return names[0]!;
    return `${names.length} files`;
  }

  if (workEntry.itemType === "collab_agent_tool_call" && (workEntry.subagents?.length ?? 0) > 0) {
    if (workEntry.subagentAction?.summaryText) {
      return workEntry.subagentAction.summaryText;
    }
    const labels = workEntry.subagents!.map((subagent) => {
      const presentation = subagentPrimaryLabel(subagent);
      return presentation.nickname ?? presentation.primaryLabel ?? basename(subagent.threadId);
    });
    return labels.length === 1 ? labels[0]! : `${labels.length} subagents`;
  }

  if (workEntry.itemType === "collab_agent_tool_call") {
    return workEntry.detail ?? workEntry.subagentAction?.prompt ?? null;
  }

  // For detail, try to extract a clean file path first
  if (workEntry.detail) {
    const filePath = extractFilePathFromDetail(workEntry.detail);
    if (filePath) return basename(filePath);

    // For file-related entries, the heading alone is enough — don't show raw JSON
    if (isFileRelated) return null;

    // For other entries, if the detail looks like raw JSON, skip it
    const trimmedDetail = workEntry.detail.trim();
    if (trimmedDetail.startsWith("{") || trimmedDetail.startsWith("[")) return null;

    const readLinesMatch = /^Read\s+(\d+\s+lines?)$/i.exec(trimmedDetail);
    if (readLinesMatch?.[1]) return readLinesMatch[1];

    // Clean, non-JSON detail — show it
    return trimmedDetail;
  }

  return null;
}

// Provider read tools (e.g. Claude's `Read`) arrive as generic dynamic tool calls
// without a `file-read` requestKind, so match their tool name to surface the search icon
// instead of the generic tool/wrench fallback.
function isFileReadToolEntry(workEntry: TimelineWorkEntry): boolean {
  const name = (workEntry.toolName ?? "").toLowerCase().replace(/[^a-z]/g, "");
  return name === "read" || name === "readfile" || name === "viewfile";
}

function workEntryIcon(workEntry: TimelineWorkEntry): LucideIcon {
  if (workEntry.requestKind === "command") return TerminalIcon;
  if (workEntry.requestKind === "file-read") return SearchIcon;
  if (workEntry.requestKind === "file-change") return SquarePenIcon;

  if (workEntry.itemType === "command_execution" || workEntry.command) {
    return TerminalIcon;
  }
  if (workEntry.itemType === "file_change") {
    return SquarePenIcon;
  }
  if (workEntry.itemType === "web_search") return WebSearchIcon;
  if (workEntry.itemType === "image_generation") return ZapIcon;
  if (workEntry.itemType === "image_view") return EyeIcon;
  if (isFileReadToolEntry(workEntry)) return SearchIcon;

  switch (workEntry.itemType) {
    case "mcp_tool_call":
      return SkillCubeIcon;
    case "dynamic_tool_call":
      return HammerIcon;
    case "collab_agent_tool_call":
      return AgentTaskIcon;
  }

  return workToneIcon(workEntry.tone).icon;
}

function isGitHubMcpToolCall(workEntry: TimelineWorkEntry): boolean {
  const toolName = workEntry.toolName?.trim().toLowerCase();
  return Boolean(toolName?.startsWith("mcp__codex_apps__github"));
}

// Render command, agent-task, and file-change rows at the tighter compact density.
function prefersCompactWorkEntryRow(workEntry: TimelineWorkEntry): boolean {
  const EntryIcon = workEntryIcon(workEntry);
  return (
    EntryIcon === TerminalIcon ||
    EntryIcon === HammerIcon ||
    EntryIcon === AgentTaskIcon ||
    EntryIcon === SquarePenIcon ||
    EntryIcon === SkillCubeIcon
  );
}

function capitalizePhrase(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return value;
  }
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

function toolWorkEntryHeading(workEntry: TimelineWorkEntry): string {
  if (!workEntry.toolTitle) {
    return capitalizePhrase(normalizeCompactToolLabel(workEntry.label));
  }
  return capitalizePhrase(normalizeCompactToolLabel(workEntry.toolTitle));
}

function normalizeWorkDisplayText(value: string): string {
  return normalizeCompactToolLabel(value).toLowerCase().replace(/\s+/g, " ").trim();
}

function combineWorkEntryDisplayText(heading: string, preview: string | null): string {
  if (!preview) {
    return heading;
  }
  return normalizeWorkDisplayText(heading) === normalizeWorkDisplayText(preview)
    ? heading
    : `${heading} ${preview}`;
}

function isFileChangeWorkEntry(workEntry: TimelineWorkEntry): boolean {
  return isFileChangeWorkLogEntry(workEntry);
}

function subagentPrimaryLabel(
  subagent: NonNullable<TimelineWorkEntry["subagents"]>[number],
): ReturnType<typeof resolveSubagentPresentation> {
  return resolveSubagentPresentation({
    nickname: subagent.nickname,
    role: subagent.role,
    title: subagent.title,
    fallbackId: subagent.threadId,
  });
}

function subagentSecondaryLabel(
  subagent: NonNullable<TimelineWorkEntry["subagents"]>[number],
  primaryLabel: string,
): string | null {
  const parts = [subagent.title, formatSubagentModelLabel(subagent.model)]
    .filter((value): value is string => Boolean(value))
    .filter((value) => value !== primaryLabel);
  if (parts.length === 0) {
    return null;
  }
  return parts.join(" • ");
}

function subagentStatusClasses(
  statusLabel: string | undefined,
  rawStatus: string | undefined,
  isActive: boolean | undefined,
): string {
  switch (normalizeSubagentStatusKind(statusLabel ?? rawStatus, isActive)) {
    case "running":
      return "border-sky-500/18 bg-sky-500/8 text-sky-200/90";
    case "completed":
      return "border-emerald-500/18 bg-emerald-500/8 text-emerald-200/90";
    case "failed":
      return "border-rose-500/18 bg-rose-500/8 text-rose-200/90";
    case "stopped":
      return "border-amber-500/18 bg-amber-500/8 text-amber-200/90";
    case "queued":
      return "border-violet-500/18 bg-violet-500/8 text-violet-200/90";
    case "idle":
    default:
      return "border-border/45 bg-background/85 text-muted-foreground/68";
  }
}

function subagentCardSummary(workEntry: TimelineWorkEntry): string {
  return (
    workEntry.subagentAction?.summaryText ??
    workEntryPreview(workEntry) ??
    toolWorkEntryHeading(workEntry)
  );
}

function subagentCardMeta(workEntry: TimelineWorkEntry): string | null {
  const modelLabel = formatSubagentModelLabel(workEntry.subagentAction?.model);
  if (modelLabel && workEntry.subagentAction?.prompt) {
    return `${modelLabel} • ${workEntry.subagentAction.prompt}`;
  }
  return modelLabel ?? workEntry.subagentAction?.prompt ?? null;
}

function commandTooltipContent(command: string, displayText: string) {
  return (
    <div className="max-w-96 whitespace-pre-wrap leading-tight">
      <div className="space-y-2">
        <div className="space-y-0.5">
          <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground/70">
            Summary
          </div>
          <div>{displayText}</div>
        </div>
        <div className="space-y-0.5">
          <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground/70">
            Raw call
          </div>
          <code className="block whitespace-pre-wrap break-words font-chat-code text-[11px] text-foreground/92">
            {command}
          </code>
        </div>
      </div>
    </div>
  );
}

const SimpleWorkEntryRow = memo(function SimpleWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
  chatMetaFontSizePx: number;
  textFontSizePx?: number;
  density?: "default" | "compact";
  fileDiffStatByPath?: ReadonlyMap<string, { additions: number; deletions: number }>;
  markdownCwd: string | undefined;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  turnId?: TurnId;
  onOpenTurnDiff?: (turnId: TurnId, filePath?: string) => void;
  onOpenToolDetails?: (workEntry: TimelineWorkEntry) => void;
  onOpenAgentActivity?: (activityId: string) => void;
  onOpenThread?: (threadId: ThreadId) => void;
  onOpenAutomation?: (automationId: string) => void;
}) {
  const {
    workEntry,
    chatMetaFontSizePx,
    textFontSizePx = chatMetaFontSizePx,
    density = "default",
    fileDiffStatByPath,
    markdownCwd,
    onImageExpand,
    turnId,
    onOpenTurnDiff,
    onOpenToolDetails,
    onOpenAgentActivity,
    onOpenThread,
    onOpenAutomation,
  } = props;
  const compact = density === "compact";
  const EntryIcon = workEntryIcon(workEntry);
  // Every tool row leads with a single left icon; keep branded glyphs for GitHub/MCP rows.
  const isGitHubToolRow = isGitHubMcpToolCall(workEntry);
  const isMcpToolRow = workEntry.itemType === "mcp_tool_call" && !isGitHubToolRow;
  const LeftIcon = isGitHubToolRow ? GitHubIcon : isMcpToolRow ? McpIcon : EntryIcon;
  const leftIconKind = isGitHubToolRow ? "github" : isMcpToolRow ? "mcp" : undefined;
  const heading = toolWorkEntryHeading(workEntry);
  const preview = workEntryPreview(workEntry);
  const displayText = combineWorkEntryDisplayText(heading, preview);
  const showInlineAgentTaskPreview =
    workEntry.itemType === "collab_agent_tool_call" &&
    (workEntry.subagents?.length ?? 0) === 0 &&
    Boolean(preview) &&
    normalizeWorkDisplayText(heading) !== normalizeWorkDisplayText(preview ?? "");
  const rawCommand = workEntry.rawCommand ?? workEntry.command;
  const hoverText = rawCommand ?? (showInlineAgentTaskPreview ? heading : displayText);
  const changedFiles = workEntry.changedFiles ?? [];
  const showEditedRows = isFileChangeWorkEntry(workEntry) && changedFiles.length > 0;
  const showSubagentRows =
    workEntry.itemType === "collab_agent_tool_call" && (workEntry.subagents?.length ?? 0) > 0;
  const visibleSubagents = workEntry.subagents?.slice(0, 3) ?? [];
  const hiddenSubagentCount = Math.max(
    0,
    (workEntry.subagents?.length ?? 0) - visibleSubagents.length,
  );
  const subagentSummary = subagentCardSummary(workEntry);
  const subagentMeta = subagentCardMeta(workEntry);
  const canOpenAgentActivity = Boolean(onOpenAgentActivity) && isAgentActivityWorkEntry(workEntry);
  const openAgentActivity = canOpenAgentActivity
    ? () => onOpenAgentActivity?.(workEntry.id)
    : undefined;
  const canOpenToolDetails = Boolean(onOpenToolDetails) && Boolean(workEntry.toolDetails);
  // File-read rows open the referenced file in the in-app viewer when the
  // hosting surface provides an opener (right-dock file pane / editor pane).
  const opener = useWorkspaceFileOpener();

  // A created-automation row renders as its own card instead of a tool-call line.
  // Kept after the lone hook above so the early return never changes hook order.
  const automation = workEntry.automation;
  if (automation) {
    return (
      <div className={cn(compact ? "py-0.5" : "py-1")}>
        <AutomationCreatedCard
          name={automation.name}
          cadenceLabel={automation.cadenceLabel}
          textFontSizePx={textFontSizePx}
          metaFontSizePx={chatMetaFontSizePx}
          {...(onOpenAutomation ? { onOpen: () => onOpenAutomation(automation.id) } : {})}
        />
      </div>
    );
  }

  const readFilePath =
    opener !== null &&
    !canOpenAgentActivity &&
    workEntry.detail &&
    (workEntry.requestKind === "file-read" || isFileReadToolEntry(workEntry))
      ? extractFilePathFromDetail(workEntry.detail)
      : null;
  const canOpenReadFile = readFilePath !== null;
  const openReadFile = readFilePath
    ? () => openWorkspaceFileReference(opener, readFilePath)
    : undefined;
  const prefetchReadFile =
    readFilePath && opener?.prefetchFile ? () => opener.prefetchFile?.(readFilePath) : undefined;

  // Use the text font size (matching the UI settings) for tool call rows
  const rowFontSizePx = textFontSizePx;

  return (
    <div className={cn(compact ? "py-0.5" : "rounded-lg py-1")}>
      {showEditedRows ? (
        <div className="space-y-0.5">
          {changedFiles.map((changedFilePath) => {
            const changedFileStat = fileDiffStatByPath?.get(changedFilePath);
            const canOpenEditedDiff = Boolean(turnId && onOpenTurnDiff);
            const canOpenEditedRow = canOpenToolDetails || canOpenEditedDiff;
            const editedRowClassName = cn(
              "group/file-row flex w-full max-w-full items-center text-left transition-colors duration-150",
              compact ? "gap-1.5" : "gap-2",
              canOpenEditedRow ? "cursor-pointer focus-visible:outline-none" : "cursor-default",
            );
            const editedRowChildren = (
              <EditedFileRowContent
                filePath={changedFilePath}
                additions={changedFileStat?.additions}
                deletions={changedFileStat?.deletions}
                fontSizePx={rowFontSizePx}
                compact={compact}
              />
            );
            if (canOpenToolDetails && workEntry.toolDetails) {
              return (
                <ToolDetailsDisclosure
                  key={`${workEntry.id}:${changedFilePath}`}
                  details={workEntry.toolDetails}
                  compact={compact}
                  title="View tool details"
                  summaryClassName={editedRowClassName}
                  dataFileChangeRow
                >
                  {editedRowChildren}
                </ToolDetailsDisclosure>
              );
            }
            return (
              <button
                key={`${workEntry.id}:${changedFilePath}`}
                type="button"
                data-file-change-row="true"
                className={editedRowClassName}
                title={changedFilePath}
                disabled={!canOpenEditedRow}
                onClick={() => {
                  if (!turnId || !onOpenTurnDiff) {
                    return;
                  }
                  onOpenTurnDiff(turnId, changedFilePath);
                }}
              >
                {editedRowChildren}
              </button>
            );
          })}
        </div>
      ) : showSubagentRows ? (
        <div className="space-y-1.5">
          <AgentActivityOpenSurface
            canOpen={canOpenAgentActivity}
            compact={compact}
            title={hoverText}
            onOpen={openAgentActivity}
          >
            <span
              className={cn(
                "flex shrink-0 items-center justify-center text-muted-foreground/40",
                compact ? "size-4" : "size-5",
              )}
            >
              <EntryIcon className={compact ? "size-2.5" : "size-3"} />
            </span>
            <div className="min-w-0 flex-1 overflow-hidden">
              <p
                className={cn(
                  compact ? "truncate leading-5" : "truncate leading-6",
                  "font-medium text-foreground/72",
                )}
                style={{ fontSize: `${rowFontSizePx}px` }}
                title={hoverText}
              >
                <span>{subagentSummary}</span>
              </p>
              {subagentMeta ? (
                <p
                  className="truncate leading-4 text-muted-foreground/32"
                  style={{ fontSize: `${Math.max(11, rowFontSizePx - 1)}px` }}
                  title={subagentMeta}
                >
                  {subagentMeta}
                </p>
              ) : null}
            </div>
          </AgentActivityOpenSurface>
          {visibleSubagents.length > 0 || hiddenSubagentCount > 0 ? (
            <div
              className={cn(
                "space-y-[5px] rounded-[14px] border border-border/45 bg-background/50 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]",
                compact ? "px-2.5 py-2" : "px-3 py-[9px]",
              )}
            >
              {visibleSubagents.map((subagent) => {
                const presentation = subagentPrimaryLabel(subagent);
                const primaryLabel = presentation.primaryLabel;
                const secondaryLabel = subagentSecondaryLabel(subagent, primaryLabel);
                const displayStatusLabel =
                  subagent.statusLabel ??
                  humanizeSubagentStatus(subagent.rawStatus, subagent.isActive);
                const canOpenThread = Boolean(onOpenThread);
                return (
                  <div
                    key={`${workEntry.id}:${subagent.threadId}`}
                    className="flex items-start gap-2.5 rounded-xl border border-border/28 bg-background/82 px-[11px] py-2"
                  >
                    <span
                      className={cn(
                        "mt-1.5 size-1.5 shrink-0 rounded-full",
                        subagent.isActive ? "bg-sky-300/95" : "bg-muted-foreground/22",
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <div
                        className="truncate font-semibold leading-[18px] text-foreground/90"
                        style={{ fontSize: `${rowFontSizePx}px` }}
                        title={presentation.fullLabel}
                      >
                        <span style={{ color: presentation.accentColor }}>
                          {presentation.nickname ?? primaryLabel}
                        </span>
                        {presentation.role ? (
                          <span className="ml-1 text-[11px] font-medium text-muted-foreground/48">
                            ({presentation.role})
                          </span>
                        ) : null}
                      </div>
                      {secondaryLabel ? (
                        <div
                          className="truncate pt-0.5 leading-4 text-muted-foreground/56"
                          style={{ fontSize: `${Math.max(11, rowFontSizePx - 1)}px` }}
                          title={secondaryLabel}
                        >
                          {secondaryLabel}
                        </div>
                      ) : null}
                      {subagent.latestUpdate ? (
                        <div
                          className="flex items-baseline gap-1.5 pt-1 text-muted-foreground/42"
                          style={{ fontSize: `${Math.max(10, rowFontSizePx - 2)}px` }}
                          title={subagent.latestUpdate}
                        >
                          <span className="shrink-0 uppercase tracking-[0.14em] text-muted-foreground/30">
                            Latest
                          </span>
                          <span className="truncate">{subagent.latestUpdate}</span>
                        </div>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      {displayStatusLabel ? (
                        <span
                          className={cn(
                            "shrink-0 rounded-full border px-2 py-0.5 text-[9px] font-medium tracking-[0.08em]",
                            subagentStatusClasses(
                              displayStatusLabel,
                              subagent.rawStatus,
                              subagent.isActive,
                            ),
                          )}
                        >
                          {displayStatusLabel}
                        </span>
                      ) : null}
                      <button
                        type="button"
                        className={cn(
                          "shrink-0 rounded-full border border-border/45 px-2.5 py-1 text-[9px] font-medium uppercase tracking-[0.12em] text-muted-foreground/62 transition-colors",
                          canOpenThread
                            ? "hover:border-foreground/15 hover:text-foreground/84"
                            : "cursor-default opacity-50",
                        )}
                        disabled={!canOpenThread}
                        onClick={() =>
                          onOpenThread?.(
                            ThreadId.makeUnsafe(subagent.resolvedThreadId ?? subagent.threadId),
                          )
                        }
                      >
                        Open thread
                      </button>
                    </div>
                  </div>
                );
              })}
              {hiddenSubagentCount > 0 ? (
                <div className="pl-4 text-[10px] uppercase tracking-[0.12em] text-muted-foreground/46">
                  +{hiddenSubagentCount} more
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : (
        (() => {
          const rowContentChildren = (
            <>
              <span
                className={cn(
                  "flex shrink-0 items-center justify-center text-muted-foreground/40 transition-colors group-hover/tool-row:text-foreground group-focus-visible/tool-row:text-foreground",
                  compact ? "size-4" : "size-5",
                )}
                data-tool-icon={leftIconKind}
              >
                <LeftIcon className={compact ? "size-3.5" : "size-4"} />
              </span>
              <div
                className={cn(
                  "min-w-0 overflow-hidden",
                  // Single-line tool labels size to their content so the disclosure
                  // chevron can sit right after the name; the multi-line markdown
                  // preview still needs the full row width.
                  showInlineAgentTaskPreview && "flex-1",
                )}
              >
                {showInlineAgentTaskPreview ? (
                  <div className={cn(compact ? "space-y-[1px]" : "space-y-0.5")}>
                    <p
                      className="truncate font-medium leading-5 text-muted-foreground/72"
                      style={{ fontSize: `${rowFontSizePx}px` }}
                    >
                      {heading}
                    </p>
                    <ChatMarkdown
                      text={preview ?? ""}
                      cwd={markdownCwd}
                      isStreaming={false}
                      className="leading-relaxed"
                      style={{
                        color: "color-mix(in srgb, var(--muted-foreground) 72%, transparent)",
                        fontSize: `${Math.max(11, rowFontSizePx - 1)}px`,
                        lineHeight: compact ? "18px" : "19px",
                      }}
                      onImageExpand={onImageExpand}
                    />
                  </div>
                ) : (
                  <p
                    className={cn(
                      compact ? "truncate leading-5" : "truncate leading-6",
                      // Match the leading icon's tone so the row reads as one muted unit, and
                      // brighten the whole row to foreground on hover/focus instead of a fill.
                      "text-muted-foreground/40 transition-colors group-hover/tool-row:text-foreground group-focus-visible/tool-row:text-foreground",
                    )}
                    style={{ fontSize: `${rowFontSizePx}px` }}
                  >
                    <span data-work-entry-display-text="true">{displayText}</span>
                  </p>
                )}
              </div>
            </>
          );
          if (canOpenToolDetails && workEntry.toolDetails) {
            return (
              <ToolDetailsDisclosure
                details={workEntry.toolDetails}
                compact={compact}
                title={rawCommand ?? displayText}
              >
                {rowContentChildren}
              </ToolDetailsDisclosure>
            );
          }

          const rowContent = (
            <AgentActivityOpenSurface
              canOpen={canOpenAgentActivity || canOpenReadFile}
              compact={compact}
              title={canOpenReadFile ? (readFilePath ?? hoverText) : hoverText}
              onOpen={openAgentActivity ?? openReadFile}
              onHover={prefetchReadFile}
            >
              {rowContentChildren}
            </AgentActivityOpenSurface>
          );

          if (!rawCommand) {
            return rowContent;
          }

          return (
            <Tooltip>
              <TooltipTrigger render={rowContent} />
              <TooltipPopup side="top" align="start" className="max-w-96 whitespace-normal">
                {commandTooltipContent(rawCommand, displayText)}
              </TooltipPopup>
            </Tooltip>
          );
        })()
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

function AgentActivityOpenSurface(props: {
  canOpen: boolean;
  children: ReactNode;
  compact: boolean;
  /** Warm-up hook fired on hover/focus so opening feels instant. */
  onHover?: (() => void) | undefined;
  onOpen?: (() => void) | undefined;
  title?: string | undefined;
  dataToolDetailTrigger?: boolean | undefined;
}) {
  const className = cn(
    "group/tool-row flex w-full items-center text-left transition-[opacity,translate] duration-200",
    props.compact ? "gap-1.5" : "gap-2",
    props.canOpen ? "cursor-pointer focus-visible:outline-none" : "cursor-default",
  );

  if (props.canOpen) {
    return (
      <button
        type="button"
        className={className}
        title={props.title}
        onClick={props.onOpen}
        data-tool-detail-trigger={props.dataToolDetailTrigger ? "true" : undefined}
        {...(props.onHover ? { onPointerEnter: props.onHover, onFocus: props.onHover } : {})}
      >
        {props.children}
      </button>
    );
  }

  return (
    <div className={className} title={props.title}>
      {props.children}
    </div>
  );
}

function ToolDetailsDisclosure(props: {
  children: ReactNode;
  compact: boolean;
  dataFileChangeRow?: boolean | undefined;
  details: NonNullable<TimelineWorkEntry["toolDetails"]>;
  summaryClassName?: string | undefined;
  title?: string | undefined;
}) {
  const summaryClassName =
    props.summaryClassName ??
    cn(
      "group/tool-row flex w-full items-center text-left transition-[opacity,translate] duration-200",
      props.compact ? "gap-1.5" : "gap-2",
      "cursor-pointer focus-visible:outline-none",
    );
  const [hasOpened, setHasOpened] = useState(false);

  return (
    <details
      className="group/tool-details min-w-0"
      onToggle={(event) => {
        if (event.currentTarget.open) {
          setHasOpened(true);
        }
      }}
    >
      <summary
        className={cn("list-none [&::-webkit-details-marker]:hidden", summaryClassName)}
        title={props.title ?? "View tool details"}
        data-file-change-row={props.dataFileChangeRow ? "true" : undefined}
        data-tool-detail-trigger="true"
      >
        {props.children}
        <ChevronRightIcon
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground/38 transition-[transform,color] duration-200 group-hover/tool-row:text-foreground group-hover/file-row:text-foreground group-focus-visible/tool-row:text-foreground group-focus-visible/file-row:text-foreground group-open/tool-details:rotate-90"
        />
      </summary>
      {hasOpened ? (
        <div
          className={cn("mt-2 min-w-0", props.compact ? "ml-5" : "ml-7")}
          data-tool-details-inline="true"
        >
          <ToolCallDetailsContent details={props.details} />
        </div>
      ) : null}
    </details>
  );
}
