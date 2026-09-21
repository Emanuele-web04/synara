import { randomUUID } from "node:crypto";
import {
  EventId,
  TurnId,
  type OrchestrationThreadActivity,
  type ProviderApprovalDecision,
} from "@synara/contracts";
import { toolParamsDisplayFromToolInput } from "@synara/shared/toolParamsDisplay";

/**
 * How one computer approval ended. `reason` is set when the decision the user
 * sent was not the one applied, so both the card and the tool result can say
 * why — today only for a session-wide grant, which this gate does not offer.
 */
export interface ComputerApprovalOutcome {
  readonly decision: "accept" | "decline" | "cancel";
  readonly reason?: string;
}

/**
 * Why `acceptForSession` becomes a decline here. Every computer action is
 * approved on its own because each one drives the human's desktop afresh;
 * there is no per-session grant policy for this gate, and silently applying a
 * lesser decision would leave the user thinking the whole session was cleared.
 */
export const COMPUTER_SESSION_APPROVAL_UNAVAILABLE_REASON =
  "Session-wide approval is not available for computer actions; each action is approved on its own, so this one was declined. Approve it again to run it.";

interface PendingApproval {
  readonly threadId: string;
  readonly settle: (outcome: ComputerApprovalOutcome) => void;
}

/** Synara-owned approvals for providers without a native permission callback.
 * Entries exist only while their exact MCP call is alive; restart/stop cannot
 * reuse an approval. The runtime service routes user decisions here first.
 * One instance lives on the computer service, so the gateway that asks and
 * the provider service that answers share it through the layer graph.
 */
export class ComputerApprovalGate {
  private readonly pending = new Map<string, PendingApproval>();

  respond(threadId: string, requestId: string, decision: ProviderApprovalDecision): boolean {
    const pending = this.pending.get(requestId);
    if (!pending || pending.threadId !== threadId) return false;
    this.pending.delete(requestId);
    pending.settle(
      decision === "acceptForSession"
        ? { decision: "decline", reason: COMPUTER_SESSION_APPROVAL_UNAVAILABLE_REASON }
        : { decision },
    );
    return true;
  }

  async request(input: {
    threadId: string;
    signal: AbortSignal;
    publish: (requestId: string, outcome?: ComputerApprovalOutcome) => Promise<void>;
  }): Promise<ComputerApprovalOutcome> {
    input.signal.throwIfAborted();
    if (this.pending.size >= 128) throw new Error("Too many computer approvals are waiting.");
    const requestId = `computer:${randomUUID()}`;
    let settle!: (outcome: ComputerApprovalOutcome) => void;
    const answer = new Promise<ComputerApprovalOutcome>((resolve) => {
      settle = resolve;
    });
    this.pending.set(requestId, { threadId: input.threadId, settle });
    const cancel = () => settle({ decision: "cancel" });
    input.signal.addEventListener("abort", cancel, { once: true });
    const timeout = setTimeout(cancel, 5 * 60_000);
    timeout.unref?.();
    let outcome: ComputerApprovalOutcome = { decision: "cancel" };
    try {
      await input.publish(requestId);
      if (input.signal.aborted) cancel();
      outcome = await answer;
      input.signal.throwIfAborted();
      return outcome;
    } finally {
      clearTimeout(timeout);
      input.signal.removeEventListener("abort", cancel);
      this.pending.delete(requestId);
      await input.publish(requestId, outcome);
    }
  }
}

/**
 * The thread activity a computer approval publishes, opened and then resolved.
 *
 * Shaped exactly like the approval a provider runtime raises through the
 * projection, because the same chat card renders both: `toolParamsDisplay` is
 * the `{ name, value }` rows the card draws, produced by the shared flattener.
 * A serialised argument string here used to leave the card showing the tool
 * name and nothing the user could judge the action by.
 */
export function computerApprovalActivity(input: {
  readonly requestId: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly outcome?: ComputerApprovalOutcome | undefined;
  readonly turnId: string | null;
  readonly createdAt: string;
}): { readonly eventKey: string; readonly activity: OrchestrationThreadActivity } {
  const eventKey = `${input.requestId}:${input.outcome === undefined ? "open" : "resolved"}`;
  const toolParamsDisplay = toolParamsDisplayFromToolInput(input.args);
  return {
    eventKey,
    activity: {
      id: EventId.makeUnsafe(eventKey),
      tone: "info",
      kind: input.outcome === undefined ? "approval.requested" : "approval.resolved",
      summary:
        input.outcome === undefined
          ? "Computer action needs approval"
          : "Computer approval resolved",
      payload: {
        requestId: input.requestId,
        requestKind: "tool",
        requestType: "tool",
        toolName: input.toolName,
        ...(toolParamsDisplay === undefined ? {} : { toolParamsDisplay: [...toolParamsDisplay] }),
        sessionApprovalAvailable: false,
        ...(input.outcome === undefined ? {} : { decision: input.outcome.decision }),
        ...(input.outcome?.reason === undefined ? {} : { reason: input.outcome.reason }),
      },
      turnId: input.turnId === null ? null : TurnId.makeUnsafe(input.turnId),
      createdAt: input.createdAt,
    },
  };
}
