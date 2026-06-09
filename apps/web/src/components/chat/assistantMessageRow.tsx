// FILE: assistantMessageRow.tsx
// Purpose: Renders one assistant-message timeline row (markdown body, inline tool/status work, turn diff summary).
// Layer: Web chat presentation component
// Exports: AssistantMessageRow, LiveMessageMeta, formatMessageMeta, formatInlineWorkSummary, MAX_VISIBLE_INLINE_TOOL_ENTRIES

import { type MessageId, type ThreadId, type TurnId } from "@t3tools/contracts";
import { type CSSProperties, type ReactNode, useEffect, useRef } from "react";
import { formatElapsed } from "../../session-logic";
import { type TurnDiffSummary } from "../../types";
import { type TimestampFormat } from "../../appSettings";
import { formatShortTimestamp } from "../../timestampFormat";
import { type getAppTypographyScale } from "../../lib/appTypography";
import ChatMarkdown from "../ChatMarkdown";
import { ChangesIcon, Undo2Icon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ChangedFilesTree } from "./ChangedFilesTree";
import { DiffStatLabel } from "./DiffStatLabel";
import { FileEntryIcon } from "./FileEntryIcon";
import { MessageCopyButton } from "./MessageCopyButton";
import { type ExpandedImagePreview } from "./ExpandedImagePreview";
import {
  type MessagesTimelineRow,
  resolveAssistantMessageCopyState,
} from "./MessagesTimeline.logic";
import { DisclosureChevron } from "../ui/DisclosureChevron";
import { DisclosureRegion } from "../ui/DisclosureRegion";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { disclosureContentClassName } from "~/lib/disclosureMotion";
import {
  SimpleWorkEntryRow,
  basename,
  isFileChangeWorkEntry,
  prefersCompactWorkEntryRow,
} from "./workEntryRow";

export const MAX_VISIBLE_INLINE_TOOL_ENTRIES = 4;

const MESSAGE_HOVER_REVEAL_CLASS_NAME =
  "opacity-0 transition-opacity pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto";

type AssistantMessageTimelineRow = Extract<MessagesTimelineRow, { kind: "message" }>;

export function formatMessageMeta(
  createdAt: string,
  duration: string | null,
  timestampFormat: TimestampFormat,
): string {
  if (!duration) return formatShortTimestamp(createdAt, timestampFormat);
  return `${formatShortTimestamp(createdAt, timestampFormat)} • ${duration}`;
}

function formatLiveMessageMetaNow(
  createdAt: string,
  durationStart: string,
  timestampFormat: TimestampFormat,
): string {
  return formatMessageMeta(
    createdAt,
    formatElapsed(durationStart, new Date().toISOString()),
    timestampFormat,
  );
}

export function LiveMessageMeta({
  createdAt,
  durationStart,
  timestampFormat,
}: {
  createdAt: string;
  durationStart: string;
  timestampFormat: TimestampFormat;
}) {
  const textRef = useRef<HTMLSpanElement>(null);
  const initialText = formatLiveMessageMetaNow(createdAt, durationStart, timestampFormat);

  useEffect(() => {
    const updateText = () => {
      if (textRef.current) {
        textRef.current.textContent = formatLiveMessageMetaNow(
          createdAt,
          durationStart,
          timestampFormat,
        );
      }
    };
    updateText();
    const id = window.setInterval(updateText, 1000);
    return () => {
      window.clearInterval(id);
    };
  }, [createdAt, durationStart, timestampFormat]);

  return <span ref={textRef}>{initialText}</span>;
}

export function formatInlineWorkSummary(): string | null {
  return null;
}

export interface AssistantMessageRowProps {
  row: AssistantMessageTimelineRow;
  nowIso: string | undefined;
  timestampFormat: TimestampFormat;
  expandedWorkGroupsState: Record<string, boolean>;
  activeTurnInProgress: boolean;
  appTypographyScale: ReturnType<typeof getAppTypographyScale>;
  normalizedChatFontSizePx: number;
  chatTypographyStyle: CSSProperties;
  chatMessageFooterStyle: CSSProperties;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  onOpenThread?: (threadId: ThreadId) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onRevertUserMessage: (messageId: MessageId) => void;
  revertTurnCountByUserMessageId: Map<MessageId, number>;
  userMessageIdByAssistantMessageId: Map<MessageId, MessageId>;
  expandedCollapsedWork: Record<string, boolean>;
  setCollapsedWorkExpanded: (messageId: string, open: boolean) => void;
  expandedFileChangesByTurnId: Record<string, boolean>;
  toggleFileChangesExpanded: (turnId: TurnId) => void;
  handleToggleWorkGroup: (groupId: string) => void;
  tailContentRowId: string | null;
  scrollTailExpansionToEnd: () => void;
}

