// FILE: ToolCallDetailsDialog.tsx
// Purpose: Inline details content for command and file-change transcript rows.
// Layer: Chat presentation component
// Exports: ToolCallDetailsContent
// Depends on: WorkLogEntry.toolDetails

import type { ReactNode } from "react";
import { createMarkdownCodeFence, formatShellTranscript } from "~/lib/toolCallDetailsFormatting";
import { cn } from "~/lib/utils";
import type { TimestampFormat } from "../../appSettings";
import type { WorkLogToolDetails, WorkLogToolOutputDetails } from "../../lib/toolCallDetails";
import type { WorkLogLiveActivity } from "../../workLog";
import {
  formatLiveActivityElapsed,
  formatLiveActivityProgress,
  formatLiveActivityStateLabel,
  useLiveActivityNow,
} from "../../lib/liveActivityPresentation";
import { formatTimestamp } from "../../timestampFormat";
import ChatMarkdown from "../ChatMarkdown";
import { useTranslation, getFormatLocale } from "~/i18n";

const DETAIL_HEADER_CLASS_NAME =
  "border-b border-[color:var(--color-border)] px-3 py-2 text-ui-xs font-medium";
const DETAIL_CODE_BLOCK_CLASS_NAME =
  "max-h-[min(46vh,30rem)] overflow-auto whitespace-pre-wrap break-words font-chat-code text-chat-code leading-relaxed text-foreground";
const TOOL_DETAILS_MARKDOWN_CLASS_NAME = "text-ui leading-relaxed";

