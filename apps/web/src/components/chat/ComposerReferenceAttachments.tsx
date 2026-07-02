// FILE: ComposerReferenceAttachments.tsx
// Purpose: Render assistant-selection, file-comment, pasted-text, file, and image
//   composer attachments in one reusable row.
// Layer: Chat composer presentation

import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
} from "../../composerDraftStore";
import { type PastedTextDraft } from "../../lib/composerPastedText";
import { type FileCommentDraft } from "../../lib/fileComments";
import { type ChatAssistantSelectionAttachment } from "../../types";
import { type ExpandedImagePreview } from "./ExpandedImagePreview";
import { AssistantSelectionsSummaryChip } from "./AssistantSelectionsSummaryChip";
import { ComposerImageAttachmentChip } from "./ComposerImageAttachmentChip";
import { FileAttachmentChip } from "./FileAttachmentChip";
import { ComposerPastedTextCard } from "./PastedTextChip";
import { FileCommentsSummaryChip } from "./FileCommentsSummaryChip";

interface ComposerReferenceAttachmentsProps {
  assistantSelections: ReadonlyArray<ChatAssistantSelectionAttachment>;
  fileComments: ReadonlyArray<FileCommentDraft>;
  pastedTexts?: ReadonlyArray<PastedTextDraft>;
  files: ReadonlyArray<ComposerFileAttachment>;
  images: ReadonlyArray<ComposerImageAttachment>;
  nonPersistedImageIdSet: ReadonlySet<string>;
  onExpandImage: (preview: ExpandedImagePreview) => void;
  onRemoveAssistantSelections: () => void;
  onRemoveFileComments: () => void;
  onRemovePastedText?: (pastedTextId: string) => void;
  onShowPastedTextInField?: (pastedTextId: string) => void;
  onRemoveFile: (fileId: string) => void;
  onRemoveImage: (imageId: string) => void;
}

export function ComposerReferenceAttachments({
  assistantSelections,
  fileComments,
  pastedTexts = [],
  files,
  images,
  nonPersistedImageIdSet,
  onExpandImage,
  onRemoveAssistantSelections,
  onRemoveFileComments,
  onRemovePastedText,
  onShowPastedTextInField,
  onRemoveFile,
  onRemoveImage,
}: ComposerReferenceAttachmentsProps) {
  if (
    assistantSelections.length === 0 &&
    fileComments.length === 0 &&
    pastedTexts.length === 0 &&
    files.length === 0 &&
    images.length === 0
  ) {
    return null;
  }

  return (
    <div className="-mx-1.5 -mt-1 mb-2 flex flex-wrap items-start gap-1.5">
      <AssistantSelectionsSummaryChip
        selections={assistantSelections}
        onRemove={assistantSelections.length > 0 ? onRemoveAssistantSelections : undefined}
      />
      <FileCommentsSummaryChip
        comments={fileComments}
        onRemove={fileComments.length > 0 ? onRemoveFileComments : undefined}
      />
      {pastedTexts.map((pasted) => (
        <ComposerPastedTextCard
          key={pasted.id}
          text={pasted.text}
          metrics={{ lineCount: pasted.lineCount, charCount: pasted.charCount }}
          onShowInTextField={() => onShowPastedTextInField?.(pasted.id)}
          onRemove={() => onRemovePastedText?.(pasted.id)}
        />
      ))}
      {files.map((file) => (
        <FileAttachmentChip key={file.id} file={file} variant="card" onRemove={onRemoveFile} />
      ))}
      {images.map((image) => (
        <ComposerImageAttachmentChip
          key={image.id}
          image={image}
          images={images}
          nonPersisted={nonPersistedImageIdSet.has(image.id)}
          onExpandImage={onExpandImage}
          onRemoveImage={onRemoveImage}
        />
      ))}
    </div>
  );
}
