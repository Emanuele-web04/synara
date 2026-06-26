// Purpose: Build and collapse work-log entries from orchestration activity, including
//   command/tool-payload extraction and collab-subagent decoding.
// Layer: web pure logic (no React, no I/O).
// Exports: WorkLogEntry, WorkLogSubagent, WorkLogSubagentAction, WORK_LOG_PRESENTATION_VERSION,
//   deriveWorkLogEntries, formatWorkLogEntryLabel, formatWorkLogEntryDetail.
import {
  type OrchestrationThreadActivity,
  type RuntimeContentStreamKind,
  type ToolLifecycleItemType,
  type TurnId,
} from "@t3tools/contracts";
import { summarizeToolRawOutput } from "@t3tools/shared/toolOutputSummary";

import {
  deriveReadableToolTitle,
  isGenericToolTitle,
  normalizeCompactToolLabel,
} from "./lib/toolCallLabel";
import {
  deriveWorkLogToolDetails,
  mergeWorkLogToolDetails,
  type WorkLogToolDetails,
} from "./lib/toolCallDetails";
import type { PendingApproval } from "./session-logic.pending";
import {
  asRecord,
  asTrimmedString,
  compareActivitiesByOrder,
  extractWorkLogItemType,
  extractWorkLogRequestKind,
} from "./session-logic.shared";
import { extractCollabAction, extractCollabSubagents } from "./session-logic.workLog.collab";

export interface WorkLogEntry {
  id: string;
  createdAt: string;
  turnId?: TurnId | null;
  label: string;
  detail?: string;
  command?: string;
  rawCommand?: string;
  preview?: string;
  streamKind?: RuntimeContentStreamKind;
  changedFiles?: ReadonlyArray<string>;
  tone: "thinking" | "tool" | "info" | "error";
  toolTitle?: string;
  toolName?: string;
  toolCallId?: string;
  toolDetails?: WorkLogToolDetails;
  itemType?: ToolLifecycleItemType;
  requestKind?: PendingApproval["requestKind"];
  subagents?: ReadonlyArray<WorkLogSubagent>;
  subagentAction?: WorkLogSubagentAction;
  automation?: WorkLogAutomation;
}

export const WORK_LOG_PRESENTATION_VERSION = 6;

export interface WorkLogAutomation {
  id: string;
  name: string;
  cadenceLabel: string;
}

export interface WorkLogSubagent {
  threadId: string;
  providerThreadId?: string | undefined;
  resolvedThreadId?: string | undefined;
  agentId?: string | undefined;
  nickname?: string | undefined;
  role?: string | undefined;
  model?: string | undefined;
  prompt?: string | undefined;
  rawStatus?: string | undefined;
  latestUpdate?: string | undefined;
  title?: string | undefined;
  statusLabel?: string | undefined;
  isActive?: boolean | undefined;
}

export interface WorkLogSubagentAction {
  tool: string;
  status: string;
  summaryText: string;
  model?: string | undefined;
  prompt?: string | undefined;
}

interface DerivedWorkLogEntry extends WorkLogEntry {
  activityKind: OrchestrationThreadActivity["kind"];
  collapseKey?: string;
  collapseCommand?: string;
  toolName?: string;
}

interface ToolPayloadOutput {
  readonly detail: string;
  readonly preservesRawOutput: boolean;
}

export function formatWorkLogEntryLabel(entry: WorkLogEntry): string {
  return entry.toolTitle ?? entry.preview ?? entry.label;
}

export function formatWorkLogEntryDetail(entry: WorkLogEntry): string | null {
  return entry.detail ?? entry.command ?? null;
}

export function isFileChangeWorkLogEntry(
  workEntry: Pick<WorkLogEntry, "itemType" | "requestKind">,
): boolean {
  return workEntry.requestKind === "file-change" || workEntry.itemType === "file_change";
}

export function isProviderFileEditWorkLogEntry(
  workEntry: Pick<WorkLogEntry, "changedFiles" | "itemType" | "requestKind">,
): boolean {
  if (workEntry.itemType === "file_change") {
    return true;
  }
  return workEntry.requestKind === "file-change" && (workEntry.changedFiles?.length ?? 0) > 0;
}

function isCollabAgentToolActivity(activity: OrchestrationThreadActivity): boolean {
  const payload = asRecord(activity.payload);
  return (
    asTrimmedString(payload?.itemType) === "collab_agent_tool_call" &&
    extractCollabSubagents(payload).length > 0
  );
}

function isQuietTaskLifecycleActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind === "task.started") {
    return true;
  }
  if (activity.kind !== "task.completed") {
    return false;
  }
  const payload = asRecord(activity.payload);
  return asTrimmedString(payload?.status) === null;
}

function isLiveTurnlessWorkActivity(activity: OrchestrationThreadActivity): boolean {
  return (
    activity.kind === "reasoning.delta" ||
    activity.kind === "reasoning.progress" ||
    activity.kind === "tool.output.delta" ||
    activity.kind === "plan.delta" ||
    activity.kind === "provider.content.delta" ||
    activity.kind === "provider.unhandled" ||
    activity.kind === "mcp.status.updated" ||
    activity.kind === "context-compaction"
  );
}

export function deriveWorkLogEntries(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | undefined,
  options: { visibleTurnIds?: ReadonlySet<TurnId | string> } = {},
): WorkLogEntry[] {
  const visibleTurnIds = options.visibleTurnIds;
  const ordered = [...activities].toSorted(compareActivitiesByOrder);
  const entries = ordered
    .filter((activity) => shouldKeepActivityForWorkLog(activity, latestTurnId, visibleTurnIds))
    .filter((activity) => !isCollabAgentToolActivity(activity))
    .filter((activity) => !isQuietTaskLifecycleActivity(activity))
    .filter((activity) => !isQuietTurnLifecycleActivity(activity))
    .filter((activity) => activity.kind !== "account.rate-limits.updated")
    .filter(
      (activity) =>
        activity.kind !== "context-window.updated" && activity.kind !== "context-window.configured",
    )
    .filter((activity) => activity.summary !== "Checkpoint captured")
    .filter((activity) => !isPlanBoundaryToolActivity(activity))
    .filter((activity) => !isUninformativeCommandStartActivity(activity))
    .map(toDerivedWorkLogEntry);
  return collapseDerivedWorkLogEntries(entries).map(
    ({
      activityKind: _activityKind,
      collapseCommand: _collapseCommand,
      collapseKey: _collapseKey,
      toolName: _toolName,
      ...entry
    }) => entry,
  );
}

function shouldKeepActivityForWorkLog(
  activity: OrchestrationThreadActivity,
  latestTurnId: TurnId | undefined,
  visibleTurnIds: ReadonlySet<TurnId | string> | undefined,
): boolean {
  if (activity.kind === "automation.created") {
    return true;
  }

  if (visibleTurnIds && visibleTurnIds.size > 0) {
    return activity.turnId !== null && visibleTurnIds.has(activity.turnId);
  }

  return latestTurnId
    ? activity.turnId === latestTurnId ||
        (activity.turnId === null && isLiveTurnlessWorkActivity(activity))
    : true;
}

function isQuietTurnLifecycleActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "turn.completed" && activity.kind !== "turn.aborted") {
    return false;
  }
  // Provider lifecycle rows close internal state; assistant/result text is rendered from messages.
  return activity.tone !== "error";
}

function isUninformativeCommandStartActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "tool.started") {
    return false;
  }
  const payload = asRecord(activity.payload);
  if (extractWorkLogItemType(payload) !== "command_execution") {
    return false;
  }
  const commandAction = extractPrimaryCommandAction(payload);
  const commandPreview = extractToolCommand(payload, commandAction);
  return !commandAction && !commandPreview.command;
}

function isPlanBoundaryToolActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "tool.updated" && activity.kind !== "tool.completed") {
    return false;
  }

  const payload = asRecord(activity.payload);
  return typeof payload?.detail === "string" && payload.detail.startsWith("ExitPlanMode:");
}

function extractWorkLogAutomation(
  payload: Record<string, unknown> | null,
): WorkLogAutomation | null {
  if (!payload) {
    return null;
  }
  const id = asTrimmedString(payload.automationId);
  const name = asTrimmedString(payload.automationName);
  if (!id || !name) {
    return null;
  }
  const cadenceLabel = asTrimmedString(payload.cadenceLabel) ?? "";
  return { id, name, cadenceLabel };
}

