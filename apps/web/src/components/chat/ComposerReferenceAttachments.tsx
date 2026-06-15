// FILE: ComposerReferenceAttachments.tsx
// Purpose: Render assistant-selection, browser-context, and image composer attachments in one reusable row.
// Layer: Chat composer presentation

import {
  type ComposerBrowserContextAttachment,
  type ComposerImageAttachment,
} from "../../composerDraftStore";
import { buildUnifiedBrowserEditorPromptBlock } from "../../lib/browserEditorContext";
import { type ChatAssistantSelectionAttachment } from "../../types";
import {
  buildExpandedLiveEditorContextPreview,
  type ExpandedImagePreview,
} from "./ExpandedImagePreview";
import { AssistantSelectionsSummaryChip } from "./AssistantSelectionsSummaryChip";
import { ComposerBrowserContextAttachmentChip } from "./ComposerBrowserContextAttachmentChip";
import { ComposerImageAttachmentChip } from "./ComposerImageAttachmentChip";
import { ComposerLiveEditorContextChip } from "./ComposerLiveEditorContextChip";

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
  const liveEditorImages = images.filter((image) => image.browserAnnotation);
  const regularImages = images.filter((image) => !image.browserAnnotation);
  const liveEditorPromptBlock = buildUnifiedBrowserEditorPromptBlock([
    ...browserContexts.map((context) => context.promptBlock),
    ...liveEditorImages.map((image) => image.browserAnnotation?.promptBlock),
  ]);
  const liveEditorTitle =
    liveEditorImages.find((image) => image.browserAnnotation?.title)?.browserAnnotation?.title ||
    browserContexts[0]?.title ||
    "Live Editor Context";
  const liveEditorNonPersisted = liveEditorImages.some((image) =>
    nonPersistedImageIdSet.has(image.id),
  );
  const expandLiveEditorContext = () => {
    if (!liveEditorPromptBlock) return;
    const preview = buildExpandedLiveEditorContextPreview({
      images: liveEditorImages,
      contexts: browserContexts,
      promptBlock: liveEditorPromptBlock,
    });
    if (!preview) return;
    onExpandBrowserContext(preview);
  };
  const removeLiveEditorContext = () => {
    for (const context of browserContexts) {
      onRemoveBrowserContext(context.id);
    }
    for (const image of liveEditorImages) {
      onRemoveImage(image.id);
    }
  };

  return (
    <div className="mb-2 flex flex-wrap gap-2">
      <AssistantSelectionsSummaryChip
        selections={assistantSelections}
        onRemove={assistantSelections.length > 0 ? onRemoveAssistantSelections : undefined}
      />
      {liveEditorPromptBlock ? (
        <ComposerLiveEditorContextChip
          title={liveEditorTitle}
          nonPersisted={liveEditorNonPersisted}
          nonPersistedTitle="Draft live editor context could not be saved locally and may be lost on navigation."
          onPreview={expandLiveEditorContext}
          onRemove={removeLiveEditorContext}
        />
      ) : (
        browserContexts.map((context) => (
          <ComposerBrowserContextAttachmentChip
            key={context.id}
            context={context}
            contexts={browserContexts}
            onExpandContext={onExpandBrowserContext}
            onRemoveContext={onRemoveBrowserContext}
          />
        ))
      )}
      {regularImages.map((image) => (
        <ComposerImageAttachmentChip
          key={image.id}
          image={image}
          images={regularImages}
          nonPersisted={nonPersistedImageIdSet.has(image.id)}
          onExpandImage={onExpandImage}
          onRemoveImage={onRemoveImage}
        />
      ))}
    </div>
  );
}
