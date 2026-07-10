// FILE: AgentActivityDetailView.tsx
// Purpose: Full-width transcript replacement for inspecting agent activity without opening side UI.
// Layer: Chat presentation component
// Depends on: agentActivity.logic and ChatMarkdown

import { ThreadId } from "@synara/contracts";
import { pluralize } from "@synara/shared/text";
import { memo, useMemo, type CSSProperties, type ReactNode } from "react";
import { BotIcon, ChevronLeftIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import {
  formatSubagentModelLabel,
  humanizeSubagentStatus,
  resolveSubagentPresentation,
} from "../../lib/subagentPresentation";
import type { WorkLogEntry, WorkLogSubagent } from "../../session-logic";
import { formatShortTimestamp } from "../../timestampFormat";
import type { TimestampFormat } from "../../appSettings";
import ChatMarkdown from "../ChatMarkdown";
import { getChatMessageFooterTextStyle, getChatTranscriptTextStyle } from "./chatTypography";
import {
  CHAT_COLUMN_FRAME_CLASS_NAME,
  CHAT_COLUMN_GUTTER_CLASS_NAME,
  ENVIRONMENT_CONTENT_INSET_MOTION_CLASS,
} from "./composerPickerStyles";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import {
  type AgentActivityDetail,
  formatAgentActivityEntryPreview,
  formatAgentActivityEntryTitle,
  isReasoningUpdateWorkEntry,
} from "./agentActivity.logic";

const MIN_DETAIL_BOTTOM_INSET_PX = 64;

interface AgentActivityDetailViewProps {
  detail: AgentActivityDetail;
  bottomContentInsetPx?: number | undefined;
  chatFontSizePx: number;
  contentInsetRightPx?: number | undefined;
  markdownCwd: string | undefined;
  onBack: () => void;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onOpenThread?: (threadId: ThreadId) => void;
  timestampFormat: TimestampFormat;
}

export const AgentActivityDetailView = memo(function AgentActivityDetailView({
  detail,
  bottomContentInsetPx,
  chatFontSizePx,
  contentInsetRightPx,
  markdownCwd,
  onBack,
  onImageExpand,
  onOpenThread,
  timestampFormat,
}: AgentActivityDetailViewProps) {
  const chatTypographyStyle = useMemo(
    () => getChatTranscriptTextStyle(chatFontSizePx),
    [chatFontSizePx],
  );
  const footerTextStyle = useMemo(
    () => getChatMessageFooterTextStyle(chatFontSizePx),
    [chatFontSizePx],
  );
  const scrollStyle = useMemo<CSSProperties>(
    () => ({
      ...(contentInsetRightPx ? { paddingRight: contentInsetRightPx } : {}),
      paddingBottom: Math.max(bottomContentInsetPx ?? 0, MIN_DETAIL_BOTTOM_INSET_PX),
    }),
    [bottomContentInsetPx, contentInsetRightPx],
  );
  const prompt = findPrompt(detail.entries);
  const result = findResult(detail.entries);
  const subagents = collectSubagents(detail.entries);

  return (
    <div
      data-agent-activity-detail="true"
      data-chat-scroll-container="true"
      className={cn(
        "h-full overflow-x-hidden overflow-y-auto overscroll-y-contain py-3 [scrollbar-gutter:stable] sm:py-4",
        ENVIRONMENT_CONTENT_INSET_MOTION_CLASS,
        CHAT_COLUMN_GUTTER_CLASS_NAME,
      )}
      style={scrollStyle}
    >
      <div className={cn(CHAT_COLUMN_FRAME_CLASS_NAME, "px-1")}>
        <button
          type="button"
          data-scroll-anchor-ignore
          className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-muted-foreground/70 transition-colors hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground"
          style={footerTextStyle}
          onClick={onBack}
        >
          <ChevronLeftIcon className="size-3.5" />
          <span>Back</span>
        </button>

        <div className="mt-3 border-b border-border/55 pb-4">
          <div className="flex min-w-0 items-start gap-3">
            <span className="mt-1 flex size-7 shrink-0 items-center justify-center rounded-md border border-border/45 bg-background/65 text-muted-foreground/58">
              <BotIcon className="size-3.5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <h2 className="truncate text-[18px] font-medium leading-6 text-foreground/92">
                  {detail.title}
                </h2>
                <span className="rounded-full border border-border/45 px-2 py-0.5 text-[10px] font-medium text-muted-foreground/56">
                  {`${detail.entries.length} ${pluralize(detail.entries.length, "update")}`}
                </span>
              </div>
              {detail.summary ? (
                <p className="mt-1 max-w-4xl text-muted-foreground/58" style={chatTypographyStyle}>
                  {detail.summary}
                </p>
              ) : null}
            </div>
          </div>
        </div>

        {prompt ? (
          <AgentActivitySection title="Prompt">
            <ChatMarkdown
              text={prompt}
              cwd={markdownCwd}
              isStreaming={false}
              style={chatTypographyStyle}
              onImageExpand={onImageExpand}
            />
          </AgentActivitySection>
        ) : null}

        {result ? (
          <AgentActivitySection title="Result">
            <ChatMarkdown
              text={result}
              cwd={markdownCwd}
              isStreaming={false}
              style={chatTypographyStyle}
              onImageExpand={onImageExpand}
            />
          </AgentActivitySection>
        ) : null}

        {subagents.length > 0 ? (
          <AgentActivitySection title="Agents">
            <div className="space-y-2">
              {subagents.map((subagent) => (
                <SubagentDetailRow
                  key={subagent.threadId}
                  subagent={subagent}
                  textStyle={chatTypographyStyle}
                  {...(onOpenThread ? { onOpenThread } : {})}
                />
              ))}
            </div>
          </AgentActivitySection>
        ) : null}

        <AgentActivitySection title="Activity">
          <div className="divide-y divide-border/45">
            {detail.entries.map((entry) => (
              <AgentActivityEventRow
                key={entry.id}
                entry={entry}
                markdownCwd={markdownCwd}
                chatTypographyStyle={chatTypographyStyle}
                footerTextStyle={footerTextStyle}
                onImageExpand={onImageExpand}
                timestampFormat={timestampFormat}
              />
            ))}
          </div>
        </AgentActivitySection>
      </div>
    </div>
  );
});

function AgentActivitySection(props: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-border/45 py-4 last:border-b-0">
      <h3 className="mb-2 text-[11px] font-medium text-muted-foreground/48">{props.title}</h3>
      {props.children}
    </section>
  );
}

