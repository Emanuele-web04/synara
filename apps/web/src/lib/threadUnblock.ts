import type { NativeApi, ThreadId } from "@synara/contracts";

export const PROVIDER_DELIVERY_RECONCILIATION_CONFLICT_CODE =
  "PROVIDER_DELIVERY_RECONCILIATION_CONFLICT";

const UNBLOCK_NOTE = "Abandoned from the thread error banner; the command was never confirmed.";

type ThreadUnblockApi = Pick<
  NativeApi["orchestration"],
  "listProviderDeliveryBlockers" | "reconcileProviderDelivery"
>;

export type ThreadUnblockResult =
  | { readonly kind: "unblocked"; readonly reconciledCount: number }
  | { readonly kind: "already-clear" }
  | { readonly kind: "resolved-elsewhere" };

/**
 * The reconciliation conflict is expected, not exceptional: two clients (or a
 * client and a server restart) can race to settle the same blocker.
 */
export function isProviderDeliveryReconciliationConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === PROVIDER_DELIVERY_RECONCILIATION_CONFLICT_CODE
  );
}

// the ambiguous command is never replayed (it may have reached the provider) but the server replays skipped side effects so messages sent while blocked dispatch again; blockers reconcile oldest-first since abandoning one replays commands after it
export async function unblockThreadFromClient(
  api: ThreadUnblockApi,
  threadId: ThreadId,
): Promise<ThreadUnblockResult> {
  const blockers = await api.listProviderDeliveryBlockers({ threadId });
  if (blockers.length === 0) return { kind: "already-clear" };

  const ordered = blockers.toSorted((left, right) => left.eventSequence - right.eventSequence);
  let reconciledCount = 0;
  let conflictCount = 0;
  for (const blocker of ordered) {
    try {
      await api.reconcileProviderDelivery({
        eventSequence: blocker.eventSequence,
        threadId,
        expectedState: blocker.state,
        outcome: "abandon",
        note: UNBLOCK_NOTE,
      });
      reconciledCount += 1;
    } catch (error) {
      if (!isProviderDeliveryReconciliationConflict(error)) throw error;
      conflictCount += 1;
    }
  }

  if (reconciledCount > 0) return { kind: "unblocked", reconciledCount };
  return conflictCount > 0 ? { kind: "resolved-elsewhere" } : { kind: "already-clear" };
}

export type ThreadUnblockNotice = {
  readonly type: "success" | "info";
  readonly title: string;
  readonly description: string;
};

/** Copy for each outcome. Every branch tells the user what to do next, because
 *  the command that failed is deliberately never re-sent on their behalf. */
export function describeThreadUnblockResult(result: ThreadUnblockResult): ThreadUnblockNotice {
  switch (result.kind) {
    case "unblocked":
      return {
        type: "success",
        title: "Thread unblocked",
        description:
          "Messages skipped while it was blocked were retried. Resend your last message if the thread stays idle.",
      };
    case "resolved-elsewhere":
      return {
        type: "info",
        title: "Blocker already cleared",
        description: "Another session settled the failure. Resend your last message to continue.",
      };
    case "already-clear":
      return {
        type: "info",
        title: "Thread is already unblocked",
        description:
          "No provider failure is holding it back. Resend your last message to continue.",
      };
  }
}
