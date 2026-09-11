import { ThreadId, type ModelSelection, type ProviderStartOptions } from "@synara/contracts";
import { readNativeApi } from "~/nativeApi";
import {
  automationClarificationPrompt,
  buildComposerAutomationDraft,
  resolveComposerAutomationRequest,
} from "../../lib/composerAutomation";
import { projectModelSelection as automationProjectModelSelection } from "../../routes/-automations.shared";
import type { Project } from "../../types";
import { type Thread } from "../../types";
import { useChatAutomationCreation } from "./useChatAutomationCreation";
import { useChatAutomationSetup } from "./useChatAutomationSetup";
import { useChatComposerDraft } from "./useChatComposerDraft";
import { useChatTranscriptScroll } from "./useChatTranscriptScroll";
import { toastManager } from "../ui/toast";
import { makeAutomationSetupBubble } from "./automationSetupBubble";
interface ChatAutomationSendInput {
  threadId: ThreadId;
  pendingAutomationConversation: ReturnType<
    typeof useChatAutomationSetup
  >["pendingAutomationConversation"];
  trimmedPromptForSend: string;
  threadWorkspaceCwd: string | null;
  activeProject: Project;
  api: NonNullable<ReturnType<typeof readNativeApi>>;
  activeThreadIdRef: ReturnType<typeof useChatAutomationSetup>["activeThreadIdRef"];
  pendingAutomationConversationRef: ReturnType<
    typeof useChatAutomationSetup
  >["pendingAutomationConversationRef"];
  hasLiveTurn: boolean;
  hasLiveTurnRef: ReturnType<typeof useChatAutomationSetup>["hasLiveTurnRef"];
  hasPromptOnlySendableContent: boolean;
  promptRef: ReturnType<typeof useChatComposerDraft>["promptRef"];
  setComposerDraftPrompt: ReturnType<typeof useChatComposerDraft>["setComposerDraftPrompt"];
  activeThread: Thread;
  setComposerTrigger: ReturnType<typeof useChatComposerDraft>["setComposerTrigger"];
  armTranscriptAutoFollow: ReturnType<typeof useChatTranscriptScroll>["armTranscriptAutoFollow"];
  setPendingAutomationConversation: ReturnType<
    typeof useChatAutomationSetup
  >["setPendingAutomationConversation"];
  automationProjects: ReturnType<typeof useChatAutomationSetup>["automationProjects"];
  selectedModelSelectionForSend: ModelSelection;
  setAutomationDraftWarningContext: ReturnType<
    typeof useChatAutomationSetup
  >["setAutomationDraftWarningContext"];
  setAutomationDraftForm: ReturnType<typeof useChatAutomationSetup>["setAutomationDraftForm"];
  setAutomationDraftWarnings: ReturnType<
    typeof useChatAutomationSetup
  >["setAutomationDraftWarnings"];
  setAcknowledgedAutomationWarnings: ReturnType<
    typeof useChatAutomationSetup
  >["setAcknowledgedAutomationWarnings"];
  setAutomationDraftOpen: ReturnType<typeof useChatAutomationSetup>["setAutomationDraftOpen"];
  prepareAutomationFormForCreate: ReturnType<
    typeof useChatAutomationCreation
  >["prepareAutomationFormForCreate"];
  createAutomationFromForm: ReturnType<
    typeof useChatAutomationCreation
  >["createAutomationFromForm"];
  providerOptionsForDispatchForSend: ProviderStartOptions | undefined;
}

