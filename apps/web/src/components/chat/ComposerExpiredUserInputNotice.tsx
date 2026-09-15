import type { ThreadId } from "@synara/contracts";
import { useComposerDraftStore } from "../../composerDraftStore";
import {
  restoreUserInputDraft,
  type PendingUserInputRecoveryDraft,
} from "../../pendingUserInputRecovery";

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
    <div className="mb-2 rounded-xl border border-border px-4 py-3 text-sm" role="status">
      <p>These questions have expired. Restore your answers to review and send as a new message.</p>
      <div className="mt-2 flex gap-3">
        <button type="button" className="font-medium underline" onClick={restore}>
          Restore answers
        </button>
        <button type="button" className="text-muted-foreground" onClick={dismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
