// FILE: draftThreadDispatch.ts
// Purpose: Sends a local draft thread's composer prompt as the first queued turn —
//          promotes the draft to a durable thread when needed. Shared by the Tasks view
//          (delegating a to-do) and Kanban (dropping a Draft card on In Progress).
// Layer: Web orchestration helper
// Exports: dispatchDraftThread, DraftThreadDispatchHooks, DraftThreadDispatchResult,
//          DraftThreadOpenReason

import type {
  AssistantDeliveryMode,
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ProviderKind,
  ProviderStartOptions,
  ThreadEnvironmentMode,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@synara/contracts";
import type { ComposerFileAttachment } from "../composerDraftDomain";
import { revokeObjectPreviewUrl } from "../composerDraftAttachments";
import { hasActiveComposerSend } from "./composerSendOwnership";
import { clearPendingTurnDispatch, markPendingTurnDispatch } from "../pendingTurnDispatch";
import {
  appendPastedTextsToPrompt,
  filterPastedTextsWithText,
  pastedTextTitle,
} from "./composerPastedText";
import { buildPromptThreadTitleFallback } from "@synara/shared/chatThreads";
import { isPendingThreadWorktree } from "@synara/shared/threadEnvironment";
import type { ProviderInstanceOption } from "../appSettings";
import { composerDraftHasAttachments, composerDraftsMatchForCleanup } from "../composerDraftDomain";
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
  findPendingBlobComposerAttachments,
  hydratePendingBlobComposerAttachments,
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
import { newCommandId, newMessageId, randomUUID } from "./utils";

/** Why a draft must fall back to the canonical chat composer instead of dispatching here. */
export type DraftThreadOpenReason = "empty" | "worktree-pending";

export type DraftThreadDispatchResult =
  /** The drafted prompt is on its way; runtime events report the thread's progress. */
  | { kind: "dispatched"; warning?: string | undefined; deferred?: true | undefined }
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
    providerInstanceId: ProviderInstanceId;
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
  providerInstances?: ReadonlyArray<DraftDispatchProviderInstance> | undefined;
  hooks?: DraftThreadDispatchHooks | undefined;
  sendAsGoal?: boolean;
  promptAsFile?: boolean;
}

export type DraftDispatchProviderInstance = Pick<ProviderInstanceOption, "instanceId" | "provider">;

export interface DraftThreadDispatchTarget {
  readonly modelSelection: ModelSelection;
  readonly provider: ProviderKind;
  readonly instanceId: ProviderInstanceId;
}

function resolveProviderForInstanceId(
  providerInstances: ReadonlyArray<DraftDispatchProviderInstance> | undefined,
  instanceId: ProviderInstanceId,
): ProviderKind | null {
  return (
    providerInstances?.find((instance) => instance.instanceId === instanceId)?.provider ?? null
  );
}

export function resolveDraftThreadDispatchTarget(input: {
  threadId: ThreadId;
  projectId: ProjectId;
  thread: SidebarThreadSummary | null;
  defaultProvider: ProviderKind;
  providerInstances?: ReadonlyArray<DraftDispatchProviderInstance> | undefined;
}): DraftThreadDispatchTarget {
  const composerStore = useComposerDraftStore.getState();
  const draftComposerState = composerStore.draftsByThreadId[input.threadId] ?? null;
  const project =
    useStore.getState().projects.find((candidate) => candidate.id === input.projectId) ?? null;
  const resolveConfiguredProvider = (instanceId: ProviderInstanceId) =>
    draftComposerState?.modelSelectionByProvider[instanceId]?.provider ??
    resolveProviderForInstanceId(input.providerInstances, instanceId);
  const modelSelection = resolvePreferredComposerModelSelection({
    draft: draftComposerState,
    threadModelSelection: input.thread?.modelSelection ?? null,
    projectModelSelection: project?.defaultModelSelection ?? null,
    defaultProvider: input.defaultProvider,
    resolveProviderForInstanceId: resolveConfiguredProvider,
  });
  return {
    modelSelection,
    provider: modelSelection.provider,
    instanceId: modelSelection.instanceId ?? modelSelection.provider,
  };
}