function toDerivedWorkLogEntry(activity: OrchestrationThreadActivity): DerivedWorkLogEntry {
  const payload = asRecord(activity.payload);
  const commandAction = extractPrimaryCommandAction(payload);
  const commandPreview = extractToolCommand(payload, commandAction);
  const changedFiles = extractChangedFiles(payload);
  const title = extractToolTitle(payload);
  const toolName = extractToolName(payload);
  const toolCallId = extractToolCallId(payload);
  const streamKind = extractStreamKind(payload);
  const entry: DerivedWorkLogEntry = {
    id: activity.id,
    createdAt: activity.createdAt,
    turnId: activity.turnId,
    label: activity.summary,
    tone:
      activity.kind === "reasoning.delta" || activity.kind === "reasoning.progress"
        ? "thinking"
        : activity.tone === "approval"
          ? "info"
          : activity.tone,
    activityKind: activity.kind,
    ...(toolName ? { toolName } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(streamKind ? { streamKind } : {}),
  };
  const itemType = extractWorkLogItemType(payload);
  const requestKind = extractWorkLogRequestKind(payload);
  const outputDetail = extractToolPayloadOutput(payload);
  if (payload && typeof payload.detail === "string" && payload.detail.length > 0) {
    if (isRawStreamDetailActivity(activity.kind)) {
      entry.detail = payload.detail;
    } else {
      const detail = stripTrailingExitCode(payload.detail).output;
      if (detail) {
        entry.detail = detail;
      }
    }
  }
  const whitespaceOutputPreview =
    activity.kind === "tool.output.delta" && payload && typeof payload.detail === "string"
      ? describeWhitespaceOutputChunk(payload.detail)
      : null;
  if (whitespaceOutputPreview) {
    entry.preview = whitespaceOutputPreview;
  }
  if (activity.kind === "provider.unhandled") {
    const providerSource = asTrimmedString(payload?.source);
    const providerMethod =
      asTrimmedString(payload?.method) ?? asTrimmedString(payload?.messageType);
    const nativeEventName = asTrimmedString(payload?.nativeEventName);
    const refDetail = [providerSource, providerMethod, nativeEventName].filter(Boolean).join(" / ");
    if (refDetail) {
      entry.detail = refDetail;
      entry.collapseKey = `provider-unhandled:${refDetail}`;
    } else if (nativeEventName) {
      entry.collapseKey = `provider-unhandled:${nativeEventName}`;
    }
  }
  if (activity.kind === "mcp.status.updated") {
    const provider = asTrimmedString(payload?.provider);
    entry.collapseKey = provider ? `mcp-status:${provider}` : "mcp-status";
  }
  if (outputDetail && (!entry.detail || itemType === "collab_agent_tool_call")) {
    entry.detail = outputDetail.detail;
    if (outputDetail.preservesRawOutput && entry.streamKind === undefined) {
      entry.streamKind = "unknown";
    }
  }
  if (commandPreview.command) {
    entry.command = commandPreview.command;
  }
  if (commandPreview.rawCommand) {
    entry.rawCommand = commandPreview.rawCommand;
  }
  const commandActionDisplay = deriveCommandActionDisplay(commandAction, activity.kind);
  if (commandActionDisplay?.preview) {
    entry.preview = commandActionDisplay.preview;
  }
  if (changedFiles.length > 0) {
    entry.changedFiles = changedFiles;
  }
  if (itemType) {
    entry.itemType = itemType;
  }
  if (requestKind) {
    entry.requestKind = requestKind;
  }
  const subagents = extractCollabSubagents(payload);
  if (subagents.length > 0) {
    entry.subagents = subagents;
  }
  const subagentAction = extractCollabAction(payload, subagents);
  if (subagentAction) {
    entry.subagentAction = subagentAction;
  }
  if (activity.kind === "automation.created") {
    const automation = extractWorkLogAutomation(payload);
    if (automation) {
      entry.automation = automation;
    }
  }
  const readableTitle = deriveReadableToolTitle({
    title: commandActionDisplay?.title ?? title,
    fallbackLabel: activity.summary,
    itemType,
    requestKind,
    command: commandPreview.command,
    payload,
    isRunning: activity.kind !== "tool.completed",
  });
  if (readableTitle) {
    entry.toolTitle = readableTitle;
  }
  if (
    entry.detail &&
    normalizeCompactToolLabel(entry.detail) ===
      normalizeCompactToolLabel(entry.toolTitle ?? entry.label)
  ) {
    delete entry.detail;
  }
  const toolDetails = deriveWorkLogToolDetails({
    payload,
    itemType,
    requestKind,
    command: entry.command,
    rawCommand: entry.rawCommand,
    detail: entry.detail,
    changedFiles: entry.changedFiles ?? changedFiles,
    label: entry.label,
    toolTitle: entry.toolTitle,
  });
  if (toolDetails) {
    entry.toolDetails = toolDetails;
  }
  const collapseKey = deriveToolLifecycleCollapseKey(entry);
  if (collapseKey) {
    entry.collapseKey = collapseKey;
  }
  const collapseCommand = deriveToolLifecycleCollapseCommand(entry);
  if (collapseCommand) {
    entry.collapseCommand = collapseCommand;
  }
  return entry;
}

function extractToolPayloadOutput(
  payload: Record<string, unknown> | null,
): ToolPayloadOutput | null {
  const data = asRecord(payload?.data);
  const taskResultText = extractTaskResultText(asRecord(data?.state)?.output);
  if (taskResultText) {
    return { detail: taskResultText, preservesRawOutput: true };
  }
  const claudeToolResultText = extractClaudeToolResultText(data?.result);
  if (claudeToolResultText) {
    return { detail: claudeToolResultText, preservesRawOutput: true };
  }
  const rawToolOutputText = extractRawToolOutputText(data?.rawOutput);
  if (rawToolOutputText) {
    return { detail: rawToolOutputText, preservesRawOutput: true };
  }
  const summary = summarizeToolRawOutput(data?.rawOutput);
  return summary ? { detail: summary, preservesRawOutput: false } : null;
}

function extractTaskResultText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = /<task_result>\s*([\s\S]*?)\s*<\/task_result>/i.exec(value);
  const text = match?.[1]?.trim();
  return text && text.length > 0 ? text : null;
}

