import {
  DEFAULT_MODEL_BY_PROVIDER,
  RuntimeMode,
  ThreadId,
  type ModelSelection,
} from "@synara/contracts";
import {
  GENERIC_CHAT_THREAD_TITLE,
  buildPromptThreadTitleFallback,
} from "@synara/shared/chatThreads";
import { getDefaultModel } from "@synara/shared/model";
import type { QueryClient } from "@tanstack/react-query";
import { gitStatusQueryOptions } from "~/lib/gitReactQuery";
import { newCommandId, newProjectId } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { setupProjectScript } from "~/projectScripts";
import {
  useComposerDraftStore,
  type BrowserAnnotationDraft,
  type ComposerAssistantSelectionAttachment,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type DraftThreadEnvMode,
} from "../../composerDraftStore";
import { formatAssistantSelectionTitleSeed } from "../../lib/assistantSelections";
import { formatBrowserAnnotationLabel } from "../../lib/browserAnnotations";
import { resolveFirstSendTarget } from "../../lib/chatFirstSend";
import { type PastedTextDraft } from "../../lib/composerPastedText";
import { formatFileCommentTitleSeed, type FileCommentDraft } from "../../lib/fileComments";
import {
  isDuplicateProjectCreateError,
  waitForRecoverableProjectForDuplicateCreate,
} from "../../lib/projectCreateRecovery";
import { formatTerminalContextLabel, type TerminalContextDraft } from "../../lib/terminalContext";
import { buildModelSelection } from "../../providerModelOptions";
import { readActiveSpaceId } from "../../spacesUiStore";
import { useStore } from "../../store";
import type { Project } from "../../types";
import { type Thread } from "../../types";
import { formatPastedTextTitleSeed } from "./queuedComposerPreview";
interface Input {
  activeThread: Thread;
  isServerThread: boolean;
  hasNativeUserMessages: boolean;
  composerImagesForSend: ComposerImageAttachment[];
  trimmedPromptForSend: string;
  composerFilesForSend: ComposerFileAttachment[];
  composerAssistantSelectionsForSend: ComposerAssistantSelectionAttachment[];
  composerBrowserAnnotationsForSend: BrowserAnnotationDraft[];
  sendableComposerTerminalContexts: TerminalContextDraft[];
  composerFileCommentsForSend: FileCommentDraft[];
  sendableComposerPastedTexts: PastedTextDraft[];
  selectedModelSelectionForSend: ModelSelection;
  selectedModelForSend: string;
  activeProject: Project;
  chatWorkspaceRoot: string | null;
  isHomeChatContainer: boolean;
  isStudioContainer: boolean;
  resolvedThreadWorktreePath: string | null;
  runtimeModeForSend: RuntimeMode;
  envModeForSend: DraftThreadEnvMode;
  resolvedThreadWorkingDirectory: string | null;
  currentActiveGitBranch: string | null;
  isContainerLandingProject: boolean;
  api: NonNullable<ReturnType<typeof readNativeApi>>;
  syncServerShellSnapshot: ReturnType<typeof useStore.getState>["syncServerShellSnapshot"];
  clearProjectDraftThreadId: ReturnType<
    typeof useComposerDraftStore.getState
  >["clearProjectDraftThreadId"];
  setDraftThreadContext: ReturnType<typeof useComposerDraftStore.getState>["setDraftThreadContext"];
  activeRootBranch: string | null;
  gitBranchSourceCwd: string | null;
  setStoreThreadError: (threadId: ThreadId, error: string | null) => void;
  queryClient: QueryClient;
}

