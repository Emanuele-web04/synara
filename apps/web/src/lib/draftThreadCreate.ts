// FILE: draftThreadCreate.ts
// Purpose: Creates a standalone draft thread seeded with a prompt and model choice, and
//          optionally sends it right away. Tasks delegates a to-do through it; Kanban's
//          new-task dialog builds on createDraftThread.
// Layer: Web orchestration helper
// Exports: createDraftThread, createAndDispatchDraftThread, DraftThreadInput

import type {
  AssistantDeliveryMode,
  ModelSelection,
  ProjectId,
  ProviderInteractionMode,
  ProviderKind,
  ProviderStartOptions,
  RuntimeMode,
  ThreadId,
} from "@synara/contracts";

import { composerDraftsMatchForCleanup } from "../composerDraftDomain";
import { useComposerDraftStore, type DraftThreadEnvMode } from "../composerDraftStore";
import {
  dispatchDraftThread,
  type DraftThreadDispatchResult,
  type DraftDispatchProviderInstance,
} from "./draftThreadDispatch";
import { newThreadId } from "./utils";
import { isRequestOutcomeUnknown } from "./requestOutcome";

export interface DraftThreadInput {
  projectId: ProjectId;
  prompt: string;
  /** Optional scratch composer whose full transferable content seeds the new thread. */
  sourceComposerThreadId?: ThreadId;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  envMode: DraftThreadEnvMode;
  /** Absolute folder the agent works in when it differs from the project root. */
  workingDirectory?: string | null;
}

/**
 * Registers a new mapping-less draft thread and seeds its composer content. The
 * project's regular composer draft is untouched, so any number of threads can be
 * created back to back.
 */
export function createDraftThread(input: DraftThreadInput): ThreadId {
  const store = useComposerDraftStore.getState();
  const threadId = newThreadId();
  store.registerDraftThread(threadId, {
    projectId: input.projectId,
    envMode: input.envMode,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    ...(input.workingDirectory ? { workingDirectory: input.workingDirectory } : {}),
  });
  // The source can be gone by now (its form unmounted while the create was pending);
  // copying from it would leave the new chat empty, so fall back to the prompt.
  if (input.sourceComposerThreadId && store.draftsByThreadId[input.sourceComposerThreadId]) {
    store.copyTransferableComposerState(input.sourceComposerThreadId, threadId);
  } else {
    store.setPrompt(threadId, input.prompt);
  }
  store.setModelSelection(threadId, input.modelSelection);
  store.setRuntimeMode(threadId, input.runtimeMode);
  store.setInteractionMode(threadId, input.interactionMode);
  return threadId;
}

/**
 * Creates the draft, then immediately promotes + dispatches it. `beforeDispatch` runs
 * once the thread id exists and before anything reaches the server, so callers can
 * record the link (e.g. on a to-do) and abort by throwing.
 */
export async function createAndDispatchDraftThread(
  input: DraftThreadInput & {
    defaultProvider: ProviderKind;
    assistantDeliveryMode: AssistantDeliveryMode;
    providerOptions?: ProviderStartOptions | undefined;
    providerInstances?: ReadonlyArray<DraftDispatchProviderInstance>;
    beforeDispatch?: (threadId: ThreadId) => Promise<void>;
  },
): Promise<{ threadId: ThreadId; result: DraftThreadDispatchResult }> {
  const threadId = createDraftThread(input);
  if (input.beforeDispatch) {
    const createdComposerState = useComposerDraftStore.getState().draftsByThreadId[threadId];
    try {
      await input.beforeDispatch(threadId);
    } catch (error) {
      // A lost pre-dispatch reply may have stored a link to this draft. Keep it
      // reachable with its unsent content until the caller reconciles that outcome.
      const currentStore = useComposerDraftStore.getState();
      if (
        !isRequestOutcomeUnknown(error) &&
        composerDraftsMatchForCleanup(currentStore.draftsByThreadId[threadId], createdComposerState)
      ) {
        currentStore.clearDraftThread(threadId);
      }
      throw error;
    }
  }
  const result = await dispatchDraftThread({
    threadId,
    projectId: input.projectId,
    thread: null,
    defaultProvider: input.defaultProvider,
    assistantDeliveryMode: input.assistantDeliveryMode,
    providerOptions: input.providerOptions,
    providerInstances: input.providerInstances,
  });
  return { threadId, result };
}
