import {
  CommandId,
  MessageId,
  ThreadId,
  WS_RPC_ERROR_CODES,
  type NativeApi,
  type OrchestrationEvent,
} from "@synara/contracts";

export type CheckpointFileRestoreStatus =
  | { readonly status: "not-found" }
  | {
      readonly status: "pending";
      readonly sequence: number;
    }
  | {
      readonly status: "succeeded";
      readonly sequence: number;
    }
  | {
      readonly status: "failed";
      readonly sequence: number;
      readonly detail: string;
      readonly requiresWorkspaceReview: boolean;
    };

export class CheckpointFileRestoreFailedError extends Error {
  readonly requiresWorkspaceReview: boolean;

  constructor(detail: string, requiresWorkspaceReview: boolean) {
    super(detail);
    this.name = "CheckpointFileRestoreFailedError";
    this.requiresWorkspaceReview = requiresWorkspaceReview;
  }
}

export function isCheckpointFileRestoreReviewRequiredError(
  error: unknown,
): error is CheckpointFileRestoreFailedError {
  return error instanceof CheckpointFileRestoreFailedError && error.requiresWorkspaceReview;
}

export interface PendingCheckpointFileRestore {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly turnCount: number;
  readonly requestCommandId: CommandId;
  readonly reconciliationCommandId?: CommandId;
  readonly createdAt: string;
  readonly phase: "confirming" | "dispatched";
  readonly clientId?: string;
  readonly acceptanceAmbiguous?: boolean;
}

const PENDING_CHECKPOINT_FILE_RESTORE_STORAGE_KEY = "synara.pendingCheckpointFileRestore.v1";
const PENDING_CHECKPOINT_FILE_RESTORE_CHANGE_EVENT =
  "synara:pending-checkpoint-file-restore-change";
export const CHECKPOINT_FILE_RESTORE_BLOCKED_MESSAGE =
  "A file restore is still being reconciled. Wait for Synara to confirm it is safe to continue.";

const DEFAULT_RECONCILE_INTERVAL_MS = 2_000;
let checkpointFileRestoreClientId: string | null = null;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function pendingCheckpointFileRestoreFromUnknown(
  value: unknown,
): PendingCheckpointFileRestore | null {
  if (!isObject(value)) return null;
  if (
    !isNonEmptyString(value.threadId) ||
    !isNonEmptyString(value.messageId) ||
    !isNonEmptyString(value.requestCommandId) ||
    !isNonEmptyString(value.createdAt) ||
    typeof value.turnCount !== "number" ||
    !Number.isInteger(value.turnCount) ||
    value.turnCount < 0
  ) {
    return null;
  }
  return {
    threadId: ThreadId.makeUnsafe(value.threadId),
    messageId: MessageId.makeUnsafe(value.messageId),
    requestCommandId: CommandId.makeUnsafe(value.requestCommandId),
    ...(isNonEmptyString(value.reconciliationCommandId)
      ? { reconciliationCommandId: CommandId.makeUnsafe(value.reconciliationCommandId) }
      : {}),
    turnCount: value.turnCount,
    createdAt: value.createdAt,
    phase:
      value.phase === "confirming" || value.phase === "dispatched" ? value.phase : "dispatched",
    ...(isNonEmptyString(value.clientId) ? { clientId: value.clientId } : {}),
    ...(value.acceptanceAmbiguous === true ? { acceptanceAmbiguous: true } : {}),
  };
}

export function getCheckpointFileRestoreClientId(): string {
  if (checkpointFileRestoreClientId) return checkpointFileRestoreClientId;
  const cryptoApi =
    typeof globalThis !== "undefined" && "crypto" in globalThis ? globalThis.crypto : null;
  checkpointFileRestoreClientId =
    cryptoApi && "randomUUID" in cryptoApi
      ? cryptoApi.randomUUID()
      : `checkpoint-file-restore-${Math.random().toString(36).slice(2)}`;
  return checkpointFileRestoreClientId;
}

export function shouldReconcileCheckpointFileRestoreAcceptance(
  pending: PendingCheckpointFileRestore,
  clientId: string = getCheckpointFileRestoreClientId(),
): boolean {
  return (
    pending.phase === "dispatched" &&
    pending.reconciliationCommandId !== undefined &&
    (pending.acceptanceAmbiguous === true || pending.clientId !== clientId)
  );
}

export function isStaleCheckpointFileRestoreConfirmation(
  pending: PendingCheckpointFileRestore,
): boolean {
  return pending.phase === "confirming" && pending.clientId === undefined;
}

export function getCheckpointFileRestoreStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readPendingCheckpointFileRestore(
  storage: Storage | null = getCheckpointFileRestoreStorage(),
): PendingCheckpointFileRestore | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(PENDING_CHECKPOINT_FILE_RESTORE_STORAGE_KEY);
    if (!raw) return null;
    return pendingCheckpointFileRestoreFromUnknown(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function getPendingCheckpointFileRestoreSnapshot(
  storage: Storage | null = getCheckpointFileRestoreStorage(),
): string | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(PENDING_CHECKPOINT_FILE_RESTORE_STORAGE_KEY);
    if (!raw) return null;
    return pendingCheckpointFileRestoreFromUnknown(JSON.parse(raw)) ? raw : null;
  } catch {
    return null;
  }
}

export function hasPendingCheckpointFileRestore(
  storage: Storage | null = getCheckpointFileRestoreStorage(),
): boolean {
  return getPendingCheckpointFileRestoreSnapshot(storage) !== null;
}

function notifyPendingCheckpointFileRestoreChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(PENDING_CHECKPOINT_FILE_RESTORE_CHANGE_EVENT));
}

export function subscribePendingCheckpointFileRestore(listener: () => void): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }
  const onStorage = (event: StorageEvent) => {
    if (event.key === PENDING_CHECKPOINT_FILE_RESTORE_STORAGE_KEY) {
      listener();
    }
  };
  window.addEventListener(PENDING_CHECKPOINT_FILE_RESTORE_CHANGE_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(PENDING_CHECKPOINT_FILE_RESTORE_CHANGE_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function savePendingCheckpointFileRestore(
  pending: PendingCheckpointFileRestore,
  storage: Storage | null = getCheckpointFileRestoreStorage(),
): boolean {
  if (!storage) return false;
  try {
    const existing = readPendingCheckpointFileRestore(storage);
    if (existing && existing.requestCommandId !== pending.requestCommandId) {
      return false;
    }
    storage.setItem(PENDING_CHECKPOINT_FILE_RESTORE_STORAGE_KEY, JSON.stringify(pending));
    const saved = readPendingCheckpointFileRestore(storage);
    if (
      !saved ||
      saved.requestCommandId !== pending.requestCommandId ||
      saved.phase !== pending.phase
    ) {
      return false;
    }
    notifyPendingCheckpointFileRestoreChanged();
    return true;
  } catch {
    return false;
  }
}

export function clearPendingCheckpointFileRestore(
  requestCommandId: CommandId,
  storage: Storage | null = getCheckpointFileRestoreStorage(),
): void {
  if (!storage) return;
  try {
    const pending = readPendingCheckpointFileRestore(storage);
    if (pending?.requestCommandId === requestCommandId) {
      storage.removeItem(PENDING_CHECKPOINT_FILE_RESTORE_STORAGE_KEY);
      notifyPendingCheckpointFileRestoreChanged();
    }
  } catch {
    // Nothing useful to do if localStorage is unavailable.
  }
}

export function checkpointFileRestoreStatusFromEvents(input: {
  readonly events: ReadonlyArray<OrchestrationEvent>;
  readonly threadId: ThreadId;
  readonly requestCommandId: CommandId;
}): CheckpointFileRestoreStatus {
  let requested: Extract<CheckpointFileRestoreStatus, { status: "pending" }> | null = null;
  let terminal: CheckpointFileRestoreStatus | null = null;

  for (const event of input.events) {
    if (event.aggregateKind !== "thread" || event.aggregateId !== input.threadId) {
      continue;
    }
    if (
      event.type === "thread.checkpoint-files-restore-prepared" &&
      event.payload.requestCommandId === input.requestCommandId
    ) {
      requested = { status: "pending", sequence: event.sequence };
      continue;
    }
    if (
      event.type === "thread.checkpoint-files-restore-requested" &&
      event.commandId === input.requestCommandId
    ) {
      requested = { status: "pending", sequence: event.sequence };
      continue;
    }
    if (
      event.type !== "thread.checkpoint-files-restored" &&
      event.type !== "thread.checkpoint-files-restore-failed" &&
      event.type !== "thread.checkpoint-files-restore-reviewed"
    ) {
      continue;
    }
    if (event.type === "thread.checkpoint-files-restore-reviewed") {
      if (event.payload.requestCommandId === input.requestCommandId) {
        requested = null;
      }
      continue;
    }
    if (event.payload.requestCommandId !== input.requestCommandId) {
      continue;
    }
    terminal =
      event.type === "thread.checkpoint-files-restored"
        ? { status: "succeeded", sequence: event.sequence }
        : {
            status: "failed",
            sequence: event.sequence,
            detail: event.payload.detail,
            requiresWorkspaceReview: event.payload.requiresWorkspaceReview,
          };
  }

  return terminal ?? requested ?? { status: "not-found" };
}

export async function getCheckpointFileRestoreStatus(input: {
  readonly api: Pick<NativeApi["orchestration"], "replayEvents">;
  readonly threadId: ThreadId;
  readonly requestCommandId: CommandId;
}): Promise<CheckpointFileRestoreStatus> {
  const events = await input.api.replayEvents(0);
  return checkpointFileRestoreStatusFromEvents({
    events,
    threadId: input.threadId,
    requestCommandId: input.requestCommandId,
  });
}

export function isDefinitiveDispatchRejection(error: unknown): boolean {
  return (
    isObject(error) &&
    error._tag === "WsRpcError" &&
    error.code === WS_RPC_ERROR_CODES.orchestrationDispatchRejected
  );
}

type CheckpointFileRestoreWaitInput = {
  requestCommandId: CommandId;
  subscribe: (listener: (event: OrchestrationEvent) => void) => () => void;
  getStatus?: () => Promise<CheckpointFileRestoreStatus>;
  reconcileIntervalMs?: number;
};

type CheckpointFileRestoreWait = { promise: Promise<void>; cancel: () => void };

function createCheckpointFileRestoreWait(
  input: CheckpointFileRestoreWaitInput,
): CheckpointFileRestoreWait {
  // Never release the caller's mutation gate based on elapsed time. The server
  // serializes checkpoint work, so a valid restore can wait behind long captures;
  // only its correlated durable success/failure or authoritative dispatch
  // rejection proves it is safe to continue.
  let unsubscribe = () => {};
  let settled = false;
  let intervalId: ReturnType<typeof globalThis.setInterval> | null = null;

  const cleanup = () => {
    unsubscribe();
    if (intervalId !== null) {
      globalThis.clearInterval(intervalId);
      intervalId = null;
    }
  };
  const promise = new Promise<void>((resolve, reject) => {
    const settleSuccess = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const settleFailure = (detail: string, requiresWorkspaceReview: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new CheckpointFileRestoreFailedError(detail, requiresWorkspaceReview));
    };
    const reconcile = () => {
      if (!input.getStatus || settled) return;
      void input
        .getStatus()
        .then((status) => {
          if (status.status === "succeeded") {
            settleSuccess();
          } else if (status.status === "failed") {
            settleFailure(status.detail, status.requiresWorkspaceReview);
          }
        })
        .catch(() => {
          // A failed reconciliation read is transport state, not a terminal
          // restore result. Keep the gate closed and try again later.
        });
    };

    unsubscribe = input.subscribe((event) => {
      if (
        (event.type !== "thread.checkpoint-files-restored" &&
          event.type !== "thread.checkpoint-files-restore-failed") ||
        event.payload.requestCommandId !== input.requestCommandId
      ) {
        return;
      }
      if (event.type === "thread.checkpoint-files-restore-failed") {
        settleFailure(event.payload.detail, event.payload.requiresWorkspaceReview);
      } else {
        settleSuccess();
      }
    });

    reconcile();
    if (input.getStatus && !settled) {
      intervalId = globalThis.setInterval(
        reconcile,
        input.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS,
      );
    }
  });

  return {
    promise,
    cancel: () => {
      if (!settled) cleanup();
    },
  };
}

const sharedCheckpointFileRestoreWaits = new Map<
  CommandId,
  {
    readonly wait: CheckpointFileRestoreWait;
    consumers: number;
  }
>();

export function waitForCheckpointFileRestore(
  input: CheckpointFileRestoreWaitInput,
): CheckpointFileRestoreWait {
  let shared = sharedCheckpointFileRestoreWaits.get(input.requestCommandId);
  if (!shared) {
    const wait = createCheckpointFileRestoreWait(input);
    shared = { wait, consumers: 0 };
    sharedCheckpointFileRestoreWaits.set(input.requestCommandId, shared);
    const clearSharedWait = () => {
      if (sharedCheckpointFileRestoreWaits.get(input.requestCommandId) === shared) {
        sharedCheckpointFileRestoreWaits.delete(input.requestCommandId);
      }
    };
    void wait.promise.then(clearSharedWait, clearSharedWait);
  }
  shared.consumers += 1;

  let released = false;
  return {
    promise: shared.wait.promise,
    cancel: () => {
      if (released) return;
      released = true;
      shared.consumers -= 1;
      if (shared.consumers > 0) return;
      shared.wait.cancel();
      if (sharedCheckpointFileRestoreWaits.get(input.requestCommandId) === shared) {
        sharedCheckpointFileRestoreWaits.delete(input.requestCommandId);
      }
    },
  };
}
