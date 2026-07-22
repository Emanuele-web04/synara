// FILE: TimelineWorkEntryRow.tsx
// Purpose: Renders transcript work/tool rows and their inline details.
// Layer: Web chat presentation component
// Exports: TimelineWorkEntryRow, EditedFileRowContent, prefersCompactWorkEntryRow

import { ThreadId, type TurnId } from "@synara/contracts";
import {
  createElement,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";

import { basenameOfPath } from "~/file-icons";
import {
  ArrowUpCircleIcon,
  BackgroundTrayIcon,
  BotIcon,
  CheckIcon,
  CircleAlertIcon,
  CircleQuestionIcon,
  EyeIcon,
  GitHubIcon,
  HammerIcon,
  type LucideIcon,
  McpIcon,
  PencilIcon,
  SearchIcon,
  SkillCubeIcon,
  TerminalIcon,
  WebSearchIcon,
  ZapIcon,
} from "~/lib/icons";
import { describeLinkChip } from "~/lib/linkChips";
import { cn } from "~/lib/utils";

import { isFileChangeWorkLogEntry, type WorkLogEntry } from "../../session-logic";
import {
  formatAgentActivityEntryPreview,
  isAgentActivityWorkEntry,
  isCodexActivityStatusWorkEntry,
  isReasoningUpdateWorkEntry,
} from "./agentActivity.logic";
import { AutomationCreatedCard } from "./AutomationCreatedCard";
import ChatMarkdown from "../ChatMarkdown";
import { DiffStatLabel } from "./DiffStatLabel";
import { type ExpandedImagePreview } from "./ExpandedImagePreview";
import { LinkChipIcon } from "../LinkChipIcon";
import { normalizeCompactToolLabel } from "./MessagesTimeline.logic";
import { SynaraLogo } from "../SynaraLogo";
import type { SubagentToolTrace } from "./subagentToolTrace.logic";
import { ToolCallDetailsContent } from "./ToolCallDetailsDialog";
import { DisclosureChevron } from "../ui/DisclosureChevron";
import { DisclosureRegion } from "../ui/DisclosureRegion";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { fileDiffStatsByPath, resolveFileDiffStatByChangedPath } from "~/lib/diffRendering";
import {
  extractToolArgumentField,
  isPrefixedToolArgumentSummary,
} from "../../lib/toolArgumentSummary";
import {
  deriveReadableCommandDisplay,
  deriveSynaraMcpToolTitle,
  extractWebFetchUrl,
  normalizeToolTextForComparison,
  resolveCommandVisualKind,
  sanitizeSynaraMcpToolPreview,
  type SynaraMcpToolStatus,
} from "../../lib/toolCallLabel";
import { openWorkspaceFileReference, useWorkspaceFileOpener } from "../../lib/workspaceFileOpener";
import {
  formatSubagentModelLabel,
  humanizeSubagentStatus,
  normalizeSubagentStatusKind,
  resolveSubagentPresentation,
} from "../../lib/subagentPresentation";

const TRANSCRIPT_DISCLOSURE_TRANSITION_MS = 220;
const TRANSCRIPT_DISCLOSURE_CLEANUP_BUFFER_MS = 40;
const WORK_ROW_MUTED_HOVER_TONE: Record<"tool-row" | "file-row", string> = {
  "tool-row":
    "text-muted-foreground/70 transition-colors group-hover/tool-row:text-foreground group-focus-visible/tool-row:text-foreground",
  "file-row":
    "text-muted-foreground/70 transition-colors group-hover/file-row:text-foreground group-focus-visible/file-row:text-foreground",
};
const EMPTY_FILE_DIFF_STATS: ReadonlyMap<string, { additions: number; deletions: number }> =
  new Map();

type TimelineWorkEntry = WorkLogEntry;

const AgentTaskIcon: LucideIcon = (props) => <BotIcon {...props} />;

const SynaraToolIcon: LucideIcon = ({ className, ...props }) => (
  <SynaraLogo {...props} className={cn("text-current", className)} />
);

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
  // "path" is generic enough that a nested match (e.g. inside a config object)
  // may not be the file the tool acted on — only regex-scan truncated JSON.
  return extractToolArgumentField(detail, ["file_path", "filePath", "path", "filename"], {
    fallbackScan: "whenUnparsed",
  });
}

