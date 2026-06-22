// FILE: workEntryRow.tsx
// Purpose: Renders a single transcript work-log entry (tool call, file change, subagent card) and its derivation helpers.
// Layer: Web chat presentation component
// Exports: SimpleWorkEntryRow, AgentTaskIcon, basename, workEntryIcon, isFileChangeWorkEntry, isGitHubMcpToolCall, prefersCompactWorkEntryRow

import { ThreadId, type TurnId } from "@t3tools/contracts";
import { memo } from "react";
import { type ReactNode } from "react";
import {
  BotIcon,
  CheckIcon,
  CircleAlertIcon,
  EyeIcon,
  GitHubIcon,
  GlobeIcon,
  HammerIcon,
  type LucideIcon,
  McpIcon,
  SkillCubeIcon,
  SquarePenIcon,
  TerminalIcon,
  ZapIcon,
} from "~/lib/icons";
import { DiffStatLabel } from "./DiffStatLabel";
import ChatMarkdown from "../ChatMarkdown";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import {
  formatSubagentModelLabel,
  humanizeSubagentStatus,
  normalizeSubagentStatusKind,
  resolveSubagentPresentation,
} from "../../lib/subagentPresentation";
import { normalizeCompactToolLabel } from "./MessagesTimeline.logic";
import { deriveInlineCommandCall } from "../../lib/toolCallLabel";
import { type WorkLogEntry } from "~/session-logic";
import { RiRobot3Line } from "react-icons/ri";

export const AgentTaskIcon: LucideIcon = (props) => (
  <RiRobot3Line className={props.className} style={props.style} />
);

export function basename(value: string): string {
  const slash = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  return slash >= 0 ? value.slice(slash + 1) : value;
}

