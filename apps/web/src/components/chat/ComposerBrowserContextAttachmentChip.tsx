// FILE: ComposerBrowserContextAttachmentChip.tsx
// Purpose: Renders non-image browser context attachments in the composer reference row.
// Layer: Chat composer presentation

import { memo } from "react";
import { type ComposerBrowserContextAttachment } from "../../composerDraftStore";
import {
  buildExpandedBrowserContextPreview,
  type ExpandedImagePreview,
} from "./ExpandedImagePreview";
import { ComposerLiveEditorContextChip } from "./ComposerLiveEditorContextChip";

interface ComposerBrowserContextAttachmentChipProps {
  context: ComposerBrowserContextAttachment;
  contexts: readonly ComposerBrowserContextAttachment[];
  onExpandContext: (preview: ExpandedImagePreview) => void;
  onRemoveContext: (contextId: string) => void;
}

export const ComposerBrowserContextAttachmentChip = memo(
  function ComposerBrowserContextAttachmentChip({
    context,
    contexts,
    onExpandContext,
    onRemoveContext,
  }: ComposerBrowserContextAttachmentChipProps) {
    const expandContext = () => {
      const preview = buildExpandedBrowserContextPreview(contexts, context.id);
      if (!preview) return;
      onExpandContext(preview);
    };
    const title = context.title?.trim() || context.url || "Browser page";

    return (
      <ComposerLiveEditorContextChip
        title={title}
        onPreview={expandContext}
        onRemove={() => onRemoveContext(context.id)}
      />
    );
  },
);