function workEntryPreview(workEntry: TimelineWorkEntry): string | null {
  if (isReasoningUpdateWorkEntry(workEntry)) {
    return formatAgentActivityEntryPreview(workEntry);
  }
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
    const names = workEntry.changedFiles.map((p) => basenameOfPath(p));
    if (names.length === 1) return names[0]!;
    return `${names.length} files`;
  }

  if (workEntry.itemType === "collab_agent_tool_call" && (workEntry.subagents?.length ?? 0) > 0) {
    if (workEntry.subagentAction?.summaryText) {
      return workEntry.subagentAction.summaryText;
    }
    const labels = workEntry.subagents!.map((subagent) => {
      const presentation = subagentPrimaryLabel(subagent);
      return (
        presentation.nickname ?? presentation.primaryLabel ?? basenameOfPath(subagent.threadId)
      );
    });
    return labels.length === 1 ? labels[0]! : `${labels.length} subagents`;
  }

  if (workEntry.itemType === "collab_agent_tool_call") {
    return workEntry.detail ?? workEntry.subagentAction?.prompt ?? null;
  }

  // For detail, try to extract a clean file path first
  if (workEntry.detail) {
    const filePath = extractFilePathFromDetail(workEntry.detail);
    if (filePath) return basenameOfPath(filePath);

    // For file-related entries, the heading alone is enough — don't show raw JSON
    if (isFileRelated) return null;

    // For other entries, if the detail looks like raw JSON, skip it
    const trimmedDetail = workEntry.detail.trim();
    if (trimmedDetail.startsWith("{") || trimmedDetail.startsWith("[")) return null;

    // Dynamic/MCP tool calls surface their arguments as `ToolName: {json}` —
    // transport detail, not a human summary. The raw call stays in toolDetails.
    // Failed calls keep their detail inline: it may carry the error text (e.g.
    // an MCP error serialized as `McpError: {json}`), and on a failure more
    // information beats a tidy row.
    if (toolWorkEntryStatus(workEntry) !== "failed" && isPrefixedToolArgumentSummary(trimmedDetail))
      return null;

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

// Command rows reuse toolCallLabel's wrapper-aware classifier so wrapped git/gh
// commands get the GitHub mark while ordinary commands keep the terminal icon.
function commandWorkEntryIcon(workEntry: TimelineWorkEntry): LucideIcon {
  const command = workEntry.command ?? workEntry.rawCommand;
  switch (command ? resolveCommandVisualKind(command) : "terminal") {
    case "inspect":
      return SearchIcon;
    case "git":
    case "github":
      return GitHubIcon;
    case "terminal":
      return TerminalIcon;
  }
}

function workEntryIcon(workEntry: TimelineWorkEntry): LucideIcon {
  // User-input rows read as a question (awaiting an answer) and an upload
  // (answer submitted) rather than the generic "info" checkmark.
  if (workEntry.activityKind === "user-input.requested") return CircleQuestionIcon;
  if (workEntry.activityKind === "user-input.resolved") return ArrowUpCircleIcon;
  // "Moved to background" notices read as a tray drop, not a warning check.
  if (workEntry.nativeEventType === "background_tasks_changed") return BackgroundTrayIcon;

  if (workEntry.requestKind === "command") return commandWorkEntryIcon(workEntry);
  if (workEntry.requestKind === "file-read") return SearchIcon;
  if (workEntry.requestKind === "file-change") return PencilIcon;

  if (workEntry.itemType === "command_execution" || workEntry.command) {
    return commandWorkEntryIcon(workEntry);
  }
  if (workEntry.itemType === "file_change") {
    return PencilIcon;
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

// Dynamic icon selection is data, not a component declaration. Keeping the
// createElement call in this module helper avoids presenting a render-local
// component binding to React Compiler.
export function renderWorkEntryIcon(Icon: LucideIcon, className: string): ReactElement {
  return createElement(Icon, { className });
}

// The leading glyph for a tool row: provider-brand marks (GitHub, Synara, MCP)
// win over the kind-derived entry icon. Shared with the collapsed tool-group
// summary row, which borrows its first entry's icon.
export function workEntryLeftIcon(workEntry: TimelineWorkEntry): LucideIcon {
  if (isGitHubMcpToolCall(workEntry)) return GitHubIcon;
  if (isSynaraToolCall(workEntry)) return SynaraToolIcon;
  if (workEntry.itemType === "mcp_tool_call") return McpIcon;
  return workEntryIcon(workEntry);
}

function isGitHubMcpToolCall(workEntry: TimelineWorkEntry): boolean {
  const toolName = workEntry.toolName?.trim().toLowerCase();
  return Boolean(toolName?.startsWith("mcp__codex_apps__github"));
}

// Synara's own agent-gateway tools (synara_list_threads, synara_create_thread,
// ...) get the Synara mark instead of the generic MCP glyph. Providers report
// the call differently: Claude prefixes the MCP server (mcp__synara__*), ACP
// agents surface the bare tool name (synara_*), and Codex reports server/tool
// pairs that the label humanizer renders as "Synara: ...".
function toolWorkEntryStatus(workEntry: TimelineWorkEntry): SynaraMcpToolStatus {
  if (workEntry.toolStatus) return workEntry.toolStatus;
  return workEntry.activityKind !== undefined && workEntry.activityKind !== "tool.completed"
    ? "running"
    : "completed";
}

function isSynaraToolCall(workEntry: TimelineWorkEntry): boolean {
  return (
    deriveSynaraMcpToolTitle({
      toolName: workEntry.toolName,
      title: workEntry.toolTitle,
      fallbackLabel: workEntry.label,
      status: toolWorkEntryStatus(workEntry),
    }) !== null
  );
}

// Render command, agent-task, file-change, and file-read rows at the tighter
// compact density so every tool-call line shares one height regardless of whether
// it carries a disclosure chevron.
export function prefersCompactWorkEntryRow(workEntry: TimelineWorkEntry): boolean {
  if (isCodexActivityStatusWorkEntry(workEntry)) {
    return true;
  }
  // Commands stay compact even when surfaced with a non-terminal icon (read-only
  // inspections like `cat` now use the file-read search icon).
  if (workEntry.itemType === "command_execution" || workEntry.command || workEntry.rawCommand) {
    return true;
  }
  const EntryIcon = workEntryIcon(workEntry);
  return (
    EntryIcon === TerminalIcon ||
    EntryIcon === HammerIcon ||
    EntryIcon === AgentTaskIcon ||
    EntryIcon === PencilIcon ||
    EntryIcon === SkillCubeIcon ||
    // File-read / inspect rows (e.g. `Read …`) surface the search icon and have no
    // disclosure chevron; keep them at the same compact height as command rows.
    EntryIcon === SearchIcon
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
  const synaraTitle = deriveSynaraMcpToolTitle({
    toolName: workEntry.toolName,
    title: workEntry.toolTitle,
    fallbackLabel: workEntry.label,
    status: toolWorkEntryStatus(workEntry),
  });
  if (synaraTitle) {
    return synaraTitle;
  }
  if (!workEntry.toolTitle) {
    return capitalizePhrase(normalizeCompactToolLabel(workEntry.label));
  }
  return capitalizePhrase(normalizeCompactToolLabel(workEntry.toolTitle));
}

function combineWorkEntryDisplayText(heading: string, preview: string | null): string {
  if (!preview) {
    return heading;
  }
  return normalizeToolTextForComparison(heading) === normalizeToolTextForComparison(preview)
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
          <div className="text-muted-foreground/70">Summary</div>
          <div>{displayText}</div>
        </div>
        <div className="space-y-0.5">
          <div className="text-muted-foreground/70">Raw call</div>
          <code className="block whitespace-pre-wrap break-words font-chat-code text-[11px] text-foreground/92">
            {command}
          </code>
        </div>
      </div>
    </div>
  );
}

// Hover content for a tool-call row: the rich command card when a raw command is
// present, otherwise the plain label (used to reveal truncated text / file paths).
// Returns null when there's nothing worth showing so the row renders untouched.
function toolRowTooltipContent(
  rawCommand: string | null | undefined,
  displayText: string,
  fallback: string | undefined,
): ReactNode {
  if (rawCommand) {
    return commandTooltipContent(rawCommand, displayText);
  }
  return fallback ? <span className="whitespace-pre-wrap">{fallback}</span> : null;
}

// Frosted hover tooltip for tool-call rows — the same surface (via the `default`
// variant) as the sidebar thread/project hover cards, so the rows read as one
// system. Replaces the native `title` tooltip; renders the trigger untouched when
// there's no content to show.
function ToolRowTooltip(props: { content: ReactNode; children: ReactElement }) {
  if (!props.content) {
    return props.children;
  }
  return (
    <Tooltip>
      <TooltipTrigger render={props.children} />
      <TooltipPopup side="top" align="start" className="max-w-96 whitespace-normal">
        {props.content}
      </TooltipPopup>
    </Tooltip>
  );
}

export const TimelineWorkEntryRow = memo(function TimelineWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
  chatMetaFontSizePx: number;
  textFontSizePx?: number;
  density?: "default" | "compact";
  fileDiffStatByPath?: ReadonlyMap<string, { additions: number; deletions: number }>;
  markdownCwd: string | undefined;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  turnId?: TurnId;
  onOpenTurnDiff?: (turnId: TurnId, filePath?: string) => void;
  onOpenAgentActivity?: (activityId: string) => void;
  onOpenThread?: (threadId: ThreadId) => void;
  onOpenAutomation?: (automationId: string) => void;
  subagentToolTraceByThreadId?: ReadonlyMap<string, SubagentToolTrace>;
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
    onOpenAgentActivity,
    onOpenThread,
    onOpenAutomation,
    subagentToolTraceByThreadId,
  } = props;
  const compact = density === "compact";
  const isCodexStatusRow = isCodexActivityStatusWorkEntry(workEntry);
  const EntryIcon = workEntryIcon(workEntry);
  // Web-fetch tool calls surface the target site (favicon + URL) instead of the raw
  // `WebFetch: {json}` arguments, reusing the same link-chip icon/label path as
  // composer and markdown links so every site reference looks identical.
  const webFetchUrl = extractWebFetchUrl(workEntry);
  // Standard tool rows keep one discoverable left glyph. Codex status rows
  // deliberately skip it and reuse only the shared tool-label typography.
  const isGitHubToolRow = isGitHubMcpToolCall(workEntry);
  const isSynaraToolRow = !isGitHubToolRow && isSynaraToolCall(workEntry);
  const isMcpToolRow =
    workEntry.itemType === "mcp_tool_call" && !isGitHubToolRow && !isSynaraToolRow;
  const LeftIcon = workEntryLeftIcon(workEntry);
  const leftIconKind = webFetchUrl
    ? "web-fetch"
    : isGitHubToolRow || EntryIcon === GitHubIcon
      ? "github"
      : isSynaraToolRow
        ? "synara"
        : isMcpToolRow
          ? "mcp"
          : undefined;
  const heading = toolWorkEntryHeading(workEntry);
  const rawPreview = workEntryPreview(workEntry);
  const preview = isSynaraToolRow
    ? sanitizeSynaraMcpToolPreview({
        preview: rawPreview,
        heading,
        status: toolWorkEntryStatus(workEntry),
      })
    : rawPreview;
  const displayText = webFetchUrl
    ? describeLinkChip(webFetchUrl).label
    : isReasoningUpdateWorkEntry(workEntry) && preview
      ? preview
      : combineWorkEntryDisplayText(heading, preview);
  const showInlineAgentTaskPreview =
    workEntry.itemType === "collab_agent_tool_call" &&
    (workEntry.subagents?.length ?? 0) === 0 &&
    Boolean(preview) &&
    normalizeToolTextForComparison(heading) !== normalizeToolTextForComparison(preview ?? "");
  const rawCommand = workEntry.rawCommand ?? workEntry.command;
  const hoverText =
    rawCommand ?? (showInlineAgentTaskPreview ? heading : (webFetchUrl ?? displayText));
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
  const canOpenToolDetails = Boolean(workEntry.toolDetails);
  // File-read rows open the referenced file in the in-app viewer when the
  // hosting surface provides an opener (right-dock file pane / editor pane).
  const opener = useWorkspaceFileOpener();
  // Per-file +N/-M parsed from this tool call's own patch, used as a fallback when
  // the turn-diff summary isn't in scope (e.g. standalone work rows) so every
  // "Edited <file>" row can still show diff stats.
  const toolDiffStatsByPath = useMemo(
    () =>
      isFileChangeWorkEntry(workEntry)
        ? fileDiffStatsByPath(workEntry.toolDetails?.diff)
        : EMPTY_FILE_DIFF_STATS,
    [workEntry],
  );

  // A created-automation row renders as its own card instead of a tool-call line.
  // Kept after the hooks above so the early return never changes hook order.
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
            // Prefer the turn-diff summary's per-file stat; fall back to the stat
            // parsed from this tool call's own patch so the +N/-M shows even when
            // no summary is in scope (standalone work rows) or it lacks the file.
            const summaryStat = fileDiffStatByPath?.get(changedFilePath);
            const changedFileStat =
              summaryStat && summaryStat.additions + summaryStat.deletions > 0
                ? summaryStat
                : (resolveFileDiffStatByChangedPath(
                    toolDiffStatsByPath,
                    changedFilePath,
                    changedFiles.length,
                  ) ?? summaryStat);
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
                  tooltip={<span className="whitespace-pre-wrap">{changedFilePath}</span>}
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
              {renderWorkEntryIcon(EntryIcon, compact ? "size-2.5" : "size-3")}
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
                const toolTrace = subagentToolTraceByThreadId?.get(
                  subagent.resolvedThreadId ?? subagent.threadId,
                );
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
                          <span className="shrink-0 text-muted-foreground/30">Latest</span>
                          <span className="truncate">{subagent.latestUpdate}</span>
                        </div>
                      ) : null}
                      {toolTrace ? (
                        <div className="mt-1.5 space-y-[3px] border-l border-border/35 pl-2">
                          {toolTrace.entries.map((toolEntry) => {
                            const ToolEntryIcon = workEntryIcon(toolEntry);
                            const toolText = combineWorkEntryDisplayText(
                              toolWorkEntryHeading(toolEntry),
                              workEntryPreview(toolEntry),
                            );
                            return (
                              <div
                                key={toolEntry.id}
                                className="flex min-w-0 items-center gap-1.5 text-muted-foreground/48"
                                style={{ fontSize: `${Math.max(10, rowFontSizePx - 2)}px` }}
                                title={toolText}
                              >
                                {renderWorkEntryIcon(
                                  ToolEntryIcon,
                                  "size-3 shrink-0 text-muted-foreground/32",
                                )}
                                <span className="truncate">{toolText}</span>
                              </div>
                            );
                          })}
                          {toolTrace.overflowCount > 0 ? (
                            <div
                              className="pl-[18px] text-muted-foreground/36"
                              style={{ fontSize: `${Math.max(10, rowFontSizePx - 2)}px` }}
                            >
                              +{toolTrace.overflowCount} more tool uses
                            </div>
                          ) : null}
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
                          "shrink-0 rounded-full border border-border/45 px-2.5 py-1 text-[9px] font-medium text-muted-foreground/62 transition-colors",
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
                <div className="pl-4 text-[10px] text-muted-foreground/46">
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
              {!isCodexStatusRow ? (
                <span
                  className={cn(
                    "flex shrink-0 items-center justify-center",
                    WORK_ROW_MUTED_HOVER_TONE["tool-row"],
                    compact ? "size-4" : "size-5",
                  )}
                  data-tool-icon={leftIconKind}
                  data-work-entry-icon="true"
                >
                  {webFetchUrl ? (
                    <LinkChipIcon url={webFetchUrl} className={compact ? "size-3.5" : "size-4"} />
                  ) : (
                    renderWorkEntryIcon(LeftIcon, compact ? "size-3.5" : "size-4")
                  )}
                </span>
              ) : null}
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
                      WORK_ROW_MUTED_HOVER_TONE["tool-row"],
                    )}
                    data-codex-status-row={isCodexStatusRow ? "true" : undefined}
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
                tooltip={toolRowTooltipContent(rawCommand, displayText, displayText)}
              >
                {rowContentChildren}
              </ToolDetailsDisclosure>
            );
          }

          const rowContent = (
            <AgentActivityOpenSurface
              canOpen={canOpenAgentActivity || canOpenReadFile}
              compact={compact}
              onOpen={openAgentActivity ?? openReadFile}
              onHover={prefetchReadFile}
              tooltip={toolRowTooltipContent(
                rawCommand,
                displayText,
                canOpenReadFile ? (readFilePath ?? hoverText) : hoverText,
              )}
            >
              {rowContentChildren}
            </AgentActivityOpenSurface>
          );

          return rowContent;
        })()
      )}
    </div>
  );
});