function workToneIcon(tone: WorkLogEntry["tone"]): {
  icon: LucideIcon;
  className: string;
} {
  if (tone === "error") {
    return {
      icon: CircleAlertIcon,
      className: "text-muted-foreground/70",
    };
  }
  if (tone === "thinking") {
    return {
      icon: BotIcon,
      className: "text-muted-foreground/70",
    };
  }
  if (tone === "info") {
    return {
      icon: CheckIcon,
      className: "text-muted-foreground/70",
    };
  }
  return {
    icon: ZapIcon,
    className: "text-muted-foreground/70",
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
    WorkLogEntry,
    | "detail"
    | "command"
    | "rawCommand"
    | "preview"
    | "changedFiles"
    | "requestKind"
    | "itemType"
    | "streamKind"
    | "subagents"
    | "subagentAction"
  >,
): string | null {
  const streamBody = streamBodyText(workEntry);
  if (streamBody && workEntry.detail && workEntry.detail.trim().length > 0) {
    return null;
  }
  if (shouldRenderAgentTaskMarkdown(workEntry)) {
    return null;
  }

  const isFileRelated =
    workEntry.requestKind === "file-read" ||
    workEntry.requestKind === "file-change" ||
    workEntry.itemType === "file_change";

  if (workEntry.itemType === "command_execution" || workEntry.command || workEntry.rawCommand) {
    const command = workEntry.command ?? workEntry.rawCommand;
    if (command) return deriveInlineCommandCall(command);
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

function shouldRenderAgentTaskMarkdown(
  workEntry: Pick<WorkLogEntry, "detail" | "itemType">,
): boolean {
  if (workEntry.itemType !== "collab_agent_tool_call") {
    return false;
  }
  const detail = workEntry.detail?.trim() ?? "";
  return /(^|\n)(#{1,6}\s|```|[-*]\s|\d+\.\s)/u.test(detail);
}

function shouldRenderStreamBody(workEntry: Pick<WorkLogEntry, "detail" | "streamKind">): boolean {
  if (workEntry.detail === undefined || workEntry.detail.length === 0) {
    return false;
  }
  switch (workEntry.streamKind) {
    case "reasoning_text":
    case "reasoning_summary_text":
    case "plan_text":
    case "command_output":
    case "file_change_output":
    case "unknown":
      return true;
    default:
      return false;
  }
}

function visibleWhitespace(value: string): string {
  return value
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n\n")
    .replace(/\t/g, "\\t")
    .replace(/ /g, "\u00b7");
}

function streamBodyText(workEntry: Pick<WorkLogEntry, "detail" | "streamKind">): string | null {
  if (!shouldRenderStreamBody(workEntry)) {
    return null;
  }
  const detail = workEntry.detail ?? "";
  return detail.trim().length > 0 ? detail : visibleWhitespace(detail);
}

export function workEntryIcon(workEntry: WorkLogEntry): LucideIcon {
  if (workEntry.requestKind === "command") return TerminalIcon;
  if (workEntry.requestKind === "file-read") return EyeIcon;
  if (workEntry.requestKind === "file-change") return SquarePenIcon;

  if (workEntry.itemType === "command_execution" || workEntry.command) {
    return TerminalIcon;
  }
  if (workEntry.itemType === "file_change") {
    return SquarePenIcon;
  }
  if (workEntry.itemType === "web_search") return GlobeIcon;
  if (workEntry.requestKind === "file-read") return EyeIcon;
  if (workEntry.itemType === "image_generation") return ZapIcon;
  if (workEntry.itemType === "image_view") return EyeIcon;

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

export function isGitHubMcpToolCall(workEntry: WorkLogEntry): boolean {
  const toolName = workEntry.toolName?.trim().toLowerCase();
  return Boolean(toolName?.startsWith("mcp__codex_apps__github"));
}

// Keep command, agent-task, and file-change rows visually compact so their icon can trail the label.
export function prefersCompactWorkEntryRow(workEntry: WorkLogEntry): boolean {
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

function toolWorkEntryHeading(workEntry: WorkLogEntry): string {
  if (!workEntry.toolTitle) {
    return capitalizePhrase(normalizeCompactToolLabel(workEntry.label));
  }
  return capitalizePhrase(normalizeCompactToolLabel(workEntry.toolTitle));
}

// Splits compact work labels so the action verb can carry visual emphasis.
function splitWorkEntryActionText(value: string): { action: string; rest: string } | null {
  const match = /^(\S+)([\s\S]*)$/.exec(value.trim());
  if (!match?.[1]) {
    return null;
  }
  return { action: match[1], rest: match[2] ?? "" };
}

export function isFileChangeWorkEntry(workEntry: WorkLogEntry): boolean {
  return workEntry.requestKind === "file-change" || workEntry.itemType === "file_change";
}

function subagentPrimaryLabel(
  subagent: NonNullable<WorkLogEntry["subagents"]>[number],
): ReturnType<typeof resolveSubagentPresentation> {
  return resolveSubagentPresentation({
    nickname: subagent.nickname,
    role: subagent.role,
    title: subagent.title,
    fallbackId: subagent.threadId,
  });
}

function subagentSecondaryLabel(
  subagent: NonNullable<WorkLogEntry["subagents"]>[number],
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

function subagentCardSummary(workEntry: WorkLogEntry): string {
  return (
    workEntry.subagentAction?.summaryText ??
    workEntryPreview(workEntry) ??
    toolWorkEntryHeading(workEntry)
  );
}

function subagentCardMeta(workEntry: WorkLogEntry): string | null {
  const modelLabel = formatSubagentModelLabel(workEntry.subagentAction?.model);
  if (modelLabel && workEntry.subagentAction?.prompt) {
    return `${modelLabel} • ${workEntry.subagentAction.prompt}`;
  }
  return modelLabel ?? workEntry.subagentAction?.prompt ?? null;
}

function commandTooltipContent(command: string, displayText: string): ReactNode {
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

export const SimpleWorkEntryRow = memo(function SimpleWorkEntryRow(props: {
  workEntry: WorkLogEntry;
  chatMetaFontSizePx: number;
  textFontSizePx?: number;
  density?: "default" | "compact";
  fileDiffStatByPath?: ReadonlyMap<string, { additions: number; deletions: number }>;
  turnId?: TurnId;
  markdownCwd?: string | undefined;
  onOpenTurnDiff?: (turnId: TurnId, filePath?: string) => void;
  onOpenThread?: (threadId: ThreadId) => void;
}) {
  const {
    workEntry,
    chatMetaFontSizePx,
    textFontSizePx = chatMetaFontSizePx,
    density = "default",
    fileDiffStatByPath,
    turnId,
    markdownCwd,
    onOpenTurnDiff,
    onOpenThread,
  } = props;
  const compact = density === "compact";
  const EntryIcon = workEntryIcon(workEntry);
  const usesTrailingCompactIcon =
    EntryIcon === TerminalIcon || EntryIcon === HammerIcon || EntryIcon === AgentTaskIcon;
  const showIconRight = compact && usesTrailingCompactIcon;
  const showIconLeft = !compact;
  const showInlineWebSearchIcon = compact && workEntry.itemType === "web_search";
  const showInlineGitHubIcon = compact && isGitHubMcpToolCall(workEntry);
  const showInlineMcpIcon =
    compact && workEntry.itemType === "mcp_tool_call" && !showInlineGitHubIcon;
  const heading = toolWorkEntryHeading(workEntry);
  const preview = workEntryPreview(workEntry);
  const displayText = preview ? `${heading} ${preview}` : heading;
  const displayTextParts = splitWorkEntryActionText(displayText);
  const rawCommand = workEntry.rawCommand ?? workEntry.command;
  const hoverText = rawCommand ?? displayText;
  const changedFiles = workEntry.changedFiles ?? [];
  const showEditedRows = isFileChangeWorkEntry(workEntry) && changedFiles.length > 0;
  const showSubagentRows =
    workEntry.itemType === "collab_agent_tool_call" &&
    ((workEntry.subagents?.length ?? 0) > 0 || Boolean(workEntry.subagentAction));
  const visibleSubagents = workEntry.subagents?.slice(0, 3) ?? [];
  const hiddenSubagentCount = Math.max(
    0,
    (workEntry.subagents?.length ?? 0) - visibleSubagents.length,
  );
  const subagentSummary = subagentCardSummary(workEntry);
  const subagentMeta = subagentCardMeta(workEntry);
  const streamBody = streamBodyText(workEntry);
  const agentTaskMarkdown =
    shouldRenderAgentTaskMarkdown(workEntry) && workEntry.detail ? workEntry.detail.trim() : null;

  // Use the text font size (matching the UI settings) for tool call rows
  const rowFontSizePx = textFontSizePx;

  return (
    <div className={cn(compact ? "py-0.5" : "rounded-lg py-1")}>
      {showEditedRows ? (
        <div className="space-y-0.5">
          {changedFiles.map((changedFilePath) => {
            const changedFileStat = fileDiffStatByPath?.get(changedFilePath);
            const canOpenEditedDiff = Boolean(turnId && onOpenTurnDiff);
            return (
              <button
                key={`${workEntry.id}:${changedFilePath}`}
                type="button"
                data-file-change-row="true"
                className={cn(
                  "group/file-row flex w-full max-w-full items-baseline gap-1 text-left transition-opacity duration-150",
                  compact
                    ? "px-0 py-[1px] hover:opacity-95"
                    : "rounded-md border border-border/45 bg-background/65 px-2 py-2 hover:bg-background/80",
                  canOpenEditedDiff ? "cursor-pointer" : "cursor-default",
                )}
                title={changedFilePath}
                disabled={!canOpenEditedDiff}
                onClick={() => {
                  if (!turnId || !onOpenTurnDiff) return;
                  onOpenTurnDiff(turnId, changedFilePath);
                }}
              >
                <span
                  className="font-system-ui shrink-0 font-medium text-muted-foreground/72"
                  style={{ fontSize: `${rowFontSizePx}px` }}
                >
                  Edited
                </span>
                <span
                  className="font-system-ui max-w-[28rem] truncate text-[var(--color-text-foreground)] underline-offset-2 group-hover/file-row:underline group-focus-visible/file-row:underline"
                  style={{
                    fontSize: `${rowFontSizePx}px`,
                  }}
                >
                  {basename(changedFilePath)}
                </span>
                {changedFileStat ? (
                  <span
                    className="font-system-ui shrink-0 tabular-nums whitespace-nowrap"
                    style={{ fontSize: `${rowFontSizePx}px` }}
                  >
                    <DiffStatLabel
                      additions={changedFileStat.additions}
                      deletions={changedFileStat.deletions}
                    />
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : showSubagentRows ? (
        <div className="space-y-1.5">
          <div
            className={cn(
              "flex items-center transition-[opacity,translate] duration-200",
              compact ? "gap-1.5" : "gap-2",
            )}
          >
            <span
              className={cn(
                "flex shrink-0 items-center justify-center text-muted-foreground/70",
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
                  className="truncate leading-4 text-muted-foreground/70"
                  style={{ fontSize: `${Math.max(11, rowFontSizePx - 1)}px` }}
                  title={subagentMeta}
                >
                  {subagentMeta}
                </p>
              ) : null}
            </div>
          </div>
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
                          <span className="ml-1 text-[11px] font-medium text-muted-foreground/70">
                            ({presentation.role})
                          </span>
                        ) : null}
                      </div>
                      {secondaryLabel ? (
                        <div
                          className="truncate pt-0.5 leading-4 text-muted-foreground/70"
                          style={{ fontSize: `${Math.max(11, rowFontSizePx - 1)}px` }}
                          title={secondaryLabel}
                        >
                          {secondaryLabel}
                        </div>
                      ) : null}
                      {subagent.latestUpdate ? (
                        <div
                          className="flex items-baseline gap-1.5 pt-1 text-muted-foreground/70"
                          style={{ fontSize: `${Math.max(10, rowFontSizePx - 2)}px` }}
                          title={subagent.latestUpdate}
                        >
                          <span className="shrink-0 uppercase tracking-[0.14em] text-muted-foreground/70">
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
                          "shrink-0 rounded-full border border-border/45 px-2.5 py-1 text-[9px] font-medium uppercase tracking-[0.12em] text-muted-foreground/75 transition-colors",
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
                <div className="pl-4 text-[10px] uppercase tracking-[0.12em] text-muted-foreground/70">
                  +{hiddenSubagentCount} more
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : (
        (() => {
          const rowContent = (
            <div
              className={cn(
                "flex items-center transition-[opacity,translate] duration-200",
                compact ? "gap-1.5" : "gap-2",
              )}
              title={hoverText}
            >
              {showIconLeft && (
                <span
                  className={cn(
                    "flex shrink-0 items-center justify-center text-muted-foreground/70",
                    compact ? "size-4" : "size-5",
                  )}
                >
                  <EntryIcon className={compact ? "size-2.5" : "size-3"} />
                </span>
              )}
              <div className="min-w-0 flex-1 overflow-hidden">
                <p
                  className={cn(
                    compact ? "truncate leading-5" : "truncate leading-6",
                    "text-muted-foreground/70",
                  )}
                  style={{ fontSize: `${rowFontSizePx}px` }}
                >
                  {showInlineWebSearchIcon || showInlineGitHubIcon || showInlineMcpIcon ? (
                    <span
                      className="mr-1 inline-flex align-[-0.125em] text-muted-foreground/70"
                      data-inline-tool-icon={
                        showInlineGitHubIcon ? "github" : showInlineMcpIcon ? "mcp" : "web-search"
                      }
                    >
                      {showInlineGitHubIcon ? (
                        <GitHubIcon
                          style={{
                            width: `${rowFontSizePx}px`,
                            height: `${rowFontSizePx}px`,
                          }}
                        />
                      ) : null}
                      {showInlineMcpIcon ? (
                        <McpIcon
                          style={{
                            width: `${rowFontSizePx}px`,
                            height: `${rowFontSizePx}px`,
                          }}
                        />
                      ) : null}
                      {showInlineWebSearchIcon ? (
                        <GlobeIcon
                          style={{
                            width: `${rowFontSizePx}px`,
                            height: `${rowFontSizePx}px`,
                          }}
                        />
                      ) : null}
                    </span>
                  ) : null}
                  <span className="text-muted-foreground/70" data-work-entry-display-text="true">
                    {displayTextParts ? (
                      <>
                        <span
                          className="font-medium text-muted-foreground/72"
                          data-work-entry-action-word="true"
                        >
                          {displayTextParts.action}
                        </span>
                        {displayTextParts.rest}
                      </>
                    ) : (
                      displayText
                    )}
                  </span>
                </p>
              </div>
              {showIconRight && (
                <span
                  className="flex shrink-0 items-center justify-center text-muted-foreground/70"
                  style={{ width: rowFontSizePx, height: rowFontSizePx }}
                >
                  <EntryIcon style={{ width: rowFontSizePx, height: rowFontSizePx }} />
                </span>
              )}
            </div>
          );

          const renderedRow = rawCommand ? (
            <Tooltip>
              <TooltipTrigger render={rowContent} />
              <TooltipPopup side="top" align="start" className="max-w-96 whitespace-normal">
                {commandTooltipContent(rawCommand, displayText)}
              </TooltipPopup>
            </Tooltip>
          ) : (
            rowContent
          );

          if (!streamBody && !agentTaskMarkdown) {
            return renderedRow;
          }

          return (
            <div className="min-w-0 space-y-1">
              {renderedRow}
              {agentTaskMarkdown ? (
                <div className="min-w-0 pl-0.5 text-foreground/90">
                  <ChatMarkdown
                    text={agentTaskMarkdown}
                    cwd={markdownCwd}
                    isStreaming={false}
                    className="text-sm leading-relaxed"
                    style={{
                      fontSize: `${rowFontSizePx}px`,
                      lineHeight: `${Math.round(rowFontSizePx * 1.5)}px`,
                    }}
                  />
                </div>
              ) : null}
              {streamBody ? (
                <pre
                  aria-live="off"
                  className={cn(
                    "max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/35 bg-background/55 font-chat-code text-muted-foreground/78",
                    compact ? "px-2 py-1.5" : "px-2.5 py-2",
                  )}
                  style={{ fontSize: `${Math.max(11, rowFontSizePx - 1)}px` }}
                >
                  {streamBody}
                </pre>
              ) : null}
            </div>
          );
        })()
      )}
    </div>
  );
});
