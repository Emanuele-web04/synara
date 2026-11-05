// FILE: chatTranscriptSlot.ts
// Purpose: What ChatView hands a surface that draws a thread's rows itself in the transcript's
//          place (SynBot's bot threads, `renderTranscript`): the composer's floating height to
//          keep the last row clear of, and ChatView's own pending approvals and questions with
//          their responders, so the rows can answer them while the composer, its send paths and
//          its queue stay ChatView's.
// Layer: Chat surface contract (types only)
// Exports: ChatTranscriptSlotInput

import type {
  ApprovalRequestId,
  ProviderApprovalDecision,
  ProviderRequestKind,
  UserInputQuestion,
} from "@synara/contracts";

import type { PendingUserInputDraftAnswer, PendingUserInputProgress } from "../../pendingUserInput";
import type { PendingApproval, PendingUserInput } from "../../session-logic";

export interface ChatTranscriptSlotInput {
  /** The floating composer's height: the rows keep their end clear of it. */
  readonly contentInsetBottomPx: number;
  readonly pendingApprovals: readonly PendingApproval[];
  readonly respondingRequestKeys: readonly string[];
  readonly onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
    lifecycleGeneration?: string,
    requestKind?: ProviderRequestKind,
  ) => Promise<void>;
  /** The question waiting first, answered page by page (the composer answers it in words). */
  readonly pendingUserInput: {
    readonly input: PendingUserInput | null;
    readonly progress: PendingUserInputProgress | null;
    readonly question: UserInputQuestion | null;
    readonly isResponding: boolean;
    readonly onToggleOption: (questionId: string, optionLabel: string) => unknown;
    readonly onAdvance: (overrides?: Record<string, PendingUserInputDraftAnswer>) => boolean;
    readonly onPrevious: () => void;
    readonly onCancel: () => void;
  };
}