// Inner content for an "Edited <file> +n/-m" row. Mirrors the tool-call row treatment
// (muted leading icon + label that brightens to foreground on hover/focus, same font
// size) so edited rows read as the same visual unit. Callers own the interactive wrapper
// (`group/file-row` button or disclosure summary) and pass the diff stat when available.
export function EditedFileRowContent(props: {
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
          "flex shrink-0 items-center justify-center",
          WORK_ROW_MUTED_HOVER_TONE["file-row"],
          compact ? "size-4" : "size-5",
        )}
        data-tool-icon="edit"
      >
        <PencilIcon className={compact ? "size-3.5" : "size-4"} />
      </span>
      <span
        className={cn("font-system-ui shrink-0", WORK_ROW_MUTED_HOVER_TONE["file-row"])}
        style={{ fontSize: `${fontSizePx}px` }}
      >
        Edited
      </span>
      <span
        className={cn(
          "font-system-ui max-w-[28rem] truncate underline-offset-2",
          WORK_ROW_MUTED_HOVER_TONE["file-row"],
          // Filename doubles as a link affordance: underline on the same row hover/focus.
          "group-hover/file-row:underline group-focus-visible/file-row:underline",
        )}
        style={{ fontSize: `${fontSizePx}px` }}
      >
        {basenameOfPath(filePath)}
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
  /** Styled frosted hover tooltip (preferred over the native `title`). */
  tooltip?: ReactNode;
  dataToolDetailTrigger?: boolean | undefined;
}) {
  const className = cn(
    "group/tool-row flex w-full items-center text-left transition-[opacity,translate] duration-200",
    props.compact ? "gap-1.5" : "gap-2",
    props.canOpen ? "cursor-pointer focus-visible:outline-none" : "cursor-default",
  );

  // Wrap the real DOM element (not this component) so Base UI's tooltip trigger
  // can attach its hover handlers and compose with our own onClick/onPointerEnter.
  const surface = props.canOpen ? (
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
  ) : (
    <div className={className} title={props.title}>
      {props.children}
    </div>
  );

  return <ToolRowTooltip content={props.tooltip}>{surface}</ToolRowTooltip>;
}

