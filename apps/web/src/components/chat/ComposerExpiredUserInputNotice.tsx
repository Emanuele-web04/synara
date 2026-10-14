import type { ThreadId } from "@synara/contracts";
import { cn } from "~/lib/utils";
import { useComposerDraftStore } from "../../composerDraftStore";
import {
  restoreUserInputDraft,
  type PendingUserInputRecoveryDraft,
} from "../../pendingUserInputRecovery";
import { ComposerStackedPanel } from "./ComposerStackedPanel";
import { COMPOSER_INLINE_ACTION_PILL_CLASS_NAME } from "./composerPickerStyles";
import { COMPOSER_NOTICE_CONTENT_CLASS_NAME } from "./composerStackedPanelStyles";

export function ComposerExpiredUserInputNotice({
  threadId,
  requestKey,
  draft,
  onRestore,
}: {
  threadId: ThreadId;
  requestKey: string;
  draft: PendingUserInputRecoveryDraft;
  onRestore: (prompt: string) => void;
}) {
  const dismiss = () => {
    const store = useComposerDraftStore.getState();
    const drafts = store.draftsByThreadId[threadId]?.pendingUserInputDrafts ?? {};
    store.setPendingUserInputDrafts(
      threadId,
      Object.fromEntries(Object.entries(drafts).filter(([key]) => key !== requestKey)),
    );
  };
  const restore = () => {
    const store = useComposerDraftStore.getState();
    store.restorePromptHistorySavedDraft(threadId);
    const current = useComposerDraftStore.getState().draftsByThreadId[threadId];
    const prompt = restoreUserInputDraft(current?.prompt ?? "", draft);
    store.setPrompt(threadId, prompt);
    dismiss();
    onRestore(prompt);
  };
  return (
    <ComposerStackedPanel
      detached
      className={cn(COMPOSER_NOTICE_CONTENT_CLASS_NAME, "mb-2")}
      role="status"
    >
      <p>These questions have expired. Restore your answers to review and send as a new message.</p>
      <div className="mt-2 flex flex-wrap gap-3">
        <button type="button" className={COMPOSER_INLINE_ACTION_PILL_CLASS_NAME} onClick={restore}>
          Restore answers
        </button>
        <button type="button" className={COMPOSER_INLINE_ACTION_PILL_CLASS_NAME} onClick={dismiss}>
          Dismiss
        </button>
      </div>
    </ComposerStackedPanel>
  );
}
