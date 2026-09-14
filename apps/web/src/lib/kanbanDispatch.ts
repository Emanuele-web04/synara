// FILE: kanbanDispatch.ts
// Purpose: Sends a kanban Draft card to In Progress — promotes local draft threads when
//          needed and dispatches the drafted prompt as a queued turn.
// Layer: Web orchestration helper
// Exports: dispatchKanbanDraftCard, dispatchKanbanDraftThread, KanbanDraftDispatchResult

import type {
  AssistantDeliveryMode,
  ProjectId,
  ProviderKind,
  ProviderStartOptions,
  ThreadEnvironmentMode,
  ThreadId,
} from "@synara/contracts";
import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@synara/contracts";
import { buildPromptThreadTitleFallback } from "@synara/shared/chatThreads";
import { isPendingThreadWorktree } from "@synara/shared/threadEnvironment";
import {
  buildKanbanComposerDraftSnapshot,
  resolveKanbanDraftOpenThreadReason,
  resolveDraftDropAction,
  type KanbanCard,
  type KanbanDraftOpenThreadReason,
} from "../components/kanban/kanban.logic";
import {
  resolvePreferredComposerModelSelection,
  useComposerDraftStore,
} from "../composerDraftStore";
import { useKanbanUiStore } from "../kanbanUiStore";
import { readNativeApi } from "../nativeApi";
import type { ComposerFileAttachment } from "../composerDraftDomain";
import {
  beginTurnDispatchOwnership,
  clearPendingTurnDispatch,
  endTurnDispatchOwnership,
  hasTurnDispatchOwnership,
  markPendingTurnDispatch,
} from "../pendingTurnDispatch";
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
  formatOutgoingComposerPrompt,
  hydratePendingBlobComposerAttachments,
  resolvePromptEffortFromModelSelection,
} from "./composerSend";
import { appendFileCommentsToPrompt, formatFileCommentTitleSeed } from "./fileComments";
import {
  appendPastedTextsToPrompt,
  filterPastedTextsWithText,
  pastedTextTitle,
} from "./composerPastedText";
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
import { newCommandId, newMessageId, randomUUID } from "./utils";

export type KanbanDraftDispatchResult =
  /** The drafted prompt is on its way; runtime events move the card to In Progress. */
  | { kind: "dispatched"; warning?: string | undefined; deferred?: true | undefined }
  /** The board cannot dispatch this card faithfully — open the chat instead. */
  | { kind: "open-thread"; reason: KanbanDraftOpenThreadReason }
  | { kind: "unavailable" }
  | { kind: "error"; message: string };

export function kanbanDispatchFailureToast(
  result: Exclude<KanbanDraftDispatchResult, { kind: "dispatched" }>,
  errorTitle: string,
): { type: "info" | "error"; title: string; description: string } {
  if (result.kind === "open-thread") {
    return {
      type: "info",
      title: "Finish this draft in the chat",
      description:
        result.reason === "empty"
          ? "Nothing to send yet. Write the prompt in the composer."
          : result.reason === "worktree-pending"
            ? "Open the chat to create the worktree with the normal send flow."
            : "Open the chat to continue this task.",
    };
  }
  if (result.kind === "unavailable") {
    return {
      type: "error",
      title: "Not connected",
      description: "Reconnect to the server before sending drafts.",
    };
  }
  return { type: "error", title: errorTitle, description: result.message };
}

export async function dispatchKanbanDraftCard(input: {
  card: KanbanCard;
  defaultProvider: ProviderKind;
  assistantDeliveryMode: AssistantDeliveryMode;
  providerOptions?: ProviderStartOptions | undefined;
}): Promise<KanbanDraftDispatchResult> {
  const { card } = input;
  if (resolveDraftDropAction(card) !== "dispatch") {
    return {
      kind: "open-thread",
      reason: resolveKanbanDraftOpenThreadReason(card) ?? "not-draft",
    };
  }
  return dispatchKanbanDraftThread({
    threadId: card.threadId,
    projectId: card.projectId,
    thread: card.thread,
    defaultProvider: input.defaultProvider,
    assistantDeliveryMode: input.assistantDeliveryMode,
    providerOptions: input.providerOptions,
  });
}

/** Right-click "Send as goal" for a dispatchable draft card. */
export async function dispatchKanbanDraftCardAsGoal(input: {
  card: KanbanCard;
  defaultProvider: ProviderKind;
  assistantDeliveryMode: AssistantDeliveryMode;
  providerOptions?: ProviderStartOptions | undefined;
}): Promise<KanbanDraftDispatchResult> {
  const { card } = input;
  if (resolveDraftDropAction(card) !== "dispatch") {
    return {
      kind: "open-thread",
      reason: resolveKanbanDraftOpenThreadReason(card) ?? "not-draft",
    };
  }
  return dispatchKanbanDraftThreadAsGoal({
    threadId: card.threadId,
    projectId: card.projectId,
    thread: card.thread,
    defaultProvider: input.defaultProvider,
    assistantDeliveryMode: input.assistantDeliveryMode,
    providerOptions: input.providerOptions,
  });
}