function ToolDetailsDisclosure(props: {
  children: ReactNode;
  compact: boolean;
  dataFileChangeRow?: boolean | undefined;
  details: NonNullable<TimelineWorkEntry["toolDetails"]>;
  summaryClassName?: string | undefined;
  tooltip?: ReactNode;
}) {
  const summaryClassName =
    props.summaryClassName ??
    cn(
      "group/tool-row flex w-full items-center text-left transition-[opacity,translate] duration-200",
      props.compact ? "gap-1.5" : "gap-2",
      "cursor-pointer focus-visible:outline-none",
    );
  const [open, setOpen] = useState(false);
  const [renderDetails, setRenderDetails] = useState(false);
  const [motionOpen, setMotionOpen] = useState(false);
  const openFrameRef = useRef<number | null>(null);
  const cleanupTimeoutRef = useRef<number | null>(null);

  const clearMotionTimers = useCallback(() => {
    if (openFrameRef.current !== null) {
      window.cancelAnimationFrame(openFrameRef.current);
      openFrameRef.current = null;
    }
    if (cleanupTimeoutRef.current !== null) {
      window.clearTimeout(cleanupTimeoutRef.current);
      cleanupTimeoutRef.current = null;
    }
  }, []);

  const setDetailsOpen = useCallback(
    (nextOpen: boolean) => {
      clearMotionTimers();
      setOpen(nextOpen);

      if (nextOpen) {
        setRenderDetails(true);
        setMotionOpen(false);
        openFrameRef.current = window.requestAnimationFrame(() => {
          openFrameRef.current = null;
          setMotionOpen(true);
        });
        return;
      }

      setMotionOpen(false);
      cleanupTimeoutRef.current = window.setTimeout(() => {
        cleanupTimeoutRef.current = null;
        setRenderDetails(false);
      }, TRANSCRIPT_DISCLOSURE_TRANSITION_MS + TRANSCRIPT_DISCLOSURE_CLEANUP_BUFFER_MS);
    },
    [clearMotionTimers],
  );

  useEffect(() => () => clearMotionTimers(), [clearMotionTimers]);

  const summaryButton = (
    <button
      type="button"
      className={summaryClassName}
      aria-expanded={open}
      data-file-change-row={props.dataFileChangeRow ? "true" : undefined}
      data-tool-detail-trigger="true"
      onClick={() => {
        setDetailsOpen(!open);
      }}
    >
      {props.children}
      <DisclosureChevron
        open={open}
        className="text-muted-foreground/38 group-hover/tool-row:text-foreground group-hover/file-row:text-foreground group-focus-visible/tool-row:text-foreground group-focus-visible/file-row:text-foreground"
      />
    </button>
  );

  return (
    <div className="group/tool-details min-w-0">
      <ToolRowTooltip content={props.tooltip}>{summaryButton}</ToolRowTooltip>
      {renderDetails ? (
        <DisclosureRegion
          open={motionOpen}
          contentClassName={cn("min-w-0 pt-2", props.compact ? "ml-5" : "ml-7")}
        >
          <div data-tool-details-inline="true">
            <ToolCallDetailsContent details={props.details} />
          </div>
        </DisclosureRegion>
      ) : null}
    </div>
  );
}
