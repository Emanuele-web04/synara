// FILE: attachmentProjection.ts
// Purpose: Builds provider prompt text for attachments that a provider must read from disk.
// Layer: Provider adapter utility
// Depends on: attachmentStore path resolution and shared byte formatting.

import type { ChatAttachment, ChatImageAttachment } from "@synara/contracts";
import { formatBytes } from "@synara/shared/formatBytes";

import { resolveAttachmentPath } from "../attachmentStore.ts";

function isProjectedFileAttachment(
  attachment: ChatAttachment,
  include: "all-files" | "non-pdf-files",
  includeImage: ((attachment: ChatImageAttachment) => boolean) | undefined,
): boolean {
  if (attachment.type === "image") {
    return includeImage?.(attachment) ?? false;
  }
  if (attachment.type !== "file") {
    return false;
  }
  if (include === "all-files") {
    return true;
  }
  return attachment.mimeType.toLowerCase() !== "application/pdf";
}

function quotePromptValue(value: string): string {
  return JSON.stringify(value);
}

// Produces a stable path-reference block for regular files and selected non-native image types.
export function buildFileAttachmentsPromptBlock(input: {
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined;
  readonly attachmentsDir: string;
  readonly include: "all-files" | "non-pdf-files";
  readonly includeImage?: (attachment: ChatImageAttachment) => boolean;
}): string | null {
  const lines: string[] = [];
  for (const attachment of input.attachments ?? []) {
    if (!isProjectedFileAttachment(attachment, input.include, input.includeImage)) {
      continue;
    }
    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: input.attachmentsDir,
      attachment,
    });
    if (!attachmentPath) {
      console.warn(`[attachments] Skipping unresolved file attachment path for ${attachment.id}.`);
      continue;
    }
    lines.push(
      `- ${quotePromptValue(attachment.name)} - ${attachment.mimeType} - ${formatBytes(attachment.sizeBytes)} - ${attachmentPath}`,
    );
  }

  if (lines.length === 0) {
    return null;
  }

  return [
    "<attached_files>",
    "The user attached the following file(s), saved on disk. Read/extract them with your tools as needed; do not assume their contents.",
    ...lines,
    "</attached_files>",
  ].join("\n");
}

export function appendFileAttachmentsPromptBlock(input: {
  readonly text: string | undefined;
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined;
  readonly attachmentsDir: string;
  readonly include: "all-files" | "non-pdf-files";
  readonly includeImage?: (attachment: ChatImageAttachment) => boolean;
}): string | undefined {
  const fileBlock = buildFileAttachmentsPromptBlock({
    attachments: input.attachments,
    attachmentsDir: input.attachmentsDir,
    include: input.include,
    includeImage: input.includeImage,
  });
  return fileBlock ? `${input.text ?? ""}${input.text ? "\n\n" : ""}${fileBlock}` : input.text;
}
