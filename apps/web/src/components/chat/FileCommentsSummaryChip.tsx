// FILE: FileCommentsSummaryChip.tsx
// Purpose: Renders the compact file-comment count chip used in composer and user bubbles.
// Layer: Chat attachment presentation

import { pluralize } from "@synara/shared/text";

import { formatFileCommentLabel } from "~/lib/fileComments";
import { MessageCircleIcon } from "~/lib/icons";
import { AttachmentSummaryChip } from "./AttachmentSummaryChip";

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
    <AttachmentSummaryChip
      icon={MessageCircleIcon}
      label={commentCountLabel(props.comments.length)}
      removeLabel="Remove comments"
      onRemove={props.onRemove}
      tooltip={props.comments.map((comment, index) => (
        <div key={`${formatFileCommentLabel(comment)}:${index}`} className="space-y-0.5">
          <p className="text-[0.6875rem] font-medium text-muted-foreground">
            {formatFileCommentLabel(comment)}
          </p>
          <p className="text-xs leading-relaxed">{comment.text}</p>
        </div>
      ))}
    />
  );
}