function AgentActivityEventRow(props: {
  entry: WorkLogEntry;
  markdownCwd: string | undefined;
  chatTypographyStyle: CSSProperties;
  footerTextStyle: CSSProperties;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  timestampFormat: TimestampFormat;
}) {
  const preview = formatAgentActivityEntryPreview(props.entry);
  const title = formatAgentActivityEntryTitle(props.entry);
  const body = isReasoningUpdateWorkEntry(props.entry) ? preview : (preview ?? props.entry.detail);

  return (
    <div className="py-3 first:pt-0 last:pb-0">
      <div className="flex min-w-0 items-baseline justify-between gap-3">
        <p className="truncate font-medium text-foreground/78" style={props.chatTypographyStyle}>
          {title}
        </p>
        <p className="shrink-0 tabular-nums text-muted-foreground/38" style={props.footerTextStyle}>
          {formatShortTimestamp(props.entry.createdAt, props.timestampFormat)}
        </p>
      </div>
      {body ? (
        <div className="mt-1 text-muted-foreground/70">
          <ChatMarkdown
            text={body}
            cwd={props.markdownCwd}
            isStreaming={false}
            style={props.chatTypographyStyle}
            onImageExpand={props.onImageExpand}
          />
        </div>
      ) : null}
    </div>
  );
}

function SubagentDetailRow(props: {
  subagent: WorkLogSubagent;
  textStyle: CSSProperties;
  onOpenThread?: (threadId: ThreadId) => void;
}) {
  const presentation = resolveSubagentPresentation({
    nickname: props.subagent.nickname,
    role: props.subagent.role,
    title: props.subagent.title,
    fallbackId: props.subagent.threadId,
  });
  const modelLabel = formatSubagentModelLabel(props.subagent.model);
  const statusLabel = humanizeSubagentStatus(props.subagent.rawStatus, props.subagent.isActive);
  const canOpenThread = Boolean(props.onOpenThread);

  return (
    <div className="flex items-start gap-2.5 rounded-md border border-border/40 bg-background/45 px-3 py-2">
      <span
        className={cn(
          "mt-2 size-1.5 shrink-0 rounded-full",
          props.subagent.isActive ? "bg-sky-300/95" : "bg-muted-foreground/24",
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-foreground/86" style={props.textStyle}>
          <span style={{ color: presentation.accentColor }}>
            {presentation.nickname ?? presentation.primaryLabel}
          </span>
          {presentation.role ? (
            <span className="ml-1 text-muted-foreground/50">({presentation.role})</span>
          ) : null}
        </div>
        <div className="truncate text-muted-foreground/52" style={props.textStyle}>
          {[modelLabel, statusLabel].filter(Boolean).join(" - ")}
        </div>
        {props.subagent.latestUpdate ? (
          <div className="mt-1 text-muted-foreground/52" style={props.textStyle}>
            {props.subagent.latestUpdate}
          </div>
        ) : null}
      </div>
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
          props.onOpenThread?.(
            ThreadId.makeUnsafe(props.subagent.resolvedThreadId ?? props.subagent.threadId),
          )
        }
      >
        Open
      </button>
    </div>
  );
}

function findPrompt(entries: ReadonlyArray<WorkLogEntry>): string | null {
  for (const entry of entries) {
    const prompt =
      entry.subagentAction?.prompt ?? entry.subagents?.find((agent) => agent.prompt)?.prompt;
    if (prompt) {
      return prompt;
    }
  }
  return null;
}

function findResult(entries: ReadonlyArray<WorkLogEntry>): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.itemType === "collab_agent_tool_call" && entry.detail) {
      return entry.detail;
    }
  }
  return null;
}

function collectSubagents(entries: ReadonlyArray<WorkLogEntry>): WorkLogSubagent[] {
  const byThreadId = new Map<string, WorkLogSubagent>();
  for (const entry of entries) {
    for (const subagent of entry.subagents ?? []) {
      byThreadId.set(subagent.threadId, { ...byThreadId.get(subagent.threadId), ...subagent });
    }
  }
  return [...byThreadId.values()];
}
