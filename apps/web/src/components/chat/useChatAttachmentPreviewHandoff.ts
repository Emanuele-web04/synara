import { useCallback, useEffect, useRef, useState } from "react";
import { type MessageId } from "@t3tools/contracts";
import { revokeBlobPreviewUrl, revokeBlobPreviewUrlsAfterPaint } from "../ChatView.logic";

const ATTACHMENT_PREVIEW_HANDOFF_TTL_MS = 5000;

export interface ChatAttachmentPreviewHandoff {
  attachmentPreviewHandoffByMessageId: Record<string, string[]>;
  handoffAttachmentPreviews: (messageId: MessageId, previewUrls: string[]) => void;
  clearAttachmentPreviewHandoffs: () => void;
}

export function useChatAttachmentPreviewHandoff(): ChatAttachmentPreviewHandoff {
  const [attachmentPreviewHandoffByMessageId, setAttachmentPreviewHandoffByMessageId] = useState<
    Record<string, string[]>
  >({});
  const attachmentPreviewHandoffByMessageIdRef = useRef<Record<string, string[]>>({});
  const attachmentPreviewHandoffTimeoutByMessageIdRef = useRef<Record<string, number>>({});

  useEffect(() => {
    attachmentPreviewHandoffByMessageIdRef.current = attachmentPreviewHandoffByMessageId;
  }, [attachmentPreviewHandoffByMessageId]);

  const clearAttachmentPreviewHandoffs = useCallback(() => {
    for (const timeoutId of Object.values(attachmentPreviewHandoffTimeoutByMessageIdRef.current)) {
      window.clearTimeout(timeoutId);
    }
    attachmentPreviewHandoffTimeoutByMessageIdRef.current = {};
    for (const previewUrls of Object.values(attachmentPreviewHandoffByMessageIdRef.current)) {
      for (const previewUrl of previewUrls) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }
    attachmentPreviewHandoffByMessageIdRef.current = {};
    setAttachmentPreviewHandoffByMessageId({});
  }, []);

  useEffect(() => {
    return () => {
      clearAttachmentPreviewHandoffs();
    };
  }, [clearAttachmentPreviewHandoffs]);

  const handoffAttachmentPreviews = useCallback((messageId: MessageId, previewUrls: string[]) => {
    if (previewUrls.length === 0) return;

    const previousPreviewUrls = attachmentPreviewHandoffByMessageIdRef.current[messageId] ?? [];
    const replacedPreviewUrls = previousPreviewUrls.filter(
      (previewUrl) => !previewUrls.includes(previewUrl),
    );
    revokeBlobPreviewUrlsAfterPaint(replacedPreviewUrls);
    setAttachmentPreviewHandoffByMessageId((existing) => {
      const next = {
        ...existing,
        [messageId]: previewUrls,
      };
      attachmentPreviewHandoffByMessageIdRef.current = next;
      return next;
    });

    const existingTimeout = attachmentPreviewHandoffTimeoutByMessageIdRef.current[messageId];
    if (typeof existingTimeout === "number") {
      window.clearTimeout(existingTimeout);
    }
    attachmentPreviewHandoffTimeoutByMessageIdRef.current[messageId] = window.setTimeout(() => {
      const currentPreviewUrls = attachmentPreviewHandoffByMessageIdRef.current[messageId];
      setAttachmentPreviewHandoffByMessageId((existing) => {
        if (!(messageId in existing)) return existing;
        const next = { ...existing };
        delete next[messageId];
        attachmentPreviewHandoffByMessageIdRef.current = next;
        return next;
      });
      delete attachmentPreviewHandoffTimeoutByMessageIdRef.current[messageId];
      // Let React swap the transcript back to persisted /attachments URLs before
      // invalidating blob previews that may still be mounted in the old row.
      if (currentPreviewUrls) {
        revokeBlobPreviewUrlsAfterPaint(currentPreviewUrls);
      }
    }, ATTACHMENT_PREVIEW_HANDOFF_TTL_MS);
  }, []);

  return {
    attachmentPreviewHandoffByMessageId,
    handoffAttachmentPreviews,
    clearAttachmentPreviewHandoffs,
  };
}

export { ATTACHMENT_PREVIEW_HANDOFF_TTL_MS };
