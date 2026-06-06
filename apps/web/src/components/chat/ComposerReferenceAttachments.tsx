// FILE: ComposerReferenceAttachments.tsx
// Purpose: Render assistant-selection, browser-context, and image composer attachments in one reusable row.
// Layer: Chat composer presentation

import {
  type ComposerBrowserContextAttachment,
  type ComposerImageAttachment,
} from "../../composerDraftStore";
import { type ChatAssistantSelectionAttachment } from "../../types";
import { type ExpandedImagePreview } from "./ExpandedImagePreview";
import { AssistantSelectionsSummaryChip } from "./AssistantSelectionsSummaryChip";
import { ComposerBrowserContextAttachmentChip } from "./ComposerBrowserContextAttachmentChip";
import { ComposerImageAttachmentChip } from "./ComposerImageAttachmentChip";

interface ComposerReferenceAttachmentsProps {
  assistantSelections: ReadonlyArray<ChatAssistantSelectionAttachment>;
  images: ReadonlyArray<ComposerImageAttachment>;
  browserContexts: ReadonlyArray<ComposerBrowserContextAttachment>;
  nonPersistedImageIdSet: ReadonlySet<string>;
  onExpandBrowserContext: (preview: ExpandedImagePreview) => void;
  onExpandImage: (preview: ExpandedImagePreview) => void;
  onRemoveAssistantSelections: () => void;
  onRemoveBrowserContext: (contextId: string) => void;
  onRemoveImage: (imageId: string) => void;
}

export function ComposerReferenceAttachments({
  assistantSelections,
  images,
  browserContexts,
  nonPersistedImageIdSet,
  onExpandBrowserContext,
  onExpandImage,
  onRemoveAssistantSelections,
  onRemoveBrowserContext,
  onRemoveImage,
}: ComposerReferenceAttachmentsProps) {
  if (assistantSelections.length === 0 && images.length === 0 && browserContexts.length === 0) {
    return null;
  }

  return (
    <div className="mb-2 flex flex-wrap gap-2">
      <AssistantSelectionsSummaryChip
        selections={assistantSelections}
        onRemove={assistantSelections.length > 0 ? onRemoveAssistantSelections : undefined}
      />
      {browserContexts.map((context) => (
        <ComposerBrowserContextAttachmentChip
          key={context.id}
          context={context}
          contexts={browserContexts}
          onExpandContext={onExpandBrowserContext}
          onRemoveContext={onRemoveBrowserContext}
        />
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
