// FILE: stagedDraftNavigation.ts
// Purpose: Serializes draft-route creation per project slot and finalizes staged drafts only
//          after their destination route actually commits.
// Layer: Web navigation orchestration

/**
 * Repeated clicks and shortcuts within this window join the attempt already in flight. A
 * navigation that has not settled by then is treated as lost, so a later "New thread" starts
 * a fresh attempt instead of waiting on it until the page reloads.
 */
export const DRAFT_NAVIGATION_COALESCE_WINDOW_MS = 5_000;

const inFlightDraftNavigationBySlot = new Map<
  string,
  {
    readonly operation: Promise<unknown>;
    readonly startedAt: number;
    readonly controller: AbortController;
  }
>();

export function draftNavigationSlotKey(projectId: string, entryPoint: string): string {
  return `${projectId}\u0000${entryPoint}`;
}

/** Coalesces repeated clicks/shortcuts that target the same project + entry-point slot. */
export function runDraftNavigationOnce<T>(
  slotKey: string,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const existing = inFlightDraftNavigationBySlot.get(slotKey);
  if (existing && Date.now() - existing.startedAt < DRAFT_NAVIGATION_COALESCE_WINDOW_MS) {
    return existing.operation as Promise<T>;
  }

  // A retry owns the slot even after it settles; an older preparation must not navigate later.
  existing?.controller.abort();
  const controller = new AbortController();
  const operation = Promise.resolve().then(() => run(controller.signal));
  inFlightDraftNavigationBySlot.set(slotKey, { operation, startedAt: Date.now(), controller });
  const clearOperation = () => {
    if (inFlightDraftNavigationBySlot.get(slotKey)?.operation === operation) {
      inFlightDraftNavigationBySlot.delete(slotKey);
    }
  };
  void operation.then(clearOperation, clearOperation);
  return operation;
}

/**
 * Keeps the previous routed draft alive while the destination loads. A superseding navigation
 * rolls the staged draft back without treating the user's newer navigation as an error.
 */
export async function stageDraftNavigation(input: {
  readonly signal?: AbortSignal | undefined;
  readonly stage: () => void;
  readonly navigate: () => Promise<void>;
  readonly isDestinationActive: () => boolean;
  readonly finalize: () => void;
  readonly rollback: () => void;
}): Promise<boolean> {
  let rolledBack = false;
  const rollbackOnce = () => {
    if (rolledBack) {
      return;
    }
    rolledBack = true;
    input.rollback();
  };

  try {
    if (input.signal?.aborted) {
      rollbackOnce();
      return false;
    }
    input.stage();
    await input.navigate();
    if (input.signal?.aborted || !input.isDestinationActive()) {
      rollbackOnce();
      return false;
    }
    input.finalize();
    return true;
  } catch (error) {
    rollbackOnce();
    throw error;
  }
}