export async function handleChatAutomationSend({
  threadId,
  pendingAutomationConversation,
  trimmedPromptForSend,
  threadWorkspaceCwd,
  activeProject,
  api,
  activeThreadIdRef,
  pendingAutomationConversationRef,
  hasLiveTurn,
  hasLiveTurnRef,
  hasPromptOnlySendableContent,
  promptRef,
  setComposerDraftPrompt,
  activeThread,
  setComposerTrigger,
  armTranscriptAutoFollow,
  setPendingAutomationConversation,
  automationProjects,
  selectedModelSelectionForSend,
  setAutomationDraftWarningContext,
  setAutomationDraftForm,
  setAutomationDraftWarnings,
  setAcknowledgedAutomationWarnings,
  setAutomationDraftOpen,
  prepareAutomationFormForCreate,
  createAutomationFromForm,
  providerOptionsForDispatchForSend,
}: ChatAutomationSendInput): Promise<boolean> {
  const conversation = pendingAutomationConversation;
  // While gathering missing details, fold the reply into the cleaned request so it
  // re-resolves as a whole rather than parsing the bare answer (and never re-parses
  // "could you create an automation" scaffolding as the task).
  const messageForAutomation = conversation
    ? `${conversation.accumulatedMessage}\n${trimmedPromptForSend}`
    : trimmedPromptForSend;
  const automationRequest = await resolveComposerAutomationRequest({
    message: messageForAutomation,
    cwd: threadWorkspaceCwd ?? activeProject.cwd,
    generateIntent: (request) => api.server.generateAutomationIntent(request),
  });
  // Drop a stale resolve: bail if the user switched threads, or cancelled/changed the
  // setup, while generateAutomationIntent was awaiting.
  if (
    activeThreadIdRef.current !== threadId ||
    pendingAutomationConversationRef.current !== conversation ||
    (!hasLiveTurn && hasLiveTurnRef.current)
  ) {
    return true;
  }
  if (automationRequest.type !== "normal-chat") {
    if (automationRequest.type === "needs-clarification") {
      // Conversational setup only runs for prompt-only sends while no turn is live:
      // clearing the composer would drop attachments/mentions Cancel can't restore,
      // and ephemeral setup bubbles must not anchor a running turn's work rows.
      if (!hasPromptOnlySendableContent || hasLiveTurn) {
        toastManager.add({
          type: "warning",
          title: "Automation needs a bit more detail",
          description:
            automationRequest.reason ??
            'Add what it should do and how often, e.g. "every weekday at 9am, summarize my PRs".',
        });
        return true;
      }
      // Render the exchange in-thread: echo the user's words as a bubble and ask for
      // what's missing as an assistant bubble. Nothing reaches a provider; the cleaned
      // automationMessage accumulates for the next re-resolve and for Cancel's restore.
      const question = automationClarificationPrompt(automationRequest.missingFields);
      const priorBubbles = conversation?.bubbles ?? [];
      // Drop the submitted request from the composer (it is captured in
      // accumulatedMessage, so re-folding it would duplicate the scaffold) while
      // preserving anything typed *after* it during the async resolve.
      const liveDraft = promptRef.current.trimStart();
      const leftover = liveDraft.startsWith(trimmedPromptForSend)
        ? liveDraft.slice(trimmedPromptForSend.length).trimStart()
        : liveDraft;
      promptRef.current = leftover;
      setComposerDraftPrompt(activeThread.id, leftover);
      setComposerTrigger(null);
      // Bring the new question into view even if the user had scrolled up.
      armTranscriptAutoFollow(activeThread.id, true);
      setPendingAutomationConversation({
        threadId: activeThread.id,
        accumulatedMessage: automationRequest.automationMessage,
        bubbles: [
          ...priorBubbles,
          makeAutomationSetupBubble("user", trimmedPromptForSend),
          makeAutomationSetupBubble("assistant", question),
        ],
      });
      return true;
    }

    pendingAutomationConversationRef.current = null;
    setPendingAutomationConversation(null);
    const automationIntent = automationRequest.resolution.intent;
    const automationTargetThreadId =
      automationIntent.executionScope === "thread" ? activeThread.id : null;
    const automationDraft = buildComposerAutomationDraft({
      resolution: automationRequest.resolution,
      projectId: activeProject.id,
      projectModelSelection: automationProjectModelSelection(automationProjects, activeProject.id),
      selectedModelSelection: selectedModelSelectionForSend,
      targetThreadId: automationTargetThreadId,
      hasEphemeralContext: !hasPromptOnlySendableContent,
    });
    // A multi-turn setup always confirms before creating, so the user reviews the
    // parsed task/schedule (and any scaffolding the parser kept) rather than it
    // silently auto-creating a recurring job.
    if (automationDraft.needsDraftReview || conversation !== null) {
      if (conversation !== null) {
        // Keep the full multi-turn request in the composer so dismissing the review
        // dialog doesn't lose it (the single-turn path likewise leaves its text).
        // Restore only the text; any attachments/mentions on the final reply stay.
        const liveDraft = promptRef.current.trimStart();
        const leftover = liveDraft.startsWith(trimmedPromptForSend)
          ? liveDraft.slice(trimmedPromptForSend.length).trimStart()
          : liveDraft;
        const restoredPrompt = leftover
          ? `${messageForAutomation}\n${leftover}`
          : messageForAutomation;
        promptRef.current = restoredPrompt;
        setComposerDraftPrompt(activeThread.id, restoredPrompt);
      }
      setAutomationDraftWarningContext(automationDraft.warningContext);
      setAutomationDraftForm(automationDraft.form);
      setAutomationDraftWarnings(automationDraft.warnings);
      setAcknowledgedAutomationWarnings(automationDraft.acknowledgedWarningIds);
      setAutomationDraftOpen(true);
      return true;
    }
    const preparedAutomation = await prepareAutomationFormForCreate(automationDraft.form);
    if (!preparedAutomation) {
      return true;
    }
    await createAutomationFromForm({
      form: preparedAutomation.form,
      warnings: automationDraft.warnings,
      acknowledgedWarningIds: automationDraft.acknowledgedWarningIds,
      activityThreadId: preparedAutomation.activityThreadId,
      ...(providerOptionsForDispatchForSend
        ? { providerOptions: providerOptionsForDispatchForSend }
        : {}),
    });
    return true;
  }
  if (conversation) {
    // The combined text no longer reads as an automation; abandon setup and let
    // this message send as a normal chat turn instead of looping on the question.
    pendingAutomationConversationRef.current = null;
    setPendingAutomationConversation(null);
  }

  return false;
}