interface KanbanDraftDispatchInput {
  threadId: ThreadId;
  projectId: ProjectId;
  /** Backing summary; null for local-only draft threads not yet promoted. */
  thread: SidebarThreadSummary | null;
  defaultProvider: ProviderKind;
  assistantDeliveryMode: AssistantDeliveryMode;
  providerOptions?: ProviderStartOptions | undefined;
}

/**
 * Prompts longer than this ride to the provider as a managed file attachment
 * (Codex-style large-input handling): the sent message becomes a short "read
 * this file" pointer and the provider resolves the on-disk path from the
 * attachment projection. Keeps transcripts compact and sidesteps oversized
 * inline payloads. Attachments stay inline when the turn is already at the
 * attachment cap — content delivery beats the file form.
 */
export const KANBAN_PROMPT_FILE_THRESHOLD_CHARS = 1_000;

/**
 * Converts an oversized outgoing prompt into a managed file attachment. The
 * sent message becomes a "read this file" pointer; the provider's attachment
 * projection supplies the resolved on-disk path. Returns null below the
 * threshold or when the attachment cap would be exceeded — in that case the
 * text is sent inline so nothing is lost.
 */
function buildKanbanPromptFileAttachment(input: {
  messageId: string;
  text: string;
  existingAttachmentCount: number;
}): { attachment: ComposerFileAttachment; reference: string } | null {
  if (input.text.length <= KANBAN_PROMPT_FILE_THRESHOLD_CHARS) {
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

// Racing callers (a re-drop before the board re-derives, drag + send-now, or a
// drag racing a right-click "Send as goal") must not queue two turns for the
// same thread — the server accepts duplicate thread.turn.start commands while
// the session is still starting. Same pattern as threadCreatePromotion's
// inFlightThreadCreateById. The guard is keyed by threadId alone so a
// concurrent dispatch and "Send as goal" coalesce onto the first turn instead
// of racing past each other on mode-specific keys.
const inFlightDispatchByThreadId = new Map<string, Promise<KanbanDraftDispatchResult>>();

function dispatchKanbanDraftThreadInternal(
  input: KanbanDraftDispatchInput,
  mode: "dispatch" | "goal",
): Promise<KanbanDraftDispatchResult> {
  const existing = inFlightDispatchByThreadId.get(input.threadId);
  if (existing) {
    return existing;
  }
  if (hasTurnDispatchOwnership(input.threadId)) {
    // A chat send for this thread is already in flight — defer to it instead
    // of queueing a second turn. Marked deferred so callers never report this
    // as their own dispatch: the chat send owns the turn (and its failure).
    // The probe is the short-lived ownership signal, not the watchdog marker:
    // the marker stays armed after the turn RPC settles (stream-ack coverage),
    // which would otherwise block valid follow-up drops for its 30s lifetime.
    const raced = inFlightDispatchByThreadId.get(input.threadId);
    if (raced) {
      return raced;
    }
    return Promise.resolve<KanbanDraftDispatchResult>({ kind: "dispatched", deferred: true });
  }
  const dispatchPromise = dispatchKanbanDraftThreadOnce(input, mode).finally(() => {
    inFlightDispatchByThreadId.delete(input.threadId);
  });
  inFlightDispatchByThreadId.set(input.threadId, dispatchPromise);
  return dispatchPromise;
}

/**
 * Board/chat mutual-exclusion probe for the chat send path: true while a
 * kanban dispatch for this thread is on the wire. A chat send that observes
 * true must join/defer to the board dispatch instead of starting its own turn.
 */
export function isKanbanDispatchInFlight(threadId: ThreadId): boolean {
  return inFlightDispatchByThreadId.has(threadId);
}

const KANBAN_DISPATCH_SETTLE_POLL_MS = 25;
/**
 * Upper bound a chat send POLLS for a racing board dispatch. Past the bound the
 * waiter joins the in-flight dispatch instead of proceeding — starting a turn
 * while a board dispatch is still on the wire would queue a duplicate.
 */
export const KANBAN_DISPATCH_SETTLE_TIMEOUT_MS = 5_000;

/**
 * Chat-send companion to isKanbanDispatchInFlight: wait for a board dispatch on
 * this thread to settle before starting a chat turn, so the two starters
 * serialize instead of queueing two turns. The poll is bounded — but past the
 * bound with a dispatch still on the wire the waiter JOINS it instead of
 * failing open: the board already passed its pending-marker check, so
 * proceeding would queue a duplicate turn. The join is bounded in practice by
 * the turn-start RPC's own deadline.
 */
export async function waitForKanbanDispatchToSettle(
  threadId: ThreadId,
  timeoutMs: number = KANBAN_DISPATCH_SETTLE_TIMEOUT_MS,
): Promise<KanbanDraftDispatchResult | null> {
  const deadline = Date.now() + timeoutMs;
  let settled: KanbanDraftDispatchResult | null = null;
  while (inFlightDispatchByThreadId.has(threadId)) {
    const inFlight = inFlightDispatchByThreadId.get(threadId);
    if (Date.now() >= deadline) {
      // A rejected in-flight promise settles as non-dispatched — the waiter's
      // own send proceeds and surfaces its own error if the dispatch failed.
      const outcome =
        (await inFlight?.then(
          (result) => result,
          () => null,
        )) ?? null;
      if (outcome !== null) {
        settled = outcome;
      }
      continue;
    }
    const outcome = await Promise.race([
      inFlight?.then(
        (result) => result,
        () => null,
      ) ?? Promise.resolve(null),
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), KANBAN_DISPATCH_SETTLE_POLL_MS),
      ),
    ]);
    if (outcome !== null) {
      settled = outcome;
    }
  }
  return settled;
}

