// Purpose: Route selected transcript text through the normal Side and new-chat flows.

import type { ProjectId, ThreadEnvironmentMode, ThreadId } from "@synara/contracts";

import { useComposerDraftStore, type QueuedComposerChatTurn } from "../composerDraftStore";
import { requestComposerFocus } from "../composerFocusRequestStore";
import { ensureNativeApi } from "../nativeApi";
import { useProjectEnvironmentStore } from "../projectEnvironmentStore";
import { useRightDockStore } from "../rightDockStore";
import { useStore } from "../store";
import { createAssistantSelectionAttachment } from "./assistantSelections";
import { createSidechatThread } from "./sidechatCreation";
import type { NewThreadOptions } from "./threadBootstrap";
import { randomUUID } from "./utils";
import type { TranscriptAssistantSelection } from "../components/chat/chatSelectionActions";

function requireSelection(selection: TranscriptAssistantSelection) {
  const attachment = createAssistantSelectionAttachment(selection);
  if (!attachment) throw new Error("Select between 1 and 4,000 characters.");
  return attachment;
}

export async function addSelectionToSide(
  input: Pick<
    Parameters<typeof createSidechatThread>[0],
    "project" | "sourceThread" | "selectedModelSelection"
  > & { selection: TranscriptAssistantSelection },
): Promise<void> {
  const attachment = requireSelection(input.selection);
  if (input.sourceThread.sidechatSourceThreadId || input.sourceThread.sidechatExpiredAt) {
    throw new Error("Open a main chat before starting Side.");
  }
  await createSidechatThread({
    api: ensureNativeApi(),
    project: input.project,
    sourceThread: input.sourceThread,
    selectedModelSelection: input.selectedModelSelection,
    openSidechat: (threadId) => {
      // Seed the reference before mounting the Side composer, including during a slow sync.
      useComposerDraftStore.getState().addAssistantSelection(threadId, attachment);
      useRightDockStore.getState().openPane(input.sourceThread.id, { kind: "sidechat", threadId });
      requestComposerFocus(threadId);
    },
    syncServerShellSnapshot: (snapshot) => useStore.getState().syncServerShellSnapshot(snapshot),
  });
}

type SelectionChatSettings = Pick<
  QueuedComposerChatTurn,
  "modelSelection" | "selectedPromptEffort" | "providerOptionsForDispatch" | "runtimeMode"
>;

export async function startSelectionChat(
  input: SelectionChatSettings & {
    projectId: ProjectId;
    projectCwd: string;
    selection: TranscriptAssistantSelection;
    prompt: string;
    envMode: ThreadEnvironmentMode;
    intent?: "send" | "compose";
    createThread: (projectId: ProjectId, options: NewThreadOptions) => Promise<ThreadId | null>;
  },
): Promise<void> {
  const attachment = requireSelection(input.selection);
  const prompt = input.prompt.trim();
  if (!prompt && input.intent !== "compose") throw new Error("Write a message for the new chat.");

  let branch: string | null = null;
  if (input.envMode === "worktree") {
    const status = await ensureNativeApi().git.status({ cwd: input.projectCwd });
    branch = status.branch;
    if (!branch) throw new Error("Check out a branch before starting a new worktree.");
  }
  const threadId = await input.createThread(input.projectId, {
    fresh: true,
    entryPoint: "chat",
    envMode: input.envMode,
    branch,
    worktreePath: null,
    workingDirectory: null,
  });
  if (!threadId) throw new Error("Could not open the new chat. Try again.");

  const drafts = useComposerDraftStore.getState();
  drafts.setModelSelection(threadId, input.modelSelection);
  drafts.setRuntimeMode(threadId, input.runtimeMode);
  drafts.setInteractionMode(threadId, "default");
  useProjectEnvironmentStore.getState().setProjectEnvMode(input.projectId, input.envMode);
  if (input.intent === "compose") {
    drafts.setPrompt(threadId, input.prompt);
    drafts.addAssistantSelection(threadId, attachment);
    requestComposerFocus(threadId);
    return;
  }
  // The destination ChatView drains this queue through its regular first-send path,
  // including worktree creation, setup scripts, attachment serialization and recovery.
  drafts.enqueueQueuedTurn(threadId, {
    id: randomUUID(),
    kind: "chat",
    createdAt: new Date().toISOString(),
    previewText: prompt,
    prompt,
    assistantSelections: [attachment],
    images: [],
    files: [],
    browserAnnotations: [],
    terminalContexts: [],
    fileComments: [],
    pastedTexts: [],
    pullRequestContexts: [],
    skills: [],
    mentions: [],
    selectedProvider: input.modelSelection.provider,
    selectedModel: input.modelSelection.model,
    selectedPromptEffort: input.selectedPromptEffort,
    modelSelection: input.modelSelection,
    ...(input.providerOptionsForDispatch
      ? { providerOptionsForDispatch: input.providerOptionsForDispatch }
      : {}),
    runtimeMode: input.runtimeMode,
    interactionMode: "default",
    envMode: input.envMode,
  });
}
