// FILE: workEntryRow.tsx
// Purpose: Renders a single transcript work-log entry (tool call, file change, subagent card) and its derivation helpers.
// Layer: Web chat presentation component
// Exports: SimpleWorkEntryRow, isFileChangeWorkEntry, prefersCompactWorkEntryRow

import { ThreadId, type TurnId } from "@t3tools/contracts";
import { memo } from "react";
import { GitHubIcon, HammerIcon, McpIcon, TerminalIcon, WebSearchIcon } from "~/lib/icons";
import { DiffStatLabel } from "./DiffStatLabel";
import ChatMarkdown from "../ChatMarkdown";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { basenameOfPath } from "../../file-icons";
import { humanizeSubagentStatus } from "../../lib/subagentPresentation";
import { type WorkLogEntry } from "~/session-logic";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import { openWorkspaceFileReference, useWorkspaceFileOpener } from "../../lib/workspaceFileOpener";
import { isAgentActivityWorkEntry } from "./agentActivity.logic";
import { AutomationCreatedCard } from "./AutomationCreatedCard";
import {
  AgentTaskIcon,
  commandTooltipContent,
  extractFilePathFromDetail,
  isFileChangeWorkEntry,
  isFileReadToolEntry,
  isGitHubMcpToolCall,
  prefersCompactWorkEntryRow,
  shouldRenderAgentTaskMarkdown,
  splitWorkEntryActionText,
  streamBodyText,
  subagentCardMeta,
  subagentCardSummary,
  subagentPrimaryLabel,
  subagentSecondaryLabel,
  subagentStatusClasses,
  toolWorkEntryHeading,
  workEntryStatusDotClassName,
  workEntryStatusLabel,
  workEntryIcon,
  workEntryPreview,
} from "./workEntryRowModel";
import { OpenableWorkRowSurface, ToolDetailsDisclosure } from "./workEntryRowSurfaces";

export { isFileChangeWorkEntry, prefersCompactWorkEntryRow } from "./workEntryRowModel";

