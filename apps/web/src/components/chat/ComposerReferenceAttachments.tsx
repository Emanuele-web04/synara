// FILE: ComposerReferenceAttachments.tsx
// Purpose: Render assistant-selection and image composer attachments in one reusable row.
// Layer: Chat composer presentation

import { type ComposerImageAttachment } from "../../composerDraftStore";
import { type FileCommentDraft } from "../../lib/fileComments";
import { type ChatAssistantSelectionAttachment } from "../../types";
import { type ExpandedImagePreview } from "./ExpandedImagePreview";
import { AssistantSelectionsSummaryChip } from "./AssistantSelectionsSummaryChip";
import { ComposerImageAttachmentChip } from "./ComposerImageAttachmentChip";
import { FileCommentsSummaryChip } from "./FileCommentsSummaryChip";

interface ComposerReferenceAttachmentsProps {
  assistantSelections: ReadonlyArray<ChatAssistantSelectionAttachment>;
  fileComments: ReadonlyArray<FileCommentDraft>;
  images: ReadonlyArray<ComposerImageAttachment>;
  nonPersistedImageIdSet: ReadonlySet<string>;
  onExpandImage: (preview: ExpandedImagePreview) => void;
  onRemoveAssistantSelections: () => void;
  onRemoveFileComments: () => void;
  onRemoveImage: (imageId: string) => void;
}

export function ComposerReferenceAttachments({
  assistantSelections,
  fileComments,
  images,
  nonPersistedImageIdSet,
  onExpandImage,
  onRemoveAssistantSelections,
  onRemoveFileComments,
  onRemoveImage,
}: ComposerReferenceAttachmentsProps) {
  if (assistantSelections.length === 0 && fileComments.length === 0 && images.length === 0) {
    return null;
  }

  return (
    <div className="-mx-1.5 -mt-1 mb-2 flex flex-wrap gap-1.5">
      <AssistantSelectionsSummaryChip
        selections={assistantSelections}
        onRemove={assistantSelections.length > 0 ? onRemoveAssistantSelections : undefined}
      />
      <FileCommentsSummaryChip
        comments={fileComments}
        onRemove={fileComments.length > 0 ? onRemoveFileComments : undefined}
      />
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