export function AssistantMessageRow({
  row,
  nowIso,
  timestampFormat,
  expandedWorkGroupsState,
  activeTurnInProgress,
  appTypographyScale,
  normalizedChatFontSizePx,
  chatTypographyStyle,
  chatMessageFooterStyle,
  markdownCwd,
  resolvedTheme,
  onOpenThread,
  onOpenTurnDiff,
  onImageExpand,
  onRevertUserMessage,
  revertTurnCountByUserMessageId,
  userMessageIdByAssistantMessageId,
  expandedCollapsedWork,
  setCollapsedWorkExpanded,
  expandedFileChangesByTurnId,
  toggleFileChangesExpanded,
  handleToggleWorkGroup,
  tailContentRowId,
  scrollTailExpansionToEnd,
}: AssistantMessageRowProps): ReactNode {
  const messageText = row.message.text || (row.message.streaming ? "" : "(empty response)");
  const inlineWorkEntries = row.inlineWorkEntries ?? [];
  const inlineToolEntries = inlineWorkEntries.filter((entry) => entry.tone === "tool");
  const inlineStatusEntries = inlineWorkEntries.filter((entry) => entry.tone !== "tool");
  const inlineToolGroupId = inlineToolEntries.length > 0 ? (row.inlineWorkGroupId ?? null) : null;
  const inlineToolExpanded =
    inlineToolGroupId !== null ? (expandedWorkGroupsState[inlineToolGroupId] ?? false) : false;
  const visibleInlineToolEntries =
    inlineToolExpanded || inlineToolEntries.length <= MAX_VISIBLE_INLINE_TOOL_ENTRIES
      ? inlineToolEntries
      : activeTurnInProgress
        ? inlineToolEntries.slice(-MAX_VISIBLE_INLINE_TOOL_ENTRIES)
        : inlineToolEntries.slice(0, MAX_VISIBLE_INLINE_TOOL_ENTRIES);
  const hiddenInlineToolCount = inlineToolEntries.length - visibleInlineToolEntries.length;
  const inlineWorkSummary =
    inlineToolEntries.length > 0 ? null : formatInlineWorkSummary();
  const assistantCopyState = resolveAssistantMessageCopyState({
    text: row.message.text ?? null,
    showCopyButton: row.showAssistantCopyButton,
    streaming: row.assistantCopyStreaming,
  });
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
  const hasGenericInlineFileChangeEntry = inlineToolEntries.some(
    (workEntry) =>
      isFileChangeWorkEntry(workEntry) && (workEntry.changedFiles?.length ?? 0) === 0,
  );
  const visibleRenderableInlineToolEntries = visibleInlineToolEntries.filter(
    (workEntry) =>
      !(
        hasGenericInlineFileChangeEntry &&
        isFileChangeWorkEntry(workEntry) &&
        (workEntry.changedFiles?.length ?? 0) === 0
      ),
  );
  const inlineEditedFilesFromTurnSummary =
    hasGenericInlineFileChangeEntry && (turnSummary?.files.length ?? 0) > 0
      ? turnSummary!.files
      : [];
  const inlineFileChangeDetailsAlreadyVisible =
    inlineEditedFilesFromTurnSummary.length > 0 ||
    visibleRenderableInlineToolEntries.some(
      (workEntry) =>
        isFileChangeWorkEntry(workEntry) && (workEntry.changedFiles?.length ?? 0) > 0,
    );
  const assistantMeta = row.message.streaming ? (
    nowIso ? (
      [
        formatMessageMeta(
          row.message.createdAt,
          formatElapsed(row.durationStart, nowIso),
          timestampFormat,
        ),
        inlineWorkSummary,
      ]
        .filter((value): value is string => Boolean(value))
        .join(" • ")
    ) : (
      <>
        <LiveMessageMeta
          createdAt={row.message.createdAt}
          durationStart={row.durationStart}
          timestampFormat={timestampFormat}
        />
        {inlineWorkSummary ? <> • {inlineWorkSummary}</> : null}
      </>
    )
  ) : (
    [
      formatMessageMeta(
        row.message.createdAt,
        formatElapsed(row.durationStart, row.message.completedAt),
        timestampFormat,
      ),
      inlineWorkSummary,
    ]
      .filter((value): value is string => Boolean(value))
      .join(" • ")
  );
  const collapsedTurnItems = row.collapsedTurnItems;
  const hasCollapsedWork = Boolean(collapsedTurnItems && collapsedTurnItems.length > 0);
  const isCollapsedWorkExpanded = hasCollapsedWork
    ? (expandedCollapsedWork[row.message.id] ?? false)
    : false;
  const isTailContentRow = row.id === tailContentRowId;
  return (
    <>
      {hasCollapsedWork && (
        <div className="mb-3">
          <Collapsible
            className="group/collapsed-work"
            open={isCollapsedWorkExpanded}
            onOpenChange={(open) => {
              setCollapsedWorkExpanded(row.message.id, open);
              if (open && isTailContentRow) {
                scrollTailExpansionToEnd();
              }
            }}
          >
            <CollapsibleTrigger
              data-scroll-anchor-ignore={isTailContentRow ? true : undefined}
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
                className="text-muted-foreground/70"
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
                      density={prefersCompactWorkEntryRow(item.entry) ? "compact" : "default"}
                      {...(onOpenThread ? { onOpenThread } : {})}
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
        <div data-assistant-message-id={row.message.id}>
          <ChatMarkdown
            text={messageText}
            cwd={markdownCwd}
            isStreaming={Boolean(row.message.streaming)}
            style={chatTypographyStyle}
            onImageExpand={onImageExpand}
          />
        </div>
        {!hasCollapsedWork && visibleRenderableInlineToolEntries.length > 0 && (
          <div className="mt-2.5">
            <div className="space-y-px">
              {visibleRenderableInlineToolEntries.map((workEntry) => (
                <SimpleWorkEntryRow
                  key={`inline-tool-row:${row.message.id}:${workEntry.id}`}
                  workEntry={workEntry}
                  chatMetaFontSizePx={appTypographyScale.chatMetaPx}
                  textFontSizePx={normalizedChatFontSizePx}
                  density="compact"
                  fileDiffStatByPath={fileDiffStatByPath}
                  onOpenTurnDiff={onOpenTurnDiff}
                  {...(onOpenThread ? { onOpenThread } : {})}
                  {...(turnSummary?.turnId ? { turnId: turnSummary.turnId } : {})}
                />
              ))}
            </div>
            {inlineToolGroupId &&
              inlineToolEntries.length > MAX_VISIBLE_INLINE_TOOL_ENTRIES && (
                <div className="py-0.5">
                  <button
                    type="button"
                    className="text-muted-foreground/70 transition-colors duration-150 hover:text-foreground/72"
                    style={{ fontSize: `${normalizedChatFontSizePx}px` }}
                    onClick={() => handleToggleWorkGroup(inlineToolGroupId)}
                  >
                    {inlineToolExpanded
                      ? "Show less"
                      : `+${hiddenInlineToolCount} more tool calls`}
                  </button>
                </div>
              )}
          </div>
        )}
        {!hasCollapsedWork && inlineStatusEntries.length > 0 && (
          <div className="mt-2 space-y-0.5">
            {inlineStatusEntries.map((workEntry) => (
              <SimpleWorkEntryRow
                key={`inline-status-row:${row.message.id}:${workEntry.id}`}
                workEntry={workEntry}
                chatMetaFontSizePx={appTypographyScale.chatMetaPx}
                textFontSizePx={normalizedChatFontSizePx}
                density={prefersCompactWorkEntryRow(workEntry) ? "compact" : "default"}
                {...(onOpenThread ? { onOpenThread } : {})}
              />
            ))}
          </div>
        )}
        {inlineEditedFilesFromTurnSummary.length > 0 && (
          <div className="mt-2 space-y-0.5">
            {inlineEditedFilesFromTurnSummary.map((file) => (
              <button
                key={`inline-summary-edit:${row.message.id}:${file.path}`}
                type="button"
                className="group/file-row flex w-full max-w-full items-baseline gap-1 px-0 py-1.5 text-left transition-opacity duration-150 hover:opacity-95"
                title={file.path}
                onClick={() => onOpenTurnDiff(turnSummary!.turnId, file.path)}
              >
                <span
                  className="font-system-ui shrink-0 text-[#7b7b84]"
                  style={{ fontSize: `${normalizedChatFontSizePx}px` }}
                >
                  Edited
                </span>
                <span
                  className="font-system-ui max-w-[28rem] truncate text-[var(--color-text-foreground)] underline-offset-2 group-hover/file-row:underline group-focus-visible/file-row:underline"
                  style={{
                    fontSize: `${normalizedChatFontSizePx}px`,
                  }}
                >
                  {basename(file.path)}
                </span>
                {(file.additions ?? 0) + (file.deletions ?? 0) > 0 ? (
                  <span
                    className="font-system-ui shrink-0 tabular-nums whitespace-nowrap"
                    style={{ fontSize: `${normalizedChatFontSizePx}px` }}
                  >
                    <DiffStatLabel
                      additions={file.additions ?? 0}
                      deletions={file.deletions ?? 0}
                    />
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        )}
        <div
          className="mt-0.5 flex items-center gap-2 font-system-ui font-normal text-muted-foreground/70"
          style={chatMessageFooterStyle}
        >
          {assistantCopyState.visible ? (
            <MessageCopyButton
              text={assistantCopyState.text ?? ""}
              className={MESSAGE_HOVER_REVEAL_CLASS_NAME}
            />
          ) : null}
          <p className={cn("tabular-nums", MESSAGE_HOVER_REVEAL_CLASS_NAME)}>{assistantMeta}</p>
        </div>
        {(() => {
          if (!turnSummary) return null;
          const checkpointFiles = turnSummary.files;
          if (checkpointFiles.length === 0) return null;
          const fileChangesExpanded = expandedFileChangesByTurnId[turnSummary.turnId] ?? true;
          const correspondingUserMessageId = userMessageIdByAssistantMessageId.get(row.message.id);
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
          const editedFilesLabel =
            checkpointFiles.length === 1
              ? "Edited 1 file"
              : `Edited ${checkpointFiles.length} files`;
          return (
            <div className="mt-4 overflow-hidden rounded-[0.65rem] border border-[color:var(--color-border-light)]">
              <div
                className={cn(
                  "flex items-center justify-between gap-3 bg-[var(--app-user-message-background)] px-3 py-1.5",
                  fileChangesExpanded && "border-b border-[color:var(--color-border-light)]",
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
                        <DiffStatLabel additions={totalAdditions} deletions={totalDeletions} />
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
                  <button
                    type="button"
                    className="rounded-md border border-[color:var(--color-border-light)] px-2.5 py-0.5 text-foreground/90 transition-colors hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground"
                    style={{ fontSize: chatTypographyStyle.fontSize }}
                    onClick={() => onOpenTurnDiff(turnSummary.turnId)}
                  >
                    Review
                  </button>
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
                      className="dark:text-muted-foreground/70"
                    />
                  </button>
                </div>
              </div>
              <DisclosureRegion open={fileChangesExpanded}>
                {inlineFileChangeDetailsAlreadyVisible ? (
                  <div className="px-3 py-2">
                    <ChangedFilesTree
                      turnId={turnSummary.turnId}
                      files={checkpointFiles}
                      allDirectoriesExpanded
                      resolvedTheme={resolvedTheme}
                      onOpenTurnDiff={onOpenTurnDiff}
                    />
                  </div>
                ) : (
                  checkpointFiles.map((file) => (
                    <button
                      key={file.path}
                      type="button"
                      className="group/file-row flex w-full items-center gap-2 border-t border-[color:var(--color-border-light)] bg-transparent px-3 py-2.5 text-left first:border-t-0 transition-colors hover:bg-[var(--color-background-button-secondary-hover)] dark:bg-transparent dark:hover:bg-transparent"
                      onClick={() => onOpenTurnDiff(turnSummary.turnId, file.path)}
                    >
                      <FileEntryIcon
                        pathValue={file.path}
                        kind="file"
                        theme={resolvedTheme}
                        className="size-4 shrink-0 text-[var(--color-text-foreground)] opacity-70 dark:opacity-80"
                      />
                      <span
                        className="font-system-ui truncate font-normal text-[var(--color-text-foreground)] underline-offset-2 group-hover/file-row:underline group-focus-visible/file-row:underline"
                        style={{
                          fontSize: chatTypographyStyle.fontSize,
                        }}
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
                  ))
                )}
              </DisclosureRegion>
            </div>
          );
        })()}
      </div>
    </>
  );
}