export const DRAFT_PROMPT_FILE_THRESHOLD_CHARS = 1_000;

/**
 * Converts an oversized outgoing prompt into a managed file attachment. The
 * sent message becomes a "read this file" pointer; the provider's attachment
 * projection supplies the resolved on-disk path. Returns null below the
 * threshold or when the attachment cap would be exceeded — in that case the
 * text is sent inline so nothing is lost.
 */
function buildDraftPromptFileAttachment(input: {
  messageId: string;
  text: string;
  existingAttachmentCount: number;
}): { attachment: ComposerFileAttachment; reference: string } | null {
  if (input.text.length <= DRAFT_PROMPT_FILE_THRESHOLD_CHARS) {
    return null;
  }
  if (input.existingAttachmentCount >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
    return null;
  }
  const name = `synara-prompt-${input.messageId}.md`;
  const file = new File([input.text], name, { type: "text/markdown" });
  return {
    attachment: {
      type: "file",
      id: randomUUID(),
      name,
      mimeType: "text/markdown",
      sizeBytes: file.size,
      file,
    },
    reference: `Read this file: ${name}`,
  };
}

// Racing callers (a double click on Start, a retry while the first send is still
// in flight) must not queue two turns for the same thread — the server accepts
// duplicate thread.turn.start commands while the session is still starting. Same
// pattern as threadCreatePromotion's inFlightThreadCreateById.
const inFlightDispatchByThreadId = new Map<ThreadId, Promise<DraftThreadDispatchResult>>();

