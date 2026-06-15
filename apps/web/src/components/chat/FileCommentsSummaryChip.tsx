// FILE: FileCommentsSummaryChip.tsx
// Purpose: Renders the compact file-comment count chip used in composer and user bubbles.
// Layer: Chat attachment presentation

import { pluralize } from "@t3tools/shared/text";

import { formatFileCommentLabel } from "~/lib/fileComments";
import { MessageCircleIcon, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { COMPOSER_ATTACHMENT_CHIP_CLASS_NAME } from "../composerInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

// Minimal shape shared by composer drafts (FileCommentDraft) and parsed bubble
// entries (ParsedFileCommentEntry) so one chip renders both without an id.
interface FileCommentChipEntry {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
}

interface FileCommentsSummaryChipProps {
  comments: ReadonlyArray<FileCommentChipEntry>;
  onRemove?: (() => void) | undefined;
}

function commentCountLabel(count: number): string {
  return `${count} ${pluralize(count, "comment")}`;
}

export function FileCommentsSummaryChip(props: FileCommentsSummaryChipProps) {
  if (props.comments.length === 0) {
    return null;
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "group relative",
              COMPOSER_ATTACHMENT_CHIP_CLASS_NAME,
              props.onRemove ? "pr-6" : "",
            )}
          >
            <span className="inline-flex h-6 min-w-0 items-center gap-1 rounded-full pl-2 pr-1.5">
              <MessageCircleIcon className="size-3.5 shrink-0 text-muted-foreground/90" />
              <span className="truncate">{commentCountLabel(props.comments.length)}</span>
            </span>
            {props.onRemove ? (
              <button
                type="button"
                className="absolute right-0.5 top-1/2 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded-full text-[var(--color-text-foreground-tertiary)] transition-all hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)]"
                aria-label="Remove comments"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  props.onRemove?.();
                }}
              >
                <XIcon className="size-3" />
              </button>
            ) : null}
          </span>
        }
      />
      <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap leading-tight">
        <div className="space-y-2">
          {props.comments.map((comment, index) => (
            <div key={`${formatFileCommentLabel(comment)}:${index}`} className="space-y-0.5">
              <p className="text-[0.6875rem] font-medium text-muted-foreground">
                {formatFileCommentLabel(comment)}
              </p>
              <p className="text-xs leading-relaxed">{comment.text}</p>
            </div>
          ))}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}
