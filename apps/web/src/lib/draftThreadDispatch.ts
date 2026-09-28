// FILE: draftThreadDispatch.ts
// Purpose: Sends a local draft thread's composer prompt as the first queued turn —
//          promotes the draft to a durable thread when needed. Shared by the Tasks view
//          (delegating a to-do) and Kanban (dropping a Draft card on In Progress).
// Layer: Web orchestration helper
// Exports: dispatchDraftThread, DraftThreadDispatchHooks, DraftThreadDispatchResult,
//          DraftThreadOpenReason

import type {
  AssistantDeliveryMode,
  ProjectId,
  ProviderKind,
  ProviderStartOptions,
  ThreadEnvironmentMode,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import { buildPromptThreadTitleFallback } from "@synara/shared/chatThreads";
import { isPendingThreadWorktree } from "@synara/shared/threadEnvironment";
import { composerDraftHasAttachments } from "../composerDraftDomain";
import {
  resolvePreferredComposerModelSelection,
  useComposerDraftStore,
} from "../composerDraftStore";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { getThreadFromState } from "../threadDerivation";
import type { SidebarThreadSummary } from "../types";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE } from "../types";
import { appendAssistantSelectionsToPrompt } from "./assistantSelections";
import {
  appendBrowserAnnotationsToPrompt,
  formatBrowserAnnotationLabel,
} from "./browserAnnotations";
import {
  stageUploadComposerAttachments,
  formatOutgoingComposerPrompt,
  resolvePromptEffortFromModelSelection,
} from "./composerSend";
import { appendFileCommentsToPrompt, formatFileCommentTitleSeed } from "./fileComments";
import {
  filterPromptProviderMentionReferences,
  filterPromptSkillReferences,
} from "./composerMentions";
import {
  appendTerminalContextsToPrompt,
  filterTerminalContextsWithText,
  IMAGE_ONLY_BOOTSTRAP_PROMPT,
} from "./terminalContext";
import { resolveTerminalThreadCreationState } from "./threadBootstrap";
import { promoteThreadCreate } from "./threadCreatePromotion";
import { isRequestOutcomeUnknown } from "./requestOutcome";
import { newCommandId, newMessageId } from "./utils";

/** Why a draft must fall back to the canonical chat composer instead of dispatching here. */
export type DraftThreadOpenReason = "empty" | "worktree-pending";

export type DraftThreadDispatchResult =
  /** The drafted prompt is on its way; runtime events report the thread's progress. */
  | { kind: "dispatched" }
  /** This surface cannot dispatch the draft faithfully — open the chat instead. */
  | { kind: "open-thread"; reason: DraftThreadOpenReason }
  | { kind: "unavailable" }
  /**
   * `outcomeUnknown`: the request died with the connection (timeout, reconnect), so the
   * server may still have started the turn; callers must not treat it as refused.
   */
  | { kind: "error"; message: string; outcomeUnknown?: boolean };

/** Surface-specific side effects around a dispatch, such as Kanban's optimistic card move. */
export interface DraftThreadDispatchHooks {
  /** Runs right before the first round-trip; `startedAtMs` also stamps the commands. */
  onDispatchStart?: (start: {
    title: string;
    provider: ProviderKind;
    /** latestTurn.turnId before this dispatch; null for a thread without turns. */
    baselineTurnId: TurnId | null;
    startedAtMs: number;
  }) => void;
  /** Runs when a started dispatch did not go through. */
  onDispatchAbandoned?: () => void;
  /** Retitle a chat-kind project after its draft thread is promoted. */
  renameChatProject?: boolean;
}

interface DraftThreadDispatchInput {
  threadId: ThreadId;
  projectId: ProjectId;
  /** Backing summary; null for local-only draft threads not yet promoted. */
  thread: SidebarThreadSummary | null;
  defaultProvider: ProviderKind;
  assistantDeliveryMode: AssistantDeliveryMode;
  providerOptions?: ProviderStartOptions | undefined;
  hooks?: DraftThreadDispatchHooks | undefined;
}

// Racing callers (a double click on Start, a retry while the first send is still
// in flight) must not queue two turns for the same thread — the server accepts
// duplicate thread.turn.start commands while the session is still starting. Same
// pattern as threadCreatePromotion's inFlightThreadCreateById.
const inFlightDispatchByThreadId = new Map<ThreadId, Promise<DraftThreadDispatchResult>>();

/**
 * Promote (when needed) and dispatch a draft thread's composer prompt as a queued
 * turn. Reads the live composer draft by id, so callers only pass identity +
 * dispatch preferences. Concurrent calls for the same thread coalesce onto the
 * first dispatch.
 */