export async function prepareChatSendWorkspace({
  activeThread,
  isServerThread,
  hasNativeUserMessages,
  composerImagesForSend,
  trimmedPromptForSend,
  composerFilesForSend,
  composerAssistantSelectionsForSend,
  composerBrowserAnnotationsForSend,
  sendableComposerTerminalContexts,
  composerFileCommentsForSend,
  sendableComposerPastedTexts,
  selectedModelSelectionForSend,
  selectedModelForSend,
  activeProject,
  chatWorkspaceRoot,
  isHomeChatContainer,
  isStudioContainer,
  resolvedThreadWorktreePath,
  runtimeModeForSend,
  envModeForSend,
  resolvedThreadWorkingDirectory,
  currentActiveGitBranch,
  isContainerLandingProject,
  api,
  syncServerShellSnapshot,
  clearProjectDraftThreadId,
  setDraftThreadContext,
  activeRootBranch,
  gitBranchSourceCwd,
  setStoreThreadError,
  queryClient,
}: Input) {
  const threadIdForSend = activeThread.id;
  const isFirstMessage = !isServerThread || !hasNativeUserMessages;
  const firstSendCreatedAt = new Date();
  let firstComposerImageNameForTitle: string | null = null;
  if (composerImagesForSend.length > 0) {
    firstComposerImageNameForTitle = composerImagesForSend[0]?.name ?? null;
  }
  let titleSeed = trimmedPromptForSend;
  if (!titleSeed) {
    if (firstComposerImageNameForTitle) {
      titleSeed = `Image: ${firstComposerImageNameForTitle}`;
    } else if (composerFilesForSend.length > 0) {
      titleSeed = `File: ${composerFilesForSend[0]?.name ?? "attachment"}`;
    } else if (composerAssistantSelectionsForSend.length > 0) {
      titleSeed = formatAssistantSelectionTitleSeed(composerAssistantSelectionsForSend.length);
    } else if (composerBrowserAnnotationsForSend.length > 0) {
      titleSeed = formatBrowserAnnotationLabel(composerBrowserAnnotationsForSend[0]!);
    } else if (sendableComposerTerminalContexts.length > 0) {
      titleSeed = formatTerminalContextLabel(sendableComposerTerminalContexts[0]!);
    } else if (composerFileCommentsForSend.length > 0) {
      titleSeed = formatFileCommentTitleSeed(composerFileCommentsForSend.length);
    } else if (sendableComposerPastedTexts.length > 0) {
      titleSeed =
        formatPastedTextTitleSeed(sendableComposerPastedTexts) ?? GENERIC_CHAT_THREAD_TITLE;
    } else {
      titleSeed = GENERIC_CHAT_THREAD_TITLE;
    }
  }
  // Keep the optimistic label short while the server asks Codex for a better summary.
  const title = buildPromptThreadTitleFallback(titleSeed);
  const currentStoreState = useStore.getState();
  // Keep an optimistically selected Space across the command/snapshot race. The server
  // validates this best-effort target and degrades genuinely stale/deleted ids to Void.
  const activeSpaceIdForSend = readActiveSpaceId();
  const firstSendDefaultModelSelection = buildModelSelection(
    selectedModelSelectionForSend.provider,
    selectedModelSelectionForSend.model ||
      selectedModelForSend ||
      getDefaultModel(selectedModelSelectionForSend.provider) ||
      DEFAULT_MODEL_BY_PROVIDER.codex,
    selectedModelSelectionForSend.options,
  );
  const firstSendTarget = resolveFirstSendTarget({
    activeProject,
    chatWorkspaceRoot,
    createdAt: firstSendCreatedAt,
    defaultModelSelection: firstSendDefaultModelSelection,
    isFirstMessage,
    isHomeChatContainer,
    isStudioContainer,
    projects: currentStoreState.projects,
    // Studio reference folders change the thread cwd without moving the chat out of
    // the managed Studio project. Home-chat folder selection keeps its project routing.
    selectedWorkspaceRoot: isHomeChatContainer ? (resolvedThreadWorktreePath ?? null) : null,
    title,
    titleSeed,
  });
  let {
    targetProjectId: targetProjectIdForSend,
    targetProjectKind: targetProjectKindForSend,
    targetProjectCwd: targetProjectCwdForSend,
    targetProjectScripts: targetProjectScriptsForSend,
    targetProjectDefaultModelSelection: targetProjectDefaultModelSelectionForSend,
  } = firstSendTarget.kind === "create-project"
    ? {
        targetProjectId: activeProject.id,
        targetProjectKind: activeProject.kind,
        targetProjectCwd: activeProject.cwd,
        targetProjectScripts: activeProject.kind === "project" ? activeProject.scripts : [],
        targetProjectDefaultModelSelection: activeProject.defaultModelSelection ?? null,
      }
    : firstSendTarget.target;
  let nextRuntimeModeForSend = runtimeModeForSend;
  let nextThreadEnvMode = envModeForSend;
  let nextThreadBranch = isStudioContainer ? null : activeThread.branch;
  let nextThreadWorktreePath = isStudioContainer ? null : activeThread.worktreePath;
  let nextThreadWorkingDirectory = isStudioContainer
    ? resolvedThreadWorkingDirectory
    : (activeThread.workingDirectory ?? null);
  let nextAssociatedWorktreePath = isStudioContainer
    ? null
    : (activeThread.associatedWorktreePath ?? null);
  let nextAssociatedWorktreeBranch = isStudioContainer
    ? null
    : (activeThread.associatedWorktreeBranch ?? null);
  let nextAssociatedWorktreeRef = isStudioContainer
    ? null
    : (activeThread.associatedWorktreeRef ?? null);
  const shouldResumeSettledLocalThread =
    isServerThread &&
    activeThread.settledAt != null &&
    nextThreadEnvMode === "local" &&
    nextThreadWorktreePath === null;
  let currentActiveGitBranchForSend = currentActiveGitBranch;

  if (isFirstMessage && isContainerLandingProject && firstSendTarget.kind !== "current") {
    if (firstSendTarget.kind === "create-project") {
      const projectId = newProjectId();
      const createdAt = firstSendCreatedAt.toISOString();
      // Managed chat rows stay global; a folder mention creates an ordinary project and
      // should inherit the Space where the first send originated. Resolved before the
      // `try`: a value block inside a try body makes React Compiler bail out on the whole
      // component.
      const createProjectSpaceFields =
        firstSendTarget.creation.kind === "project" ? { spaceId: activeSpaceIdForSend } : {};
      try {
        await api.orchestration.dispatchCommand({
          type: "project.create",
          commandId: newCommandId(),
          projectId,
          kind: firstSendTarget.creation.kind,
          title: firstSendTarget.creation.title,
          workspaceRoot: firstSendTarget.creation.workspaceRoot,
          createWorkspaceRootIfMissing: firstSendTarget.creation.createWorkspaceRootIfMissing,
          defaultModelSelection: firstSendTarget.creation.defaultModelSelection,
          ...createProjectSpaceFields,
          createdAt,
        });
        targetProjectIdForSend = projectId;
        targetProjectKindForSend = firstSendTarget.creation.kind;
        targetProjectCwdForSend = firstSendTarget.creation.workspaceRoot;
        targetProjectScriptsForSend = [];
        targetProjectDefaultModelSelectionForSend = firstSendTarget.creation.defaultModelSelection;
      } catch (error) {
        const description =
          error instanceof Error ? error.message : "Failed to create the selected project.";
        if (!isDuplicateProjectCreateError(description)) {
          throw error;
        }

        // If the server already knows this workspace root, reuse that project and continue.
        const { snapshot, project: recoveredProject } =
          await waitForRecoverableProjectForDuplicateCreate({
            message: description,
            workspaceRoot: firstSendTarget.creation.workspaceRoot,
            loadSnapshot: () => api.orchestration.getShellSnapshot().catch(() => null),
          });
        if (!snapshot || !recoveredProject) {
          throw error;
        }

        syncServerShellSnapshot(snapshot);
        targetProjectIdForSend = recoveredProject.id;
        targetProjectKindForSend = recoveredProject.kind ?? firstSendTarget.creation.kind;
        targetProjectCwdForSend = recoveredProject.workspaceRoot;
        targetProjectScriptsForSend =
          (recoveredProject.kind ?? firstSendTarget.creation.kind) === "project"
            ? [...recoveredProject.scripts]
            : [];
        targetProjectDefaultModelSelectionForSend =
          recoveredProject.defaultModelSelection ?? firstSendTarget.creation.defaultModelSelection;
      }
    }

    clearProjectDraftThreadId(targetProjectIdForSend);
    setDraftThreadContext(threadIdForSend, {
      projectId: targetProjectIdForSend,
      envMode: "local",
      worktreePath: null,
      workingDirectory: null,
      branch: null,
    });
    nextThreadEnvMode = "local";
    nextThreadBranch = null;
    nextThreadWorktreePath = null;
    nextThreadWorkingDirectory = null;
    nextAssociatedWorktreePath = null;
    nextAssociatedWorktreeBranch = null;
    nextAssociatedWorktreeRef = null;
  }

  // The branch query can finish just after the user chooses New worktree. Use the
  // resolved active branch at send time instead of rejecting an otherwise valid fast send.
  if (
    isFirstMessage &&
    nextThreadEnvMode === "worktree" &&
    !nextThreadWorktreePath &&
    !nextThreadBranch
  ) {
    nextThreadBranch = activeRootBranch ?? null;
  }

  // A settled local thread keeps its historical branch until the user resumes it, so the
  // composer can explain the branch change. Refresh Git status before sending because the
  // cached branch query may still be loading or may lag behind an out-of-band checkout.
  if (shouldResumeSettledLocalThread) {
    if (!gitBranchSourceCwd) {
      setStoreThreadError(threadIdForSend, "Unable to determine the current branch.");
      return false;
    }

    try {
      const gitStatus = await queryClient.fetchQuery({
        ...gitStatusQueryOptions(gitBranchSourceCwd),
        staleTime: 0,
      });
      currentActiveGitBranchForSend = gitStatus.branch;
    } catch {
      setStoreThreadError(
        threadIdForSend,
        "Unable to determine the current branch. Try again before sending.",
      );
      return false;
    }

    if (currentActiveGitBranchForSend !== null) {
      nextThreadBranch = currentActiveGitBranchForSend;
    }
  }

  const baseBranchForWorktree =
    isFirstMessage && nextThreadEnvMode === "worktree" && !nextThreadWorktreePath
      ? nextThreadBranch
      : null;

  // In worktree mode, require an explicit base branch so we don't silently
  // fall back to local execution when branch selection is missing.
  const shouldCreateWorktree =
    isFirstMessage && nextThreadEnvMode === "worktree" && !nextThreadWorktreePath;
  if (shouldCreateWorktree && !nextThreadBranch) {
    setStoreThreadError(
      threadIdForSend,
      "Select a base branch before sending in New worktree mode.",
    );
    return false;
  }

  const setupScriptForWorktree = baseBranchForWorktree
    ? setupProjectScript(targetProjectScriptsForSend)
    : null;
  const worktreeSetupScriptName = setupScriptForWorktree?.name ?? null;
  // Branching off the checkout's current branch also carries its uncommitted
  // changes into the worktree, which the setup card surfaces as its own step.
  const worktreeCopiesLocalChanges =
    Boolean(baseBranchForWorktree) && baseBranchForWorktree === activeRootBranch;
  return {
    threadIdForSend,
    title,
    targetProjectIdForSend,
    targetProjectKindForSend,
    targetProjectCwdForSend,
    targetProjectDefaultModelSelectionForSend,
    nextRuntimeModeForSend,
    nextThreadEnvMode,
    nextThreadBranch,
    nextThreadWorktreePath,
    nextThreadWorkingDirectory,
    nextAssociatedWorktreePath,
    nextAssociatedWorktreeBranch,
    nextAssociatedWorktreeRef,
    shouldResumeSettledLocalThread,
    currentActiveGitBranchForSend,
    baseBranchForWorktree,
    setupScriptForWorktree,
    worktreeSetupScriptName,
    worktreeCopiesLocalChanges,
  };
}
