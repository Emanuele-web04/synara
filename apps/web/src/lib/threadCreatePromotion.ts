// FILE: threadCreatePromotion.ts
// Purpose: Makes draft-to-server thread promotion idempotent across racing UI callers.
// Layer: Web orchestration helper
// Exports: promoteThreadCreate, isDuplicateThreadCreateError, plus the pending/recent
//          promotion predicates the thread route guard and temporary-thread lifecycle
//          use to survive the draft-cleared-before-shell-row window.

import type { ClientOrchestrationCommand, NativeApi, ThreadId } from "@synara/contracts";
import {
  PROMOTED_THREAD_ROUTE_GRACE_MS,
  isPromotedThreadRoutePending,
  markPromotedDraftThreads,
  readPromotedThreadRouteMarkers,
} from "../composerDraftStore";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { getThreadFromState } from "../threadDerivation";

type ThreadCreateCommand = Extract<ClientOrchestrationCommand, { type: "thread.create" }>;

type PromoteThreadCreateResult = "created" | "exists" | "unavailable";
interface PromoteThreadCreateOptions {
  // Draft-aware callers use this when React knows the route is still local.
  readonly force?: boolean;
}

const inFlightThreadCreateById = new Map<ThreadId, Promise<PromoteThreadCreateResult>>();

export function isDuplicateThreadCreateError(error: unknown, threadId: ThreadId): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : typeof error === "object" && error !== null && "message" in error
          ? String((error as { message?: unknown }).message ?? "")
          : "";
  return (
    message.includes("Orchestration command invariant failed (thread.create)") &&
    message.includes(`Thread '${threadId}' already exists and cannot be created twice.`)
  );
}

async function recoverPromotedThreadFromShellSnapshot(
  api: NativeApi,
  threadId: ThreadId,
): Promise<boolean> {
  const snapshot = await api.orchestration.getShellSnapshot();
  useStore.getState().syncServerShellSnapshot(snapshot);
  markPromotedDraftThreads(new Set(snapshot.threads.map((thread) => thread.id)));
  return getThreadFromState(useStore.getState(), threadId) !== null;
}

async function dispatchPromoteThreadCreate(
  api: NativeApi,
  command: ThreadCreateCommand,
  options: PromoteThreadCreateOptions = {},
): Promise<PromoteThreadCreateResult> {
  if (!options.force && getThreadFromState(useStore.getState(), command.threadId)) {
    markPromotedDraftThreads(new Set([command.threadId]));
    return "exists";
  }

  try {
    await api.orchestration.dispatchCommand(command);
    markPromotedDraftThreads(new Set([command.threadId]));
    return "created";
  } catch (error) {
    if (!isDuplicateThreadCreateError(error, command.threadId)) {
      throw error;
    }
    try {
      if (await recoverPromotedThreadFromShellSnapshot(api, command.threadId)) {
        return "exists";
      }
    } catch {
      // Keep the original duplicate-create failure visible if recovery cannot confirm success.
    }
    throw error;
  }
}

export async function promoteThreadCreate(
  command: ThreadCreateCommand,
  api: NativeApi | undefined = readNativeApi(),
  options: PromoteThreadCreateOptions = {},
): Promise<PromoteThreadCreateResult> {
  if (!api) {
    return "unavailable";
  }
  const existing = inFlightThreadCreateById.get(command.threadId);
  if (existing) {
    await existing;
    return "exists";
  }

  const promise = dispatchPromoteThreadCreate(api, command, options).finally(() => {
    inFlightThreadCreateById.delete(command.threadId);
  });
  inFlightThreadCreateById.set(command.threadId, promise);
  return promise;
}

/** True while a `thread.create` dispatch for `threadId` is still in flight. */
export function isThreadCreateInFlight(threadId: ThreadId): boolean {
  return inFlightThreadCreateById.has(threadId);
}

/**
 * True while a promotion for `threadId` is in flight or recently completed —
 * exactly the window where the draft record may be gone while the thread's
 * shell row has not landed yet. Route guards must treat the route as valid
 * (hold a loading fallback) rather than redirect to "/".
 */
export function isThreadPromotionPendingOrRecent(threadId: ThreadId): boolean {
  return inFlightThreadCreateById.has(threadId) || isPromotedThreadRoutePending(threadId);
}

/**
 * Resolves once a promotion for `threadId` is no longer route-fragile — the
 * in-flight create settled and the shell row exists — or the route grace
 * elapsed, whichever comes first. Returns immediately when no promotion is
 * pending, so never-promoted thread ids (e.g. a bad URL) pay nothing.
 */
export async function waitForPromotedThreadRouteReady(threadId: ThreadId): Promise<void> {
  if (!isThreadPromotionPendingOrRecent(threadId)) {
    return;
  }
  // Anchor the deadline to the promotion stamp so the total hold stays inside
  // the route grace no matter when a caller starts waiting.
  const marker = readPromotedThreadRouteMarkers().get(threadId);
  const deadlineAt = (marker?.promotedAt ?? Date.now()) + PROMOTED_THREAD_ROUTE_GRACE_MS;
  const inFlight = inFlightThreadCreateById.get(threadId);
  if (inFlight) {
    await Promise.race([
      inFlight.then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>((resolve) => {
        globalThis.setTimeout(resolve, Math.max(0, deadlineAt - Date.now()));
      }),
    ]);
  }

  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0 || useStore.getState().threadShellById?.[threadId] !== undefined) {
    return;
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      globalThis.clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const unsubscribe = useStore.subscribe((state) => {
      if (state.threadShellById?.[threadId] !== undefined) {
        finish();
      }
    });
    const timer = globalThis.setTimeout(finish, remainingMs);
  });
}
