import type { ThreadId } from "@synara/contracts";
import { useComposerDraftStore } from "../../composerDraftStore";
import {
  restoreUserInputDraft,
  type PendingUserInputRecoveryDraft,
} from "../../pendingUserInputRecovery";
import { ComposerActionNotice } from "./ComposerActionNotice";

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
    <ComposerActionNotice
      message="These questions have expired. Restore your answers to review and send as a new message."
      actions={[
        { label: "Restore answers", onClick: restore },
        { label: "Dismiss", onClick: dismiss },
      ]}
    />
  );
}
