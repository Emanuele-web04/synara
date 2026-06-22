// FILE: FileAttachmentChip.tsx
// Purpose: Renders generic file attachments in the composer and transcript.
// Layer: Chat attachment presentation
// Depends on: shared byte formatting, chat attachment types, and compact chip styles.

import { formatBytes } from "@t3tools/shared/formatBytes";

import { CircleAlertIcon, FileIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { type ChatFileAttachment } from "../../types";
import { COMPOSER_ATTACHMENT_CHIP_CLASS_NAME } from "../composerInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AttachmentRemoveButton } from "./AttachmentRemoveButton";

interface FileAttachmentChipProps {
  file: ChatFileAttachment;
  onRemove?: ((fileId: string) => void) | undefined;
  className?: string;
  nonPersisted?: boolean;
}

export function FileAttachmentChip({
  file,
  onRemove,
  className,
  nonPersisted = false,
}: FileAttachmentChipProps) {
  const detail = `${file.mimeType} - ${formatBytes(file.sizeBytes)}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "group relative",
              COMPOSER_ATTACHMENT_CHIP_CLASS_NAME,
              onRemove ? "pr-6" : "",
              className,
            )}
          >
            <span className="inline-flex h-7 min-w-0 max-w-[16rem] items-center gap-1.5 rounded-full pl-2 pr-2">
              <FileIcon className="size-3.5 shrink-0 text-muted-foreground/90" />
              <span className="min-w-0 truncate">{file.name}</span>
              <span className="shrink-0 text-muted-foreground/70">
                {formatBytes(file.sizeBytes)}
              </span>
              {nonPersisted ? (
                <span
                  role="img"
                  aria-label="Draft attachment may not persist"
                  className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-amber-600"
                >
                  <CircleAlertIcon className="size-3" />
                </span>
              ) : null}
            </span>
            {onRemove ? (
              <AttachmentRemoveButton
                size="sm"
                placement="center-right"
                label={`Remove ${file.name}`}
                onRemove={() => onRemove(file.id)}
              />
            ) : null}
          </span>
        }
      />
      <TooltipPopup side="top" className="max-w-80 whitespace-normal leading-tight">
        <div className="space-y-1">
          <p className="text-xs font-medium text-foreground">{file.name}</p>
          <p className="text-[0.6875rem] text-muted-foreground">{detail}</p>
          {nonPersisted ? (
            <p className="text-[0.6875rem] text-amber-600">
              Draft attachment is kept in memory and may be lost on navigation.
            </p>
          ) : null}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}