function extractClaudeToolResultText(value: unknown): string | null {
  const result = asRecord(value);
  const content = result?.content;
  if (typeof content === "string") {
    const text = content.trim();
    return text.length > 0 ? text : null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const text = content
    .map((entry) => asTrimmedString(asRecord(entry)?.text))
    .filter((entry): entry is string => entry !== null)
    .join("\n")
    .trim();
  return text.length > 0 ? text : null;
}

function extractRawToolOutputText(value: unknown): string | null {
  if (typeof value === "string") {
    return value.length > 0 ? value : null;
  }
  const output = asRecord(value);
  if (!output) {
    return null;
  }
  const content = output.content;
  if (typeof content === "string") {
    return content.length > 0 ? content : null;
  }
  const stdout = typeof output.stdout === "string" ? output.stdout : "";
  const stderr = typeof output.stderr === "string" ? output.stderr : "";
  const combined = [stdout, stderr].filter((entry) => entry.length > 0).join("\n");
  if (combined.length > 0) {
    return combined;
  }
  if (typeof output.totalFiles === "number") {
    return null;
  }
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return null;
  }
}

function collapseDerivedWorkLogEntries(
  entries: ReadonlyArray<DerivedWorkLogEntry>,
): DerivedWorkLogEntry[] {
  const collapsed: DerivedWorkLogEntry[] = [];
  for (const entry of entries) {
    const previous = collapsed.at(-1);
    if (previous && shouldCollapseToolLifecycleEntries(previous, entry)) {
      collapsed[collapsed.length - 1] = mergeDerivedWorkLogEntries(previous, entry);
      continue;
    }
    collapsed.push(entry);
  }
  return collapsed;
}

function shouldCollapseToolLifecycleEntries(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry,
): boolean {
  if (
    (previous.activityKind === "mcp.status.updated" ||
      previous.activityKind === "provider.unhandled") &&
    previous.activityKind === next.activityKind &&
    previous.collapseKey !== undefined &&
    previous.collapseKey === next.collapseKey
  ) {
    return true;
  }
  if (!isRenderableToolLifecycleActivity(previous.activityKind)) {
    return false;
  }
  if (!isRenderableToolLifecycleActivity(next.activityKind)) {
    return false;
  }
  if (previous.activityKind === "tool.completed") {
    return false;
  }
  if (previous.collapseKey !== undefined && previous.collapseKey === next.collapseKey) {
    if (previous.collapseKey.startsWith("tool:")) {
      return true;
    }
    if (!areToolLifecycleChangedFilesCompatible(previous.changedFiles, next.changedFiles)) {
      return false;
    }
    return areToolLifecycleCommandsCompatible(previous.collapseCommand, next.collapseCommand);
  }
  return (
    previous.toolCallId !== undefined &&
    next.toolCallId === undefined &&
    previous.itemType === next.itemType &&
    normalizeCompactToolLabel(previous.toolTitle ?? previous.label) ===
      normalizeCompactToolLabel(next.toolTitle ?? next.label) &&
    areToolLifecycleChangedFilesCompatible(previous.changedFiles, next.changedFiles) &&
    areToolLifecycleCommandsCompatible(previous.collapseCommand, next.collapseCommand)
  );
}

