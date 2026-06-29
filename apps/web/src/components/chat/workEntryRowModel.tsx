// FILE: workEntryRowModel.tsx
// Purpose: Derives labels, icons, previews, and subagent display metadata for transcript work rows.
// Layer: Web chat presentation logic
// Exports: Work-row derivation helpers used by workEntryRow and MessagesTimeline

import { type ReactNode } from "react";
import { RiRobot3Line } from "react-icons/ri";
import {
  BotIcon,
  CheckIcon,
  CircleAlertIcon,
  EyeIcon,
  HammerIcon,
  type LucideIcon,
  SearchIcon,
  SkillCubeIcon,
  SquarePenIcon,
  TerminalIcon,
  WebSearchIcon,
  ZapIcon,
} from "~/lib/icons";
import { type WorkLogEntry } from "~/session-logic";
import { cn } from "~/lib/utils";
import { basenameOfPath } from "../../file-icons";
import { deriveReadableCommandDisplay, isInspectCommand } from "../../lib/toolCallLabel";
import {
  formatSubagentModelLabel,
  normalizeSubagentStatusKind,
  resolveSubagentPresentation,
} from "../../lib/subagentPresentation";
import { normalizeCompactToolLabel } from "./MessagesTimeline.logic";

export const AgentTaskIcon: LucideIcon = (props) => (
  <RiRobot3Line className={props.className} style={props.style} />
);

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

export function extractFilePathFromDetail(detail: string): string | null {
  const plainPathMatch = /^(.+?\.[A-Za-z0-9][A-Za-z0-9._-]*)(?::\d+)?(?::\d+)?$/u.exec(
    detail.trim(),
  );
  if (plainPathMatch?.[1]?.includes("/")) {
    return plainPathMatch[1].trim();
  }

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
    const match = /"(?:file_path|filePath|path|filename)"\s*:\s*"([^"]+)"/i.exec(detail);
    if (match?.[1]) return match[1];
  }
  return null;
}

