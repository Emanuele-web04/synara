import type { ThreadId } from "@synara/contracts";
import { useComposerDraftStore } from "../../composerDraftStore";
import {
  restoreUserInputDraft,
  type PendingUserInputRecoveryDraft,
} from "../../pendingUserInputRecovery";
import { cn } from "~/lib/utils";
import { TRANSCRIPT_TEXT_BUTTON_CLASS_NAME } from "./MessageActionButton";

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
    <div
      className="mb-2 rounded-xl border border-border px-4 py-3 text-ui leading-snug"
      role="status"
    >
      <p>These questions have expired. Restore your answers to review and send as a new message.</p>
      <div className="mt-2 flex gap-3">
        <button
          type="button"
          className={cn("rounded-sm font-medium underline", TRANSCRIPT_TEXT_BUTTON_CLASS_NAME)}
          onClick={restore}
        >
          Restore answers
        </button>
        <button
          type="button"
          className={cn("rounded-sm text-muted-foreground", TRANSCRIPT_TEXT_BUTTON_CLASS_NAME)}
          onClick={dismiss}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