export function dispatchDraftThread(
  input: DraftThreadDispatchInput,
): Promise<DraftThreadDispatchResult> {
  const existing = inFlightDispatchByThreadId.get(input.threadId);
  if (existing) {
    return existing;
  }
  const dispatchPromise = dispatchDraftThreadOnce(input).finally(() => {
    inFlightDispatchByThreadId.delete(input.threadId);
  });
  inFlightDispatchByThreadId.set(input.threadId, dispatchPromise);
  return dispatchPromise;
}

async function dispatchDraftThreadOnce(
  input: DraftThreadDispatchInput,
): Promise<DraftThreadDispatchResult> {
  const { threadId, projectId, thread } = input;
  const api = readNativeApi();
  if (!api) {
    return { kind: "unavailable" };
  }

  // Re-read the composer at send time: edits made in an open chat must win over
  // whatever the caller last saw, and a stale prompt must never be dispatched.
  const composerStore = useComposerDraftStore.getState();
  const draftComposerState = composerStore.draftsByThreadId[threadId] ?? null;
  const draftPrompt = draftComposerState?.prompt ?? "";
  const prompt = draftPrompt.trim();
  if (
    prompt.length === 0 &&
    (draftComposerState === null || !composerDraftHasAttachments(draftComposerState))
  ) {
    return { kind: "open-thread", reason: "empty" };
  }

  const appState = useStore.getState();
  const project = appState.projects.find((candidate) => candidate.id === projectId) ?? null;
  const existingThread = thread ? getThreadFromState(appState, threadId) : null;
  const modelSelection = resolvePreferredComposerModelSelection({
    draft: draftComposerState,
    threadModelSelection: thread?.modelSelection ?? null,
    projectModelSelection: project?.defaultModelSelection ?? null,
    defaultProvider: input.defaultProvider,
  });
  const draftThread = composerStore.getDraftThread(threadId);
  // Worktree creation is owned by the full chat composer path. This helper stays a
  // control surface and opens chat when a draft still needs that preflight.
  const dispatchEnvironment = {
    envMode: (thread?.envMode ??
      existingThread?.envMode ??
      draftThread?.envMode ??
      null) as ThreadEnvironmentMode | null,
    worktreePath: thread?.worktreePath ?? existingThread?.worktreePath ?? draftThread?.worktreePath,
  };
  if (isPendingThreadWorktree(dispatchEnvironment)) {
    return { kind: "open-thread", reason: "worktree-pending" };
  }
  const runtimeMode =
    draftComposerState?.runtimeMode ??
    existingThread?.runtimeMode ??
    draftThread?.runtimeMode ??
    DEFAULT_RUNTIME_MODE;
  const interactionMode =
    draftComposerState?.interactionMode ??
    existingThread?.interactionMode ??
    thread?.interactionMode ??
    draftThread?.interactionMode ??
    DEFAULT_INTERACTION_MODE;
  const skills = draftComposerState?.skills ?? [];
  const mentions = draftComposerState?.mentions ?? [];
  const composerImages = draftComposerState?.images ?? [];
  const composerFiles = draftComposerState?.files ?? [];
  const composerAssistantSelections = draftComposerState?.assistantSelections ?? [];
  const composerBrowserAnnotations = draftComposerState?.browserAnnotations ?? [];
  const composerFileComments = draftComposerState?.fileComments ?? [];
  const sendableTerminalContexts = filterTerminalContextsWithText(
    draftComposerState?.terminalContexts ?? [],
  );
  const titleSeed =
    prompt ||
    (composerImages[0] ? `Image: ${composerImages[0].name}` : "") ||
    (composerFiles[0] ? `File: ${composerFiles[0].name}` : "") ||
    (composerAssistantSelections.length > 0 ? "Referenced assistant selection" : "") ||
    (composerBrowserAnnotations[0]
      ? formatBrowserAnnotationLabel(composerBrowserAnnotations[0])
      : "") ||
    (sendableTerminalContexts.length > 0 ? "Attached terminal context" : "") ||
    (composerFileComments.length > 0
      ? formatFileCommentTitleSeed(composerFileComments.length)
      : "") ||
    "New task";
  const fallbackTitle = buildPromptThreadTitleFallback(titleSeed);
  const messageId = newMessageId();
  // Browser annotations serialize outermost so display extraction can validate
  // their message-bound transport before unwrapping the remaining context blocks.
  const messageText = appendBrowserAnnotationsToPrompt(
    appendFileCommentsToPrompt(
      appendTerminalContextsToPrompt(
        appendAssistantSelectionsToPrompt(draftPrompt, composerAssistantSelections),
        sendableTerminalContexts,
      ),
      composerFileComments,
    ),
    composerBrowserAnnotations,
    messageId,
  );
  const outgoingMessageText = formatOutgoingComposerPrompt({
    provider: modelSelection.provider,
    model: modelSelection.model,
    effort: resolvePromptEffortFromModelSelection(modelSelection),
    text: messageText || (composerImages.length > 0 ? IMAGE_ONLY_BOOTSTRAP_PROMPT : ""),
  });
  const mentionedSkills = filterPromptSkillReferences(
    outgoingMessageText,
    skills,
    modelSelection.provider,
  );
  const mentionedMentions = filterPromptProviderMentionReferences(outgoingMessageText, mentions);
  const turnAttachmentsPromise = stageUploadComposerAttachments({
    threadId,
    images: composerImages,
    files: composerFiles,
    assistantSelections: composerAssistantSelections,
  });
  // The same instant feeds both the command timestamps and onDispatchStart: a
  // server-side failure stamps the session with this createdAt, and Kanban's
  // failure check compares it against startedAtMs with >=.
  const startedAtMs = Date.now();
  const createdAt = new Date(startedAtMs).toISOString();
  const { hooks } = input;
  hooks?.onDispatchStart?.({
    title: thread?.title ?? fallbackTitle,
    provider: modelSelection.provider,
    baselineTurnId: thread?.latestTurn?.turnId ?? null,
    startedAtMs,
  });

  try {
    if (thread === null) {
      // Local-only draft thread: create the durable thread first, reusing the same
      // workspace resolution the terminal-first promotion path uses.
      const creationState = resolveTerminalThreadCreationState({
        activeDraftThread: null,
        activeThread: null,
        defaultProvider: input.defaultProvider,
        draftComposerState,
        draftThread,
        options: undefined,
        projectDefaultModelSelection: project?.defaultModelSelection ?? null,
        projectId,
      });
      const promotion = await promoteThreadCreate(
        {
          type: "thread.create",
          commandId: newCommandId(),
          threadId,
          projectId,
          title: fallbackTitle,
          modelSelection,
          runtimeMode,
          interactionMode,
          envMode: creationState.envMode,
          branch: creationState.branch,
          worktreePath: creationState.worktreePath,
          workingDirectory: creationState.workingDirectory,
          lastKnownPr: creationState.lastKnownPr,
          createdAt: draftThread?.createdAt ?? createdAt,
        },
        api,
      );
      if (promotion === "unavailable") {
        await turnAttachmentsPromise.then(
          (staged) => staged.cleanup(),
          () => undefined,
        );
        hooks?.onDispatchAbandoned?.();
        return { kind: "unavailable" };
      }
      if (hooks?.renameChatProject && project?.kind === "chat") {
        await api.orchestration.dispatchCommand({
          type: "project.meta.update",
          commandId: newCommandId(),
          projectId,
          title: fallbackTitle,
        });
      }
    }

    const stagedTurnAttachments = await turnAttachmentsPromise;
    await stagedTurnAttachments.runWithDispatch((turnAttachments) =>
      api.orchestration.dispatchCommand({
        type: "thread.turn.start",
        commandId: newCommandId(),
        threadId,
        message: {
          messageId,
          role: "user",
          text: outgoingMessageText,
          attachments: turnAttachments,
          ...(mentionedSkills.length > 0 ? { skills: mentionedSkills } : {}),
          ...(mentionedMentions.length > 0 ? { mentions: mentionedMentions } : {}),
        },
        modelSelection,
        ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
        assistantDeliveryMode: input.assistantDeliveryMode,
        dispatchMode: "queue",
        runtimeMode,
        interactionMode,
        createdAt,
      }),
    );
  } catch (error) {
    await turnAttachmentsPromise.then(
      (staged) => staged.cleanup(),
      () => undefined,
    );
    hooks?.onDispatchAbandoned?.();
    return {
      kind: "error",
      message: error instanceof Error ? error.message : "Could not send the drafted prompt.",
      ...(isRequestOutcomeUnknown(error) ? { outcomeUnknown: true } : {}),
    };
  }

  // The prompt was consumed by the dispatched turn; an open composer for this
  // thread should not keep offering it.
  useComposerDraftStore.getState().clearComposerContent(threadId);
  return { kind: "dispatched" };
}