function mergeDerivedWorkLogEntries(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry,
): DerivedWorkLogEntry {
  const changedFiles = mergeChangedFiles(previous.changedFiles, next.changedFiles);
  const appendsStreamDetail = shouldAppendStreamDetail(previous, next);
  const detail = appendsStreamDetail
    ? `${previous.detail ?? ""}${next.detail ?? ""}`
    : (next.detail ?? previous.detail);
  const command = next.command ?? previous.command;
  const rawCommand = next.rawCommand ?? previous.rawCommand;
  const preview = appendsStreamDetail
    ? streamDetailPreview(detail)
    : (next.preview ?? previous.preview);
  const toolTitle = mergeToolTitle(previous.toolTitle, next.toolTitle);
  const itemType = next.itemType ?? previous.itemType;
  const requestKind = next.requestKind ?? previous.requestKind;
  const subagents = next.subagents ?? previous.subagents;
  const subagentAction = next.subagentAction ?? previous.subagentAction;
  const collapseKey = next.collapseKey ?? previous.collapseKey;
  const toolName = next.toolName ?? previous.toolName;
  const toolCallId = next.toolCallId ?? previous.toolCallId;
  const toolDetails = mergeWorkLogToolDetails(previous.toolDetails, next.toolDetails);
  const streamKind = next.streamKind ?? previous.streamKind;
  return {
    ...previous,
    ...next,
    ...(detail ? { detail } : {}),
    ...(command ? { command } : {}),
    ...(rawCommand ? { rawCommand } : {}),
    ...(preview ? { preview } : {}),
    ...(changedFiles.length > 0 ? { changedFiles } : {}),
    ...(toolTitle ? { toolTitle } : {}),
    ...(itemType ? { itemType } : {}),
    ...(requestKind ? { requestKind } : {}),
    ...(subagents ? { subagents } : {}),
    ...(subagentAction ? { subagentAction } : {}),
    ...(collapseKey ? { collapseKey } : {}),
    ...(toolName ? { toolName } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(toolDetails ? { toolDetails } : {}),
    ...(streamKind ? { streamKind } : {}),
  };
}

function mergeToolTitle(
  previous: string | undefined,
  next: string | undefined,
): string | undefined {
  if (!next) {
    return previous;
  }
  if (!previous || !isGenericToolTitle(next)) {
    return next;
  }
  return previous;
}

function isRawStreamDetailActivity(kind: OrchestrationThreadActivity["kind"]): boolean {
  return (
    kind === "tool.output.delta" ||
    kind === "reasoning.delta" ||
    kind === "plan.delta" ||
    kind === "provider.content.delta"
  );
}

function shouldAppendStreamDetail(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry,
): boolean {
  return (
    previous.activityKind === "tool.output.delta" &&
    next.activityKind === "tool.output.delta" &&
    previous.collapseKey !== undefined &&
    previous.collapseKey === next.collapseKey
  );
}

function streamDetailPreview(detail: string | undefined): string | undefined {
  if (!detail || detail.trim().length > 0) {
    return undefined;
  }
  return describeWhitespaceOutputChunk(detail) ?? undefined;
}

function mergeChangedFiles(
  previous: ReadonlyArray<string> | undefined,
  next: ReadonlyArray<string> | undefined,
): string[] {
  const merged = [...(previous ?? []), ...(next ?? [])];
  if (merged.length === 0) {
    return [];
  }
  return [...new Set(merged)];
}

// Keep a stable lifecycle key so providers like Claude can stream many
// in-progress tool deltas without turning each partial update into its own row.
function deriveToolLifecycleCollapseKey(entry: DerivedWorkLogEntry): string | undefined {
  if (!isRenderableToolLifecycleActivity(entry.activityKind)) {
    return undefined;
  }
  if (entry.toolCallId) {
    return `tool:${entry.toolCallId}`;
  }
  const normalizedLabel = normalizeCompactToolLabel(entry.toolTitle ?? entry.label);
  const itemType = entry.itemType ?? "";
  const requestKind = entry.requestKind ?? "";
  const toolName = entry.toolName ?? "";
  const command = normalizeCompactToolLabel(entry.command ?? "");
  const detailHint = normalizeCompactToolLabel(extractDetailCollapseHint(entry.detail));
  if (
    normalizedLabel.length === 0 &&
    itemType.length === 0 &&
    requestKind.length === 0 &&
    toolName.length === 0 &&
    detailHint.length === 0
  ) {
    return command.length > 0 ? `command-only${""}${command}` : undefined;
  }
  return [itemType, normalizedLabel, requestKind, toolName, detailHint].join("");
}

function isRenderableToolLifecycleActivity(
  kind: OrchestrationThreadActivity["kind"],
): kind is "tool.started" | "tool.updated" | "tool.completed" | "tool.output.delta" {
  return (
    kind === "tool.started" ||
    kind === "tool.updated" ||
    kind === "tool.completed" ||
    kind === "tool.output.delta"
  );
}

function deriveToolLifecycleCollapseCommand(entry: DerivedWorkLogEntry): string | undefined {
  const command = normalizeCompactToolLabel(entry.command ?? "");
  return command.length > 0 ? command : undefined;
}

function areToolLifecycleCommandsCompatible(
  previous: string | undefined,
  next: string | undefined,
): boolean {
  if (!previous || !next) {
    return true;
  }
  return previous === next || previous.startsWith(next) || next.startsWith(previous);
}

function areToolLifecycleChangedFilesCompatible(
  previous: ReadonlyArray<string> | undefined,
  next: ReadonlyArray<string> | undefined,
): boolean {
  if (!previous?.length || !next?.length) {
    return true;
  }
  return previous.some((path) => next.includes(path));
}

function normalizeCommandValue(value: unknown): string | null {
  const direct = asTrimmedString(value);
  if (direct) {
    return direct;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const parts = value
    .map((entry) => asTrimmedString(entry))
    .filter((entry): entry is string => entry !== null);
  return parts.length > 0 ? parts.join(" ") : null;
}

function asCommandArgumentRecord(value: unknown): Record<string, unknown> | null {
  const direct = asRecord(value);
  if (direct) {
    return direct;
  }
  const text = asTrimmedString(value);
  if (!text || !text.startsWith("{")) {
    return null;
  }
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

function isCommandLikeDetail(payload: Record<string, unknown> | null): boolean {
  if (!payload) {
    return false;
  }
  const itemType = extractWorkLogItemType(payload);
  if (itemType === "command_execution") {
    return true;
  }
  const requestKind = extractWorkLogRequestKind(payload);
  if (requestKind === "command") {
    return true;
  }
  const normalizedTitle = normalizeCompactToolLabel(asTrimmedString(payload.title) ?? "");
  return normalizedTitle === "Ran command" || normalizedTitle === "Command run";
}

interface CommandAction {
  type: string;
  command?: string;
  name?: string;
  path?: string;
  query?: string;
}

interface CommandActionDisplay {
  title: string;
  preview?: string;
}

function makeCommandActionDisplay(
  title: string,
  preview: string | undefined,
): CommandActionDisplay {
  return preview === undefined ? { title } : { title, preview };
}

function extractToolCommand(
  payload: Record<string, unknown> | null,
  commandAction: CommandAction | null = extractPrimaryCommandAction(payload),
): { command: string | null; rawCommand: string | null } {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const itemResult = asRecord(item?.result);
  const itemInput = asRecord(item?.input);
  const itemArguments = asCommandArgumentRecord(item?.arguments ?? item?.args ?? item?.params);
  const itemCall = asRecord(item?.call);
  const itemFunction = asRecord(item?.function);
  const dataInput = asRecord(data?.input);
  const dataArguments = asCommandArgumentRecord(data?.arguments ?? data?.args ?? data?.params);
  const rawInput = asCommandArgumentRecord(data?.rawInput);
  const detailCommand =
    isCommandLikeDetail(payload) && typeof payload?.detail === "string"
      ? stripTrailingExitCode(payload.detail).output
      : null;
  const rawCommandCandidates = [
    item?.command,
    item?.cmd,
    itemInput?.command,
    itemInput?.cmd,
    itemArguments?.command,
    itemArguments?.cmd,
    itemCall?.command,
    itemCall?.cmd,
    itemFunction?.arguments,
    itemResult?.command,
    itemResult?.cmd,
    data?.command,
    data?.cmd,
    dataInput?.command,
    dataInput?.cmd,
    dataArguments?.command,
    dataArguments?.cmd,
    rawInput?.command,
    rawInput?.cmd,
    item?.text,
    item?.summary,
    detailCommand,
  ];
  const rawCommand =
    rawCommandCandidates
      .map((candidate) => normalizeCommandValue(candidate))
      .find((candidate) => candidate !== null) ?? null;
  const command =
    normalizeCommandValue(commandAction?.command) ??
    rawCommandCandidates
      .map((candidate) => normalizeCommandValue(candidate))
      .find((candidate) => candidate !== null) ??
    null;
  return {
    command,
    rawCommand: rawCommand && rawCommand !== command ? rawCommand : null,
  };
}

function extractToolTitle(payload: Record<string, unknown> | null): string | null {
  if (extractWorkLogItemType(payload) === "collab_agent_tool_call") {
    const data = asRecord(payload?.data);
    const state = asRecord(data?.state);
    const input = asRecord(data?.input);
    return (
      asTrimmedString(state?.title) ??
      asTrimmedString(input?.description) ??
      asTrimmedString(payload?.title)
    );
  }
  return asTrimmedString(payload?.title);
}

function extractPrimaryCommandAction(
  payload: Record<string, unknown> | null,
): CommandAction | null {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const actions = collectCommandActions(payload, data, item);
  for (const action of actions) {
    const actionRecord = asRecord(action);
    if (!actionRecord) {
      continue;
    }
    const type = asTrimmedString(actionRecord.type) ?? "unknown";
    const command = asTrimmedString(actionRecord.command) ?? undefined;
    const name = asTrimmedString(actionRecord.name) ?? undefined;
    const path = asTrimmedString(actionRecord.path) ?? undefined;
    const query = asTrimmedString(actionRecord.query) ?? undefined;
    if (command || name || path || query || type !== "unknown") {
      return {
        type,
        ...(command ? { command } : {}),
        ...(name ? { name } : {}),
        ...(path ? { path } : {}),
        ...(query ? { query } : {}),
      };
    }
  }
  return null;
}

// Codex has emitted commandActions both on the item and on the surrounding raw
// payload; scan the nearby envelopes before falling back to generic command text.
function collectCommandActions(
  payload: Record<string, unknown> | null,
  data: Record<string, unknown> | null,
  item: Record<string, unknown> | null,
): ReadonlyArray<unknown> {
  const candidates = [
    item?.commandActions,
    asCommandArgumentRecord(item?.arguments ?? item?.args ?? item?.params)?.commandActions,
    data?.commandActions,
    asCommandArgumentRecord(data?.arguments ?? data?.args ?? data?.params)?.commandActions,
    asCommandArgumentRecord(data?.rawInput)?.commandActions,
    asCommandArgumentRecord(data?.input)?.commandActions,
    payload?.commandActions,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }
  return [];
}

function deriveCommandActionDisplay(
  action: CommandAction | null,
  activityKind: OrchestrationThreadActivity["kind"],
): CommandActionDisplay | null {
  if (!action) {
    return null;
  }
  const running = activityKind !== "tool.completed";
  switch (normalizeCommandActionType(action.type)) {
    case "read":
    case "readfile":
      return makeCommandActionDisplay(running ? "Reading" : "Read", commandActionTarget(action));
    case "search":
    case "find":
      return makeCommandActionDisplay(
        running ? "Searching" : "Searched",
        commandActionSearchPreview(action),
      );
    case "listfiles":
      return makeCommandActionDisplay(
        running ? "Listing" : "Listed",
        commandActionListPreview(action),
      );
    default:
      return null;
  }
}

function normalizeCommandActionType(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function commandActionTarget(action: CommandAction): string | undefined {
  return action.name ?? compactWorkLogPath(action.path) ?? undefined;
}

function commandActionSearchPreview(action: CommandAction): string | undefined {
  const query = action.query ?? action.name;
  const path = compactWorkLogPath(action.path);
  if (query && path) {
    return `for ${query} in ${path}`;
  }
  if (query) {
    return `for ${query}`;
  }
  if (path) {
    return `in ${path}`;
  }
  return commandActionTarget(action);
}

function commandActionListPreview(action: CommandAction): string | undefined {
  return compactWorkLogPath(action.path) ?? action.name ?? undefined;
}

function compactWorkLogPath(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  if (value === ".") {
    return "current directory";
  }
  if (value === "..") {
    return "parent directory";
  }
  const parts = value.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) {
    return value;
  }
  return parts.slice(-2).join("/");
}

function extractToolName(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const itemInput = asRecord(item?.input);
  const candidates = [data?.toolName, data?.tool, item?.toolName, item?.name, itemInput?.toolName];
  for (const candidate of candidates) {
    const normalized = asTrimmedString(candidate);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function extractToolCallId(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  return asTrimmedString(
    payload?.itemId ?? data?.toolCallId ?? data?.callID ?? data?.callId ?? item?.id,
  );
}

function extractStreamKind(
  payload: Record<string, unknown> | null,
): RuntimeContentStreamKind | null {
  const value = asTrimmedString(payload?.streamKind);
  switch (value) {
    case "assistant_text":
    case "reasoning_text":
    case "reasoning_summary_text":
    case "plan_text":
    case "command_output":
    case "file_change_output":
    case "unknown":
      return value;
    default:
      return null;
  }
}

function stripTrailingExitCode(value: string): {
  output: string | null;
  exitCode?: number | undefined;
} {
  const trimmed = value.trim();
  const match = /^(?<output>[\s\S]*?)(?:\s*<exited with exit code (?<code>\d+)>)\s*$/i.exec(
    trimmed,
  );
  if (!match?.groups) {
    return {
      output: trimmed.length > 0 ? trimmed : null,
    };
  }
  const exitCode = Number.parseInt(match.groups.code ?? "", 10);
  const normalizedOutput = match.groups.output?.trim() ?? "";
  return {
    output: normalizedOutput.length > 0 ? normalizedOutput : null,
    ...(Number.isInteger(exitCode) ? { exitCode } : {}),
  };
}

function describeWhitespaceOutputChunk(value: string): string | null {
  if (value.length === 0 || value.trim().length > 0) {
    return null;
  }
  const escaped = value
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/ /g, "\\s");
  const preview = escaped.length > 80 ? `${escaped.slice(0, 77)}...` : escaped;
  return `Whitespace output: ${preview}`;
}

function extractDetailCollapseHint(detail: string | undefined): string {
  if (!detail) {
    return "";
  }
  const firstLine = detail.split("\n", 1)[0]?.trim() ?? "";
  if (firstLine.length === 0) {
    return "";
  }
  const colonIndex = firstLine.indexOf(":");
  if (colonIndex <= 0) {
    return firstLine;
  }
  return firstLine.slice(0, colonIndex);
}

function pushChangedFile(target: string[], seen: Set<string>, value: unknown) {
  const normalized = asTrimmedString(value);
  if (!normalized || !isLikelyFilePath(normalized) || seen.has(normalized)) {
    return;
  }
  seen.add(normalized);
  target.push(normalized);
}

function isLikelyFilePath(value: string): boolean {
  if (/^(?:file|vscode|cursor):\/\//iu.test(value)) {
    return true;
  }
  if (value.startsWith("/") || value.startsWith("./") || value.startsWith("../")) {
    return true;
  }
  if (/^[A-Za-z]:[\\/]/u.test(value)) {
    return true;
  }
  if (value.includes("/") || value.includes("\\")) {
    return true;
  }
  return /^[^\s/\\]+\.[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value);
}

function collectChangedFiles(value: unknown, target: string[], seen: Set<string>, depth: number) {
  if (depth > 4 || target.length >= 12) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectChangedFiles(entry, target, seen, depth + 1);
      if (target.length >= 12) {
        return;
      }
    }
    return;
  }

  const record = asRecord(value);
  if (!record) {
    return;
  }

  pushChangedFile(target, seen, record.path);
  pushChangedFile(target, seen, record.file);
  pushChangedFile(target, seen, record.file_path);
  pushChangedFile(target, seen, record.filepath);
  pushChangedFile(target, seen, record.filePath);
  pushChangedFile(target, seen, record.relativePath);
  pushChangedFile(target, seen, record.filename);
  pushChangedFile(target, seen, record.newPath);
  pushChangedFile(target, seen, record.oldPath);

  for (const nestedKey of [
    "item",
    "result",
    "input",
    "rawInput",
    "rawOutput",
    "data",
    "location",
    "locations",
    "changes",
    "files",
    "file",
    "edits",
    "patch",
    "patches",
    "operations",
  ]) {
    if (!(nestedKey in record)) {
      continue;
    }
    collectChangedFiles(record[nestedKey], target, seen, depth + 1);
    if (target.length >= 12) {
      return;
    }
  }
}

function extractChangedFiles(payload: Record<string, unknown> | null): string[] {
  const changedFiles: string[] = [];
  const seen = new Set<string>();
  collectChangedFiles(asRecord(payload?.data), changedFiles, seen, 0);
  return changedFiles;
}