export const SimpleWorkEntryRow = memo(function SimpleWorkEntryRow(props: {
  workEntry: WorkLogEntry;
  chatMetaFontSizePx: number;
  textFontSizePx?: number;
  density?: "default" | "compact";
  fileDiffStatByPath?: ReadonlyMap<string, { additions: number; deletions: number }>;
  turnId?: TurnId;
  markdownCwd?: string | undefined;
  onImageExpand?: (preview: ExpandedImagePreview) => void;
  onMarkdownContentReflow?: (() => void) | undefined;
  onOpenTurnDiff?: (turnId: TurnId, filePath?: string) => void;
  onOpenToolDetails?: (workEntry: WorkLogEntry) => void;
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
    turnId,
    markdownCwd,
    onImageExpand,
    onMarkdownContentReflow,
    onOpenTurnDiff,
    onOpenToolDetails,
    onOpenAgentActivity,
    onOpenThread,
    onOpenAutomation,
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
  const statusLabel = workEntryStatusLabel(workEntry.status);
  const renderStatusDot = () =>
    statusLabel ? (
      <span
        aria-label={`Status: ${statusLabel}`}
        className={workEntryStatusDotClassName(workEntry.status)}
        data-work-entry-status-dot="true"
        title={statusLabel}
      />
    ) : null;
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
  const streamBodyUsesMarkdown =
    workEntry.streamKind === "reasoning_text" ||
    workEntry.streamKind === "reasoning_summary_text" ||
    workEntry.streamKind === "plan_text";
  const agentTaskMarkdown =
    shouldRenderAgentTaskMarkdown(workEntry) && workEntry.detail ? workEntry.detail.trim() : null;
  const canOpenToolDetails = Boolean(onOpenToolDetails) && Boolean(workEntry.toolDetails);
  const canOpenAgentActivity = Boolean(onOpenAgentActivity) && isAgentActivityWorkEntry(workEntry);
  const openAgentActivity = canOpenAgentActivity
    ? () => onOpenAgentActivity?.(workEntry.id)
    : undefined;
  const opener = useWorkspaceFileOpener();
  const readFilePath =
    opener !== null &&
    !canOpenAgentActivity &&
    workEntry.detail &&
    (workEntry.requestKind === "file-read" || isFileReadToolEntry(workEntry))
      ? extractFilePathFromDetail(workEntry.detail)
      : null;
  const openReadFile =
    readFilePath && opener ? () => openWorkspaceFileReference(opener, readFilePath) : undefined;
  const prefetchReadFile =
    readFilePath && opener?.prefetchFile ? () => opener.prefetchFile?.(readFilePath) : undefined;

  // Use the text font size (matching the UI settings) for tool call rows
  const rowFontSizePx = textFontSizePx;
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

  return (
    <div
      className={cn(compact ? "py-0.5" : "rounded-lg py-1")}
      data-work-entry-status={workEntry.status}
    >
      {showEditedRows ? (
        <div className="space-y-0.5">
          {changedFiles.map((changedFilePath) => {
            const changedFileStat = fileDiffStatByPath?.get(changedFilePath);
            const canOpenEditedDiff = Boolean(turnId && onOpenTurnDiff);
            const canOpenEditedRow = canOpenToolDetails || canOpenEditedDiff;
            const editedRowClassName = cn(
              "group/file-row flex w-full max-w-full items-baseline gap-1 text-left transition-opacity duration-150",
              compact
                ? "px-0 py-[1px] hover:opacity-95"
                : "rounded-md border border-border/45 bg-background/65 px-2 py-2 hover:bg-background/80",
              canOpenEditedRow ? "cursor-pointer" : "cursor-default",
            );
            const editedRowChildren = (
              <>
                {renderStatusDot()}
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
                  {basenameOfPath(changedFilePath)}
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
              </>
            );
            if (canOpenToolDetails && workEntry.toolDetails) {
              return (
                <ToolDetailsDisclosure
                  key={`${workEntry.id}:${changedFilePath}`}
                  compact={compact}
                  dataFileChangeRow
                  details={workEntry.toolDetails}
                  summaryClassName={editedRowClassName}
                  title="View tool details"
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
                  if (!turnId || !onOpenTurnDiff) return;
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
          {(() => {
            const subagentHeader = (
              <OpenableWorkRowSurface
                canOpen={!canOpenToolDetails && canOpenAgentActivity}
                onOpen={openAgentActivity}
                title={hoverText}
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
                {renderStatusDot()}
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
              </OpenableWorkRowSurface>
            );

            return canOpenToolDetails && workEntry.toolDetails ? (
              <ToolDetailsDisclosure
                compact={compact}
                details={workEntry.toolDetails}
                title={rawCommand ?? displayText}
              >
                {subagentHeader}
              </ToolDetailsDisclosure>
            ) : (
              subagentHeader
            );
          })()}
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
            <OpenableWorkRowSurface
              canOpen={!canOpenToolDetails && Boolean(openAgentActivity ?? openReadFile)}
              onHover={prefetchReadFile}
              onOpen={openAgentActivity ?? openReadFile}
              className={cn(
                "flex items-center transition-[opacity,translate] duration-200",
                compact ? "gap-1.5" : "gap-2",
              )}
              title={readFilePath ?? hoverText}
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
              {renderStatusDot()}
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
                      data-tool-icon={
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
                        <WebSearchIcon
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
            </OpenableWorkRowSurface>
          );

          const renderedRowContent =
            canOpenToolDetails && workEntry.toolDetails ? (
              <ToolDetailsDisclosure
                compact={compact}
                details={workEntry.toolDetails}
                title={rawCommand ?? displayText}
              >
                {rowContent}
              </ToolDetailsDisclosure>
            ) : (
              rowContent
            );

          const renderedRow =
            rawCommand && !canOpenToolDetails ? (
              <Tooltip>
                <TooltipTrigger render={renderedRowContent} />
                <TooltipPopup side="top" align="start" className="max-w-96 whitespace-normal">
                  {commandTooltipContent(rawCommand, displayText)}
                </TooltipPopup>
              </Tooltip>
            ) : (
              renderedRowContent
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
                    isStreaming={workEntry.status === "inProgress"}
                    className="text-sm leading-relaxed"
                    style={{
                      fontSize: `${rowFontSizePx}px`,
                      lineHeight: `${Math.round(rowFontSizePx * 1.5)}px`,
                    }}
                    onImageExpand={onImageExpand}
                    onContentReflow={onMarkdownContentReflow}
                  />
                </div>
              ) : null}
              {streamBody && streamBodyUsesMarkdown ? (
                <div className="min-w-0 pl-0.5 text-foreground/90">
                  <ChatMarkdown
                    text={streamBody}
                    cwd={markdownCwd}
                    isStreaming={workEntry.status === "inProgress"}
                    className="text-sm leading-relaxed"
                    style={{
                      fontSize: `${rowFontSizePx}px`,
                      lineHeight: `${Math.round(rowFontSizePx * 1.5)}px`,
                    }}
                    onImageExpand={onImageExpand}
                    onContentReflow={onMarkdownContentReflow}
                  />
                </div>
              ) : null}
              {streamBody && !streamBodyUsesMarkdown ? (
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
