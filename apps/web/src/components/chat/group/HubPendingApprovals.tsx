// Hub-only UI: reads the worker's existing detail stream and sends human choices
// through the same command helper as the thread. No agent-facing approval API.
import type { ProjectId, ThreadId } from "@synara/contracts";
import { pendingRequestInstanceKey } from "@synara/shared/threadSummary";
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useComposerDraftStore } from "../../../composerDraftStore";
import {
  canSessionAnswerPendingRequests,
  derivePendingApprovals,
  type PendingApproval,
} from "../../../session-logic";
import { useStore } from "../../../store";
import { createThreadSelector } from "../../../storeSelectors";
import { retainThreadDetailSubscription } from "../../../threadDetailSubscriptionRetention";
import type { Thread } from "../../../types";
import { Button } from "../../ui/button";
import { toastManager } from "../../ui/toast";
import { ComposerPendingApprovalPanel } from "../ComposerPendingApprovalPanel";
import { respondToThreadApproval } from "../respondToThreadApproval";

export function HubPendingApprovals({
  threadIds,
  hubProjectId,
  coordinatorThreadId,
  onOpenThread,
}: {
  threadIds: readonly ThreadId[];
  hubProjectId?: ProjectId;
  coordinatorThreadId?: ThreadId;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  // Shell attention arrives even for workers never opened in this client. Only
  // retain pending workers, keeping idle Hub members out of the stream budget.
  const pendingThreadIds = useStore(
    useShallow((state) =>
      [
        ...new Set([
          ...threadIds,
          ...Object.values(state.sidebarThreadSummaryById)
            .filter((thread) => hubProjectId !== undefined && thread.projectId === hubProjectId)
            .map((thread) => thread.id),
          ...Object.values(state.threadShellById ?? {})
            .filter((thread) => hubProjectId !== undefined && thread.projectId === hubProjectId)
            .map((thread) => thread.id),
        ]),
      ].filter(
        (id) =>
          id !== coordinatorThreadId &&
          (state.sidebarThreadSummaryById[id]?.hasPendingApprovals ??
            state.threadShellById?.[id]?.hasPendingApprovals),
      ),
    ),
  );
  if (pendingThreadIds.length === 0) return null;
  return (
    <section aria-label="Thread approvals" className="mb-2 max-h-[45vh] space-y-3 overflow-y-auto">
      {pendingThreadIds.map((id) => (
        <HubThreadApprovals key={id} threadId={id} onOpenThread={onOpenThread} />
      ))}
    </section>
  );
}

function HubThreadApprovals({
  threadId,
  onOpenThread,
}: {
  threadId: ThreadId;
  onOpenThread: (id: ThreadId) => void;
}) {
  useEffect(() => retainThreadDetailSubscription(threadId), [threadId]);
  const thread = useStore(useMemo(() => createThreadSelector(threadId), [threadId]));
  if (!thread || !canSessionAnswerPendingRequests(thread.session)) return null;
  const approvals = derivePendingApprovals(thread.activities, thread.pendingInteractions, {
    authoritativeHasPending: thread.hasPendingApprovals,
    latestTurnId: thread.latestTurn?.turnId,
  });
  return (
    <div className="space-y-2">
      <Button
        variant="ghost"
        size="sm"
        className="h-auto max-w-full justify-start truncate p-0 text-ui font-medium hover:bg-transparent hover:underline"
        onClick={() => onOpenThread(threadId)}
      >
        {thread.title}
      </Button>
      {approvals.length === 0 ? (
        <p className="text-ui-sm text-muted-foreground">Loading approval…</p>
      ) : (
        approvals.map((approval) => (
          <HubApprovalCard
            key={pendingRequestInstanceKey(approval.requestId, approval.lifecycleGeneration)}
            thread={thread}
            approval={approval}
          />
        ))
      )}
    </div>
  );
}

function HubApprovalCard({ thread, approval }: { thread: Thread; approval: PendingApproval }) {
  const [responding, setResponding] = useState(false);
  return (
    <ComposerPendingApprovalPanel
      approval={approval}
      pendingCount={1}
      isResponding={responding}
      onRespond={async (requestId, decision, lifecycleGeneration, requestKind) => {
        setResponding(true);
        try {
          await respondToThreadApproval({
            threadId: thread.id,
            requestId,
            decision,
            lifecycleGeneration,
            requestKind,
            runtimeMode:
              useComposerDraftStore.getState().draftsByThreadId[thread.id]?.runtimeMode ??
              thread.runtimeMode,
          });
        } catch (error) {
          toastManager.add({
            type: "error",
            title: "Couldn't send your answer",
            description: error instanceof Error ? error.message : "Try again from the thread.",
          });
          throw error;
        } finally {
          setResponding(false);
        }
      }}
    />
  );
}
