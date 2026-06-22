import {
  type ApprovalRequestId,
  type ProviderApprovalDecision,
  type ThreadId,
} from "@t3tools/contracts";
import { useCallback, useState } from "react";

import { newCommandId } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";

interface UseApprovalResponderInput {
  readonly threadId: ThreadId | null;
  readonly onError: (message: string) => void;
  readonly beforeDispatch?: (decision: ProviderApprovalDecision) => void;
}

interface UseApprovalResponderResult {
  readonly respondingApprovalIds: ApprovalRequestId[];
  readonly respondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<void>;
}

export function useApprovalResponder(input: UseApprovalResponderInput): UseApprovalResponderResult {
  const { threadId, onError, beforeDispatch } = input;
  const [respondingApprovalIds, setRespondingApprovalIds] = useState<ApprovalRequestId[]>([]);
  const respondToApproval = useCallback(
    async (requestId: ApprovalRequestId, decision: ProviderApprovalDecision): Promise<void> => {
      const api = readNativeApi();
      if (!api || !threadId) {
        return;
      }
      setRespondingApprovalIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      beforeDispatch?.(decision);
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.approval.respond",
          commandId: newCommandId(),
          threadId,
          requestId,
          decision,
          createdAt: new Date().toISOString(),
        });
      } catch (error) {
        onError(error instanceof Error ? error.message : "Failed to submit the approval decision.");
      } finally {
        setRespondingApprovalIds((existing) => existing.filter((id) => id !== requestId));
      }
    },
    [threadId, onError, beforeDispatch],
  );
  return { respondingApprovalIds, respondToApproval };
}
