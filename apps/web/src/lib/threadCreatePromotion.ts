// FILE: threadCreatePromotion.ts
// Purpose: Makes draft-to-server thread promotion idempotent across racing UI callers.
// Layer: Web orchestration helper
// Exports: promoteThreadCreate, isDuplicateThreadCreateError

import type { ClientOrchestrationCommand, NativeApi, ThreadId } from "@t3tools/contracts";
import { markPromotedDraftThreads } from "../composerDraftStore";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { getThreadFromState } from "../threadDerivation";

type ThreadCreateCommand = Extract<ClientOrchestrationCommand, { type: "thread.create" }>;

type PromoteThreadCreateResult = "created" | "exists" | "unavailable";

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
): Promise<PromoteThreadCreateResult> {
  if (getThreadFromState(useStore.getState(), command.threadId)) {
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
): Promise<PromoteThreadCreateResult> {
  if (!api) {
    return "unavailable";
  }
  const existing = inFlightThreadCreateById.get(command.threadId);
  if (existing) {
    await existing;
    return "exists";
  }

  const promise = dispatchPromoteThreadCreate(api, command).finally(() => {
    inFlightThreadCreateById.delete(command.threadId);
  });
  inFlightThreadCreateById.set(command.threadId, promise);
  return promise;
}