export function shouldRenderAgentTaskMarkdown(
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

export function streamBodyText(
  workEntry: Pick<WorkLogEntry, "detail" | "streamKind">,
): string | null {
  if (!shouldRenderStreamBody(workEntry)) {
    return null;
  }
  const detail = workEntry.detail ?? "";
  return detail.trim().length > 0 ? detail : visibleWhitespace(detail);
}

export function workEntryPreview(
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
    if (command) return deriveReadableCommandDisplay(command).target;
  }

  if (workEntry.preview) return workEntry.preview;

  if (workEntry.changedFiles && workEntry.changedFiles.length > 0) {
    const names = workEntry.changedFiles.map((path) => basenameOfPath(path));
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

  if (workEntry.detail) {
    const filePath = extractFilePathFromDetail(workEntry.detail);
    if (filePath) return basenameOfPath(filePath);
    if (isFileRelated) return null;

    const trimmedDetail = workEntry.detail.trim();
    if (trimmedDetail.startsWith("{") || trimmedDetail.startsWith("[")) return null;

    const readLinesMatch = /^Read\s+(\d+\s+lines?)$/i.exec(trimmedDetail);
    if (readLinesMatch?.[1]) return readLinesMatch[1];

    return trimmedDetail;
  }

  return null;
}

export function isFileReadToolEntry(workEntry: WorkLogEntry): boolean {
  const name = (workEntry.toolName ?? "").toLowerCase().replace(/[^a-z]/g, "");
  return name === "read" || name === "readfile" || name === "viewfile";
}

export function workEntryIcon(workEntry: WorkLogEntry): LucideIcon {
  if (workEntry.requestKind === "command") return commandWorkEntryIcon(workEntry);
  if (workEntry.requestKind === "file-read") return SearchIcon;
  if (workEntry.requestKind === "file-change") return SquarePenIcon;

  if (workEntry.itemType === "command_execution" || workEntry.command) {
    return commandWorkEntryIcon(workEntry);
  }
  if (workEntry.itemType === "file_change") return SquarePenIcon;
  if (workEntry.itemType === "web_search") return WebSearchIcon;
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

function commandWorkEntryIcon(workEntry: WorkLogEntry): LucideIcon {
  const command = workEntry.command ?? workEntry.rawCommand;
  return command && isInspectCommand(command) ? SearchIcon : TerminalIcon;
}

export function isGitHubMcpToolCall(workEntry: WorkLogEntry): boolean {
  const toolName = workEntry.toolName?.trim().toLowerCase();
  return Boolean(toolName?.startsWith("mcp__codex_apps__github"));
}

export function prefersCompactWorkEntryRow(workEntry: WorkLogEntry): boolean {
  const EntryIcon = workEntryIcon(workEntry);
  return (
    EntryIcon === TerminalIcon ||
    EntryIcon === HammerIcon ||
    EntryIcon === AgentTaskIcon ||
    EntryIcon === SquarePenIcon ||
    EntryIcon === SkillCubeIcon ||
    EntryIcon === WebSearchIcon
  );
}

function capitalizePhrase(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return value;
  }
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

export function toolWorkEntryHeading(workEntry: WorkLogEntry): string {
  if (!workEntry.toolTitle) {
    return capitalizePhrase(normalizeCompactToolLabel(workEntry.label));
  }
  return capitalizePhrase(normalizeCompactToolLabel(workEntry.toolTitle));
}

export function splitWorkEntryActionText(value: string): { action: string; rest: string } | null {
  const match = /^(\S+)([\s\S]*)$/.exec(value.trim());
  if (!match?.[1]) {
    return null;
  }
  return { action: match[1], rest: match[2] ?? "" };
}

export function isFileChangeWorkEntry(workEntry: WorkLogEntry): boolean {
  return workEntry.requestKind === "file-change" || workEntry.itemType === "file_change";
}

export function workEntryStatusLabel(status: WorkLogEntry["status"]): string | null {
  switch (status) {
    case "inProgress":
      return "Running";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "declined":
      return "Declined";
    default:
      return null;
  }
}

export function workEntryStatusDotClassName(status: WorkLogEntry["status"]): string {
  return cn(
    "size-1.5 shrink-0 rounded-full",
    status === "inProgress" && "bg-sky-300/85",
    status === "completed" && "bg-emerald-300/70",
    status === "failed" && "bg-rose-300/85",
    status === "declined" && "bg-amber-300/85",
    status === undefined && "bg-muted-foreground/35",
  );
}

export function subagentPrimaryLabel(
  subagent: NonNullable<WorkLogEntry["subagents"]>[number],
): ReturnType<typeof resolveSubagentPresentation> {
  return resolveSubagentPresentation({
    nickname: subagent.nickname,
    role: subagent.role,
    title: subagent.title,
    fallbackId: subagent.threadId,
  });
}

export function subagentSecondaryLabel(
  subagent: NonNullable<WorkLogEntry["subagents"]>[number],
  primaryLabel: string,
): string | null {
  const parts = [subagent.title, formatSubagentModelLabel(subagent.model)]
    .filter((value): value is string => Boolean(value))
    .filter((value) => value !== primaryLabel);
  return parts.length === 0 ? null : parts.join(" • ");
}

export function subagentStatusClasses(
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

export function subagentCardSummary(workEntry: WorkLogEntry): string {
  return (
    workEntry.subagentAction?.summaryText ??
    workEntryPreview(workEntry) ??
    toolWorkEntryHeading(workEntry)
  );
}

export function subagentCardMeta(workEntry: WorkLogEntry): string | null {
  const modelLabel = formatSubagentModelLabel(workEntry.subagentAction?.model);
  if (modelLabel && workEntry.subagentAction?.prompt) {
    return `${modelLabel} • ${workEntry.subagentAction.prompt}`;
  }
  return modelLabel ?? workEntry.subagentAction?.prompt ?? null;
}

export function commandTooltipContent(command: string, displayText: string): ReactNode {
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
