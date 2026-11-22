// FILE: chatTranscriptSlot.ts
// Purpose: What ChatView hands a surface that draws a thread's rows itself in the transcript's
//          place (SynBot's bot threads, `renderTranscript`): the composer's floating height to
//          keep the last row clear of, whether the thread's detail has loaded, its error and
//          failed-turn recovery, the image viewer, and ChatView's own pending approvals and
//          questions with their responders, so the rows can answer them while the composer, its
//          send paths and its queue stay ChatView's.
// Layer: Chat surface contract (types only)
// Exports: ChatTranscriptSlotInput

import type {
  ApprovalRequestId,
  ProviderApprovalDecision,
  ProviderRequestKind,
  TurnId,
  UserInputQuestion,
} from "@synara/contracts";

import type { PendingUserInputDraftAnswer, PendingUserInputProgress } from "../../pendingUserInput";
import type { PendingApproval, PendingUserInput } from "../../session-logic";
import type { ThreadDetailHydration } from "../ChatView.logic";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";

export interface ChatTranscriptSlotInput {
  /** The floating composer's height: the rows keep their end clear of it. */
  readonly contentInsetBottomPx: number;
  /** "ready" once the thread's history has loaded: an empty thread before that is not new. */
  readonly threadDetailHydration: ThreadDetailHydration;
  readonly onRetryThreadDetailSync: () => void;
  /** The thread's live error (the main transcript's banner), with Dismiss and Unblock. */
  readonly threadError: string | null;
  readonly onDismissThreadError: () => void;
  readonly onUnblockThread: () => void;
  readonly unblockingThread: boolean;
  /** A failed turn that Continue can resume (only the latest), and when it cannot right now. */
  readonly recoverableTurnId: TurnId | null;
  readonly turnRecoveryDisabled: boolean;
  readonly onContinueFailedTurn: (turnId: TurnId) => Promise<boolean>;
  readonly onChangeRecoveryModel: () => void;
  /** Opens ChatView's image viewer on a message's images. */
  readonly onExpandImage: (preview: ExpandedImagePreview) => void;
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