/**
 * Promote (when needed) and dispatch a draft thread's composer prompt as a queued
 * turn. Shared by the board's drag-to-In-Progress drop and the new-task dialog's
 * "send now" path, so both routes stay byte-for-byte consistent. Reads the live
 * composer draft by id, so callers only pass identity + dispatch preferences.
 * Concurrent calls for the same thread coalesce onto the first dispatch.
 */
export function dispatchKanbanDraftThread(
  input: KanbanDraftDispatchInput,
): Promise<KanbanDraftDispatchResult> {
  return dispatchKanbanDraftThreadInternal(input, "dispatch");
}

/**
 * Promote a local-only draft (when needed), set the thread's goal from the live
 * composer prompt, then queue the turn. Dispatches `thread.meta.update` with
 * `goalStartBehavior: "defer"` before `thread.turn.start`; if the goal update
 * fails the turn still starts and a warning is surfaced.
 */
export function dispatchKanbanDraftThreadAsGoal(
  input: KanbanDraftDispatchInput,
): Promise<KanbanDraftDispatchResult> {
  return dispatchKanbanDraftThreadInternal(input, "goal");
}

async function dispatchKanbanDraftThreadOnce(
  input: KanbanDraftDispatchInput,
  mode: "dispatch" | "goal",
): Promise<KanbanDraftDispatchResult> {
  const { threadId, projectId, thread } = input;
  const api = readNativeApi();
  if (!api) {
    return { kind: "unavailable" };
  }

  // Re-read the composer at drop time: the card snapshot may lag behind edits made
  // in an open chat, and a stale prompt must never be dispatched.
  const composerStore = useComposerDraftStore.getState();
  const draftComposerState = composerStore.draftsByThreadId[threadId] ?? null;
  const liveSnapshot = buildKanbanComposerDraftSnapshot(draftComposerState);
  const prompt = liveSnapshot?.prompt.trim() ?? "";
  const preDispatchPrompt = liveSnapshot?.prompt ?? "";
  if (prompt.length === 0 && liveSnapshot?.hasAttachments !== true) {
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
  // Worktree creation is owned by the full chat composer path. Kanban stays a
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
  // Persisted AppSnap captures hydrate into `images` asynchronously after a
  // reload; a drop that lands before hydration must not drop them from the
  // turn (and then have the composer clear delete their blobs). Match the
  // chat send: hydrate pending blobs before capacity/staging so they are
  // counted exactly once. Per-attachment failures are skipped by the helper,
  // never rejecting the dispatch.
  const liveComposerImages = draftComposerState?.images ?? [];
  const hydratedPendingImages = await hydratePendingBlobComposerAttachments(
    findPendingBlobComposerAttachments({
      persistedAttachments: draftComposerState?.persistedAttachments ?? [],
      images: liveComposerImages,
    }),
  );
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
          appendAssistantSelectionsToPrompt(
            liveSnapshot?.prompt ?? "",
            composerAssistantSelections,
          ),
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
  const promptFile = buildKanbanPromptFileAttachment({
    messageId,
    text: fullOutgoingMessageText,
    existingAttachmentCount:
      composerImages.length + composerFiles.length + composerAssistantSelections.length,
  });
  const outgoingMessageText = promptFile ? promptFile.reference : fullOutgoingMessageText;
  const filesForSend = promptFile ? [...composerFiles, promptFile.attachment] : composerFiles;
  const turnAttachmentsPromise = stageUploadComposerAttachments({
    threadId,
    images: composerImages,
    files: filesForSend,
    assistantSelections: composerAssistantSelections,
  });
  // The same instant feeds both the command timestamps and the optimistic entry:
  // a server-side failure stamps the session with this createdAt, and the
  // failure check compares it against droppedAtMs with >=.
  const droppedAtMs = Date.now();
  const createdAt = new Date(droppedAtMs).toISOString();

  // Claim the shared turn-start guard so a concurrent chat send for this
  // thread defers to this dispatch instead of queueing a second turn. Claimed
  // after validation so empty/non-dispatchable drops never hold the guard.
  // Ownership (the defer probe) ends when the turn RPC settles below; the
  // watchdog marker is re-armed on success and cleared on failure.
  markPendingTurnDispatch(threadId);
  beginTurnDispatchOwnership(threadId);

  // Optimistic move: show the card In Progress before any round-trip. Provider
  // session init can take seconds; runtime events confirm the move (reconciliation
  // clears the entry) or the failure paths below revert it.
  const kanbanUi = useKanbanUiStore.getState();
  kanbanUi.markOptimisticDispatch(threadId, {
    projectId,
    title: thread?.title ?? fallbackTitle,
    provider: modelSelection.provider,
    baselineTurnId: thread?.latestTurn?.turnId ?? null,
    droppedAtMs,
  });

  let goalWarning: string | undefined;

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
        kanbanUi.clearOptimisticDispatch(threadId);
        clearPendingTurnDispatch(threadId);
        endTurnDispatchOwnership(threadId);
        return { kind: "unavailable" };
      }
      if (project?.kind === "chat") {
        await api.orchestration.dispatchCommand({
          type: "project.meta.update",
          commandId: newCommandId(),
          projectId,
          title: fallbackTitle,
        });
      }
    }

    if (mode === "goal" && (prompt.length > 0 || sendablePastedTexts.length > 0)) {
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
    kanbanUi.clearOptimisticDispatch(threadId);
    clearPendingTurnDispatch(threadId);
    endTurnDispatchOwnership(threadId);
    // A turn failure after the goal command was accepted must not lose the
    // user's text: keep the composer prompt (restoring it when something
    // cleared it mid-flight) and un-hide a promoted local draft so the draft
    // card — or the settled thread's unsent-prompt card — stays visible.
    restoreKanbanDraftPromptAfterFailure(threadId, preDispatchPrompt);
    rollbackPromotingDraftAfterFailure(threadId, thread);
    return {
      kind: "error",
      message: error instanceof Error ? error.message : "Could not send the drafted prompt.",
    };
  }

  // The prompt was consumed by the dispatched turn; an open composer for this
  // thread should not keep offering it.
  // Re-arm the pending marker rather than clearing it: the turn RPC resolved
  // but the stream has not acknowledged the running transition yet, and the
  // catch-up watchdog needs this marker to recover a lost running event —
  // same lifecycle as a normal composer send (cleared on stream ack or by the
  // age cap, cleared above on failure). Exclusion ends here though: the RPC
  // settled, so further drops are follow-ups queueing behind this turn.
  markPendingTurnDispatch(threadId);
  endTurnDispatchOwnership(threadId);
  useComposerDraftStore.getState().clearComposerContent(threadId);
  return { kind: "dispatched", warning: goalWarning };
}

function restoreKanbanDraftPromptAfterFailure(threadId: ThreadId, preDispatchPrompt: string): void {
  if (preDispatchPrompt.trim().length === 0) {
    return;
  }
  const store = useComposerDraftStore.getState();
  const currentPrompt = store.draftsByThreadId[threadId]?.prompt ?? "";
  if (currentPrompt.trim().length > 0) {
    return;
  }
  store.setPrompt(threadId, preDispatchPrompt);
}

function rollbackPromotingDraftAfterFailure(
  threadId: ThreadId,
  thread: SidebarThreadSummary | null,
): void {
  if (thread !== null) {
    return;
  }
  useComposerDraftStore.setState((state) => {
    const current = state.draftThreadsByThreadId[threadId];
    if (!current || current.promotedTo === undefined) {
      return state;
    }
    const next = { ...current };
    delete next.promotedTo;
    return {
      draftThreadsByThreadId: { ...state.draftThreadsByThreadId, [threadId]: next },
    };
  });
}