export function ToolCallDetailsContent({
  details,
  activity,
  timestampFormat,
}: {
  details: WorkLogToolDetails | undefined;
  activity?: WorkLogLiveActivity | undefined;
  timestampFormat: TimestampFormat;
}) {
  const { t } = useTranslation();

  if (!details && !activity) {
    return (
      <div className="rounded-lg border border-[color:var(--color-border)] bg-foreground/2 px-3 py-2 text-ui leading-snug text-muted-foreground">
        {t("chat:toolCallDetails_noPayload")}
      </div>
    );
  }

  return (
    <>
      {activity ? (
        <LiveActivityMetadata activity={activity} timestampFormat={timestampFormat} />
      ) : null}

      {details?.command ? (
        <div className="space-y-2">
          <MarkdownToolCodeBlock language="bash">
            {formatShellTranscript(details.command, details.output)}
          </MarkdownToolCodeBlock>
          {details.output ? <ToolOutputMetadata output={details.output} /> : null}
        </div>
      ) : null}

      {details?.files?.length ? (
        <ToolDetailSection title={t("workspace:toolCallDetails_filesSection")}>
          <div className="flex flex-wrap gap-1.5">
            {details.files.map((file) => (
              <span
                key={file}
                className="max-w-full rounded-md border border-[color:var(--color-border)] bg-foreground/2 px-2 py-1 font-chat-code text-chat-code text-foreground"
                title={file}
              >
                {file}
              </span>
            ))}
          </div>
        </ToolDetailSection>
      ) : null}

      {details?.diff ? (
        <ToolDetailSection title={t("workspace:toolCallDetails_diffSection")}>
          <DiffCodeBlock>{details.diff}</DiffCodeBlock>
        </ToolDetailSection>
      ) : null}

      {details?.edits?.length ? (
        <ToolDetailSection title={t("chat:toolCallDetails_editsSection")}>
          <div className="space-y-3">
            {details.edits.map((edit, index) => (
              <div
                key={`${edit.path ?? "edit"}:${index}`}
                className="overflow-hidden rounded-lg border border-[color:var(--color-border)] bg-foreground/2"
              >
                {edit.path ? (
                  <div className="border-b border-[color:var(--color-border)] px-3 py-2 font-chat-code text-chat-code text-muted-foreground">
                    {edit.path}
                  </div>
                ) : null}
                <div className="grid gap-0 md:grid-cols-2">
                  {edit.oldText !== undefined ? (
                    <TextChangeBlock title={t("chat:toolCallDetails_before")} tone="remove">
                      {edit.oldText}
                    </TextChangeBlock>
                  ) : null}
                  {edit.newText !== undefined ? (
                    <TextChangeBlock title={t("chat:toolCallDetails_after")} tone="add">
                      {edit.newText}
                    </TextChangeBlock>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </ToolDetailSection>
      ) : null}

      {details?.content ? (
        <ToolDetailSection title={t("chat:toolCallDetails_writtenContent")}>
          <MarkdownToolCodeBlock language="text">{details.content}</MarkdownToolCodeBlock>
        </ToolDetailSection>
      ) : null}

      {details?.output && !details.command ? <ToolOutputSection output={details.output} /> : null}
    </>
  );
}

function formatActivityTimestamp(value: string, timestampFormat: TimestampFormat): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return value;
  }
  return formatTimestamp(value, timestampFormat, getFormatLocale());
}

function LiveActivityMetadata({
  activity,
  timestampFormat,
}: {
  activity: WorkLogLiveActivity;
  timestampFormat: TimestampFormat;
}) {
  const { t } = useTranslation();

  const stateLabel = formatLiveActivityStateLabel(activity.state);
  const nowMs = useLiveActivityNow(activity);
  const elapsed = formatLiveActivityElapsed(activity, nowMs);
  const progress =
    activity.progress !== undefined ? formatLiveActivityProgress(activity.progress) : null;

  return (
    <ToolDetailSection title={t("workspace:profile_activity")}>
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-lg border border-[color:var(--color-border)] bg-foreground/2 px-3 py-2.5 text-ui-sm">
        <dt className="text-muted-foreground">{t("chat:detail_status")}</dt>
        <dd className="text-foreground">{stateLabel}</dd>
        {activity.startedAt ? (
          <>
            <dt className="text-muted-foreground">{t("chat:started")}</dt>
            <dd className="text-foreground">
              <time dateTime={activity.startedAt} title={activity.startedAt}>
                {formatActivityTimestamp(activity.startedAt, timestampFormat)}
              </time>
            </dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">{t("chat:lastActivity")}</dt>
        <dd className="text-foreground">
          <time dateTime={activity.lastActivityAt} title={activity.lastActivityAt}>
            {formatActivityTimestamp(activity.lastActivityAt, timestampFormat)}
          </time>
        </dd>
        {elapsed ? (
          <>
            <dt className="text-muted-foreground">{t("chat:elapsed")}</dt>
            <dd className="tabular-nums text-foreground">{elapsed}</dd>
          </>
        ) : null}
        {progress ? (
          <>
            <dt className="text-muted-foreground">{t("chat:progress")}</dt>
            <dd className="tabular-nums text-foreground">{progress}</dd>
          </>
        ) : null}
        {activity.detail ? (
          <>
            <dt className="text-muted-foreground">{t("chat:detail")}</dt>
            <dd className="break-words text-foreground">{activity.detail}</dd>
          </>
        ) : null}
      </dl>
    </ToolDetailSection>
  );
}

function MarkdownToolCodeBlock(props: { language: string; children: string }) {
  return (
    <ChatMarkdown
      text={createMarkdownCodeFence(props.language, props.children)}
      cwd={undefined}
      className={TOOL_DETAILS_MARKDOWN_CLASS_NAME}
    />
  );
}

function ToolDetailSection(props: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-ui-sm font-medium text-muted-foreground">{props.title}</h3>
      {props.children}
    </section>
  );
}

function ToolOutputMetadata({ output }: { output: WorkLogToolOutputDetails }) {
  const { t } = useTranslation();

  if (output.exitCode === undefined && !output.truncated) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-ui-sm text-muted-foreground">
      {output.exitCode !== undefined ? (
        <span className="rounded-full border border-[color:var(--color-border)] px-2 py-0.5">
          {t("chat:exitCode")} {output.exitCode}
        </span>
      ) : null}
      {output.truncated ? (
        <span className="rounded-full border border-warning/30 bg-warning/8 px-2 py-0.5 text-warning">
          {t("chat:toolCallDetails_truncated")}
        </span>
      ) : null}
    </div>
  );
}

function ToolOutputSection({ output }: { output: WorkLogToolOutputDetails }) {
  const { t } = useTranslation();

  return (
    <ToolDetailSection title={t("chat:toolCallDetails_outputSection")}>
      <div className="space-y-3">
        {output.output ? (
          <MarkdownToolCodeBlock language="text">{output.output}</MarkdownToolCodeBlock>
        ) : null}
        {output.stdout ? (
          <LabeledCodeBlock title={t("chat:toolCallDetails_stdout")} tone="output">
            {output.stdout}
          </LabeledCodeBlock>
        ) : null}
        {output.stderr ? (
          <LabeledCodeBlock title={t("chat:toolCallDetails_stderr")} tone="error">
            {output.stderr}
          </LabeledCodeBlock>
        ) : null}
        <ToolOutputMetadata output={output} />
      </div>
    </ToolDetailSection>
  );
}

function LabeledCodeBlock(props: { title: string; tone: "output" | "error"; children: string }) {
  return (
    <div className="overflow-hidden rounded-lg border border-[color:var(--color-border)] bg-foreground/2">
      <div
        className={cn(
          DETAIL_HEADER_CLASS_NAME,
          props.tone === "error" ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {props.title}
      </div>
      <ToolCodeBlock bare>{props.children}</ToolCodeBlock>
    </div>
  );
}

function TextChangeBlock(props: { title: string; tone: "add" | "remove"; children: string }) {
  return (
    <div
      className={cn(
        "min-w-0 border-[color:var(--color-border)] md:[&:not(:first-child)]:border-l",
        props.tone === "add" ? "bg-success/5" : "bg-destructive/5",
      )}
    >
      <div
        className={cn(
          DETAIL_HEADER_CLASS_NAME,
          props.tone === "add"
            ? "text-[var(--color-decoration-added)]"
            : "text-[var(--color-decoration-deleted)]",
        )}
      >
        {props.title}
      </div>
      <ToolCodeBlock bare>{props.children}</ToolCodeBlock>
    </div>
  );
}

function ToolCodeBlock(props: { children: string; tone?: "default" | "command"; bare?: boolean }) {
  return (
    <pre
      className={cn(
        DETAIL_CODE_BLOCK_CLASS_NAME,
        props.tone === "command" && "text-foreground",
        props.bare
          ? "px-3 py-2.5"
          : "rounded-lg border border-[color:var(--color-border)] bg-foreground/2 px-3 py-2.5",
      )}
    >
      {props.children}
    </pre>
  );
}

function DiffCodeBlock({ children }: { children: string }) {
  const lines = children.split(/\r?\n/);
  return (
    <pre className="max-h-[min(52vh,34rem)] overflow-auto rounded-lg border border-[color:var(--color-border)] bg-foreground/2 px-0 py-2 font-chat-code text-chat-code leading-relaxed">
      {lines.map((line, index) => (
        <span
          key={`${index}:${line.slice(0, 24)}`}
          className={cn(
            "block min-w-max whitespace-pre-wrap break-words px-3",
            line.startsWith("+") && !line.startsWith("+++")
              ? "bg-success/8 text-[var(--color-decoration-added)]"
              : null,
            line.startsWith("-") && !line.startsWith("---")
              ? "bg-destructive/8 text-[var(--color-decoration-deleted)]"
              : null,
            line.startsWith("@@") ? "text-info" : null,
            /^(diff --git|index |--- |\+\+\+ )/.test(line) ? "text-muted-foreground" : null,
          )}
        >
          {line.length > 0 ? line : " "}
        </span>
      ))}
    </pre>
  );
}
