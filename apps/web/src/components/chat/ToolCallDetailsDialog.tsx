// FILE: ToolCallDetailsDialog.tsx
// Purpose: Modal inspector for command and file-change tool calls from transcript rows.
// Layer: Chat presentation component
// Exports: ToolCallDetailsDialog
// Depends on: WorkLogEntry.toolDetails and shared dialog chrome

import type { ReactNode } from "react";
import { ChangesIcon, TerminalIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import type { WorkLogToolOutputDetails } from "../../lib/toolCallDetails";
import type { WorkLogEntry } from "../../session-logic";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

const DETAIL_HEADER_CLASS_NAME =
  "border-b border-border/45 px-3 py-2 text-[10px] font-medium uppercase tracking-[0.14em]";
const DETAIL_CODE_BLOCK_CLASS_NAME =
  "max-h-[min(46vh,30rem)] overflow-auto whitespace-pre-wrap break-words font-chat-code text-[11px] leading-relaxed text-foreground/88";

interface ToolCallDetailsDialogProps {
  entry: WorkLogEntry | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ToolCallDetailsDialog({
  entry,
  open,
  onOpenChange,
}: ToolCallDetailsDialogProps) {
  const details = entry?.toolDetails;
  const Icon = details?.kind === "file-change" ? ChangesIcon : TerminalIcon;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup surface="solid" className="max-h-[min(86vh,760px)] max-w-4xl gap-0 p-0">
        <DialogHeader className="border-b border-border/55 pr-10">
          <div className="flex min-w-0 items-start gap-3">
            <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border border-border/45 bg-background/65 text-muted-foreground/62">
              <Icon className="size-3.5" />
            </span>
            <div className="min-w-0 flex-1">
              <DialogTitle className="truncate text-base">
                {details?.title ?? "Tool call"}
              </DialogTitle>
              <DialogDescription>
                {details?.kind === "file-change"
                  ? "Edit payload captured for this tool call."
                  : "Command payload captured for this tool call."}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <DialogPanel
          className="max-h-[min(72vh,620px)] space-y-4 px-4 py-4"
          data-tool-details-dialog="true"
        >
          {details ? (
            <>
              {details.command ? (
                <ToolDetailSection title="Command">
                  <ToolCodeBlock tone="command">{details.command}</ToolCodeBlock>
                </ToolDetailSection>
              ) : null}

              {details.files?.length ? (
                <ToolDetailSection title="Files">
                  <div className="flex flex-wrap gap-1.5">
                    {details.files.map((file) => (
                      <span
                        key={file}
                        className="max-w-full rounded-md border border-border/45 bg-background/70 px-2 py-1 font-chat-code text-[11px] text-foreground/82"
                        title={file}
                      >
                        {file}
                      </span>
                    ))}
                  </div>
                </ToolDetailSection>
              ) : null}

              {details.diff ? (
                <ToolDetailSection title="Diff">
                  <DiffCodeBlock>{details.diff}</DiffCodeBlock>
                </ToolDetailSection>
              ) : null}

              {details.edits?.length ? (
                <ToolDetailSection title="Edits">
                  <div className="space-y-3">
                    {details.edits.map((edit, index) => (
                      <div
                        key={`${edit.path ?? "edit"}:${index}`}
                        className="overflow-hidden rounded-lg border border-border/45 bg-background/58"
                      >
                        {edit.path ? (
                          <div className="border-b border-border/45 px-3 py-2 font-chat-code text-[11px] text-muted-foreground/72">
                            {edit.path}
                          </div>
                        ) : null}
                        <div className="grid gap-0 md:grid-cols-2">
                          {edit.oldText !== undefined ? (
                            <TextChangeBlock title="Before" tone="remove">
                              {edit.oldText}
                            </TextChangeBlock>
                          ) : null}
                          {edit.newText !== undefined ? (
                            <TextChangeBlock title="After" tone="add">
                              {edit.newText}
                            </TextChangeBlock>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                </ToolDetailSection>
              ) : null}

              {details.content ? (
                <ToolDetailSection title="Written Content">
                  <ToolCodeBlock>{details.content}</ToolCodeBlock>
                </ToolDetailSection>
              ) : null}

              {details.output ? <ToolOutputSection output={details.output} /> : null}
            </>
          ) : (
            <div className="rounded-lg border border-border/45 bg-background/60 px-3 py-2 text-sm text-muted-foreground">
              No detailed payload was available for this tool call.
            </div>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function ToolDetailSection(props: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground/56">
        {props.title}
      </h3>
      {props.children}
    </section>
  );
}

function ToolOutputSection({ output }: { output: WorkLogToolOutputDetails }) {
  return (
    <ToolDetailSection title="Output">
      <div className="space-y-3">
        {output.output ? <ToolCodeBlock>{output.output}</ToolCodeBlock> : null}
        {output.stdout ? (
          <LabeledCodeBlock title="Stdout" tone="output">
            {output.stdout}
          </LabeledCodeBlock>
        ) : null}
        {output.stderr ? (
          <LabeledCodeBlock title="Stderr" tone="error">
            {output.stderr}
          </LabeledCodeBlock>
        ) : null}
        {output.exitCode !== undefined || output.truncated ? (
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground/68">
            {output.exitCode !== undefined ? (
              <span className="rounded-full border border-border/45 px-2 py-0.5">
                Exit code {output.exitCode}
              </span>
            ) : null}
            {output.truncated ? (
              <span className="rounded-full border border-amber-500/30 bg-amber-500/8 px-2 py-0.5 text-amber-200/90">
                Truncated
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </ToolDetailSection>
  );
}

function LabeledCodeBlock(props: {
  title: string;
  tone: "output" | "error";
  children: string;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border/45 bg-background/58">
      <div
        className={cn(
          DETAIL_HEADER_CLASS_NAME,
          props.tone === "error" ? "text-rose-200/88" : "text-muted-foreground/60",
        )}
      >
        {props.title}
      </div>
      <ToolCodeBlock bare>{props.children}</ToolCodeBlock>
    </div>
  );
}

function TextChangeBlock(props: {
  title: string;
  tone: "add" | "remove";
  children: string;
}) {
  return (
    <div
      className={cn(
        "min-w-0 border-border/45 md:[&:not(:first-child)]:border-l",
        props.tone === "add" ? "bg-emerald-500/5" : "bg-rose-500/5",
      )}
    >
      <div
        className={cn(
          DETAIL_HEADER_CLASS_NAME,
          props.tone === "add" ? "text-emerald-200/82" : "text-rose-200/82",
        )}
      >
        {props.title}
      </div>
      <ToolCodeBlock bare>{props.children}</ToolCodeBlock>
    </div>
  );
}

function ToolCodeBlock(props: {
  children: string;
  tone?: "default" | "command";
  bare?: boolean;
}) {
  return (
    <pre
      className={cn(
        DETAIL_CODE_BLOCK_CLASS_NAME,
        props.tone === "command" && "text-sky-100/92",
        props.bare
          ? "px-3 py-2.5"
          : "rounded-lg border border-border/45 bg-background/70 px-3 py-2.5",
      )}
    >
      {props.children}
    </pre>
  );
}

function DiffCodeBlock({ children }: { children: string }) {
  const lines = children.split(/\r?\n/);
  return (
    <pre className="max-h-[min(52vh,34rem)] overflow-auto rounded-lg border border-border/45 bg-background/70 px-0 py-2 font-chat-code text-[11px] leading-relaxed">
      {lines.map((line, index) => (
        <span
          key={`${index}:${line.slice(0, 24)}`}
          className={cn(
            "block min-w-max whitespace-pre-wrap break-words px-3",
            line.startsWith("+") && !line.startsWith("+++")
              ? "bg-emerald-500/8 text-emerald-100/92"
              : null,
            line.startsWith("-") && !line.startsWith("---")
              ? "bg-rose-500/8 text-rose-100/92"
              : null,
            line.startsWith("@@") ? "text-sky-200/90" : null,
            /^(diff --git|index |--- |\+\+\+ )/.test(line) ? "text-muted-foreground/62" : null,
          )}
        >
          {line.length > 0 ? line : " "}
        </span>
      ))}
    </pre>
  );
}