export function waitForDraftThreadDispatchToSettle(
  threadId: ThreadId,
): Promise<DraftThreadDispatchResult | null> {
  return inFlightDispatchByThreadId.get(threadId)?.catch(() => null) ?? Promise.resolve(null);
}

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
  if (hasActiveComposerSend(input.threadId)) {
    return Promise.resolve({ kind: "dispatched", deferred: true });
  }
  const dispatchPromise = Promise.resolve()
    .then(() => dispatchDraftThreadOnce(input))
    .finally(() => {
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
    (draftComposerState === null ||
      (!composerDraftHasAttachments(draftComposerState) &&
        !draftComposerState.pastedTexts.some((pasted) => pasted.text.trim().length > 0)))
  ) {
    return { kind: "open-thread", reason: "empty" };
  }

  const appState = useStore.getState();
  const project = appState.projects.find((candidate) => candidate.id === projectId) ?? null;
  const existingThread = thread ? getThreadFromState(appState, threadId) : null;
  const { modelSelection } = resolveDraftThreadDispatchTarget(input);
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
  const liveComposerImages = draftComposerState?.images ?? [];
  const pendingImages = findPendingBlobComposerAttachments({
    persistedAttachments: draftComposerState?.persistedAttachments ?? [],
    images: liveComposerImages,
  });
  const hydratedPendingImages = await hydratePendingBlobComposerAttachments(pendingImages);
  // Headless hydration only needs each File for upload, never its preview.
  // These URLs do not belong to the composer store and its cleanup cannot
  // release them, including when dispatch is refused.
  for (const image of hydratedPendingImages) revokeObjectPreviewUrl(image.previewUrl);
  if (hydratedPendingImages.length !== pendingImages.length) {
    return {
      kind: "error",
      message:
        "Could not restore saved images. Open the chat to retry or remove them before sending.",
    };
  }
  const composerImages = [...liveComposerImages, ...hydratedPendingImages];

  const composerFiles = draftComposerState?.files ?? [];
  const composerAssistantSelections = draftComposerState?.assistantSelections ?? [];
  const composerBrowserAnnotations = draftComposerState?.browserAnnotations ?? [];
  const composerFileComments = draftComposerState?.fileComments ?? [];
  const sendablePastedTexts = filterPastedTextsWithText(draftComposerState?.pastedTexts ?? []);
  const sendableTerminalContexts = filterTerminalContextsWithText(
    draftComposerState?.terminalContexts ?? [],
  );
  const titleSeed =
    prompt ||
    (sendablePastedTexts[0] ? pastedTextTitle(sendablePastedTexts[0].text) : "") ||
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
    appendPastedTextsToPrompt(
      appendFileCommentsToPrompt(
        appendTerminalContextsToPrompt(
          appendAssistantSelectionsToPrompt(draftPrompt, composerAssistantSelections),
          sendableTerminalContexts,
        ),
        composerFileComments,
      ),
      sendablePastedTexts,
    ),
    composerBrowserAnnotations,
    messageId,
  );
  const fullOutgoingMessageText = formatOutgoingComposerPrompt({
    provider: modelSelection.provider,
    model: modelSelection.model,
    effort: resolvePromptEffortFromModelSelection(modelSelection),
    text: messageText || (composerImages.length > 0 ? IMAGE_ONLY_BOOTSTRAP_PROMPT : ""),
  });
  // Skill/mention filters must see the full text: after file conversion the sent
  // text is only a pointer and no longer mentions any references.
  const mentionedSkills = filterPromptSkillReferences(
    fullOutgoingMessageText,
    skills,
    modelSelection.provider,
  );
  const mentionedMentions = filterPromptProviderMentionReferences(
    fullOutgoingMessageText,
    mentions,
  );
  const promptFile = input.promptAsFile
    ? buildDraftPromptFileAttachment({
        messageId,
        text: fullOutgoingMessageText,
        existingAttachmentCount:
          composerImages.length + composerFiles.length + composerAssistantSelections.length,
      })
    : null;
  const outgoingMessageText = promptFile ? promptFile.reference : fullOutgoingMessageText;
  const filesForSend = promptFile ? [...composerFiles, promptFile.attachment] : composerFiles;
  const turnAttachmentsPromise = stageUploadComposerAttachments({
    threadId,
    images: composerImages,
    files: filesForSend,
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
    providerInstanceId: modelSelection.instanceId ?? modelSelection.provider,
    baselineTurnId: thread?.latestTurn?.turnId ?? null,
    startedAtMs,
  });

  let goalWarning: string | undefined;
  markPendingTurnDispatch(threadId);
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
        resolveProviderForInstanceId: (instanceId) =>
          resolveProviderForInstanceId(input.providerInstances, instanceId),
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
        clearPendingTurnDispatch(threadId);
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

    if (input.sendAsGoal && (prompt.length > 0 || sendablePastedTexts.length > 0)) {
      // The objective is the full authored text — prompt plus collapsed big
      // pastes. Oversized goals are materialized to a per-thread file
      // server-side and persisted as a "read this file" reference, so no
      // client-side truncation applies.
      const goal = [prompt, ...sendablePastedTexts.map((pasted) => pasted.text)]
        .filter((part) => part.trim().length > 0)
        .join("\n\n");
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId,
          goal,
          goalStartBehavior: "defer",
        });
      } catch (error) {
        goalWarning = `Could not save the goal; the task was started anyway. ${
          error instanceof Error ? error.message : "Unknown error."
        }`;
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
    if (!isRequestOutcomeUnknown(error)) clearPendingTurnDispatch(threadId);
    return {
      kind: "error",
      message: error instanceof Error ? error.message : "Could not send the drafted prompt.",
      ...(isRequestOutcomeUnknown(error) ? { outcomeUnknown: true } : {}),
    };
  }

  // Clear the consumed draft only while we still own it. An open composer may
  // have received new text or attachments while the dispatch reply was pending.
  const currentStore = useComposerDraftStore.getState();
  if (composerDraftsMatchForCleanup(currentStore.draftsByThreadId[threadId], draftComposerState)) {
    currentStore.clearComposerContent(threadId);
  }
  markPendingTurnDispatch(threadId);
  return { kind: "dispatched", ...(goalWarning ? { warning: goalWarning } : {}) };
}
