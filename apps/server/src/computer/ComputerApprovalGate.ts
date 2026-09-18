import { randomUUID } from "node:crypto";
import type {
  ComputerApprovalGrant,
  ComputerGrantActionClass,
  ComputerGrantAppIdentity,
  ComputerGrantScope,
  ProviderApprovalDecision,
} from "@synara/contracts";

/**
 * The durable-grant offer a pending computer approval carries. `offer` is
 * what the prompt proposed — the resolved app identities and the exact
 * action classes the triggering call needs — and `create` mints the grants
 * an explicit response choice asks for. Absent means the prompt offered
 * nothing durable, and a grant choice arriving for it is ignored.
 */
export interface ComputerApprovalGateGrant {
  readonly offer: {
    readonly apps: readonly ComputerGrantAppIdentity[];
    readonly classes: readonly ComputerGrantActionClass[];
    readonly scopes: readonly ComputerGrantScope[];
  };
  readonly create: (
    choice: ComputerApprovalGrant,
    context: { readonly threadId: string; readonly turnId?: string | undefined },
  ) => void;
}

interface PendingApproval {
  readonly threadId: string;
  readonly turnId?: string | undefined;
  readonly settle: (decision: ProviderApprovalDecision) => void;
  readonly grant?: ComputerApprovalGateGrant | undefined;
}

interface TaskApproval {
  readonly turnId: string;
  granted?: boolean;
  pending?: Promise<boolean> | undefined;
}

/** Rejection when no more consent prompts fit, global or for one chat. */
export const COMPUTER_APPROVAL_QUEUE_FULL_CODE = "approval_queue_full";
export const COMPUTER_APPROVAL_QUEUE_GLOBAL_LIMIT = 128;
export const COMPUTER_APPROVAL_QUEUE_THREAD_LIMIT = 8;

export class ComputerApprovalQueueFullError extends Error {
  readonly code = COMPUTER_APPROVAL_QUEUE_FULL_CODE;
  readonly retryable = true;
  constructor(scope: "thread" | "global") {
    super(
      scope === "thread"
        ? "Too many computer approvals are waiting for this chat; try again once an earlier prompt settles."
        : "Too many computer approvals are waiting.",
    );
    this.name = "ComputerApprovalQueueFullError";
  }
}

/** Synara-owned Computer consent, scoped to one live turn. Clipboard reads use
 * separate per-call approvals. The runtime routes user decisions here first;
 * restart, Stop and terminal events discard the grant.
 */
export class ComputerApprovalGate {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly tasks = new Map<string, TaskApproval>();

  cancelThread(threadId: string, turnId?: string): void {
    const task = this.tasks.get(threadId);
    if (turnId === undefined || task?.turnId === turnId) this.tasks.delete(threadId);
    for (const [id, pending] of this.pending) {
      if (pending.threadId !== threadId || (turnId !== undefined && pending.turnId !== turnId))
        continue;
      this.pending.delete(id);
      pending.settle("cancel");
    }
  }

  /** One consent for routine actions in the exact active turn, never a provider-wide grant. */
  async requestTask(input: {
    threadId: string;
    turnId: string;
    signal: AbortSignal;
    publish: (requestId: string, decision?: ProviderApprovalDecision) => Promise<void>;
    grant?: ComputerApprovalGateGrant | undefined;
  }): Promise<boolean> {
    input.signal.throwIfAborted();
    let task = this.tasks.get(input.threadId);
    if (task?.turnId !== input.turnId) {
      this.cancelThread(input.threadId);
      task = { turnId: input.turnId };
      this.tasks.set(input.threadId, task);
    }
    if (task.granted !== undefined) return task.granted;
    const current = task;
    current.pending ??= this.request(input)
      .then((accepted) => {
        if (this.tasks.get(input.threadId) !== current || input.signal.aborted) return false;
        current.granted = accepted;
        return accepted;
      })
      .finally(() => {
        current.pending = undefined;
      });
    // A concurrent follower can be cancelled independently of the first call
    // that published the shared prompt. Do not leave it waiting for user input.
    let cancel: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(input.signal.reason);
      input.signal.addEventListener("abort", cancel, { once: true });
    });
    let accepted: boolean;
    try {
      input.signal.throwIfAborted();
      accepted = await Promise.race([current.pending, aborted]);
    } finally {
      if (cancel) input.signal.removeEventListener("abort", cancel);
    }
    input.signal.throwIfAborted();
    return accepted && this.tasks.get(input.threadId) === current;
  }

  respond(
    threadId: string,
    requestId: string,
    decision: ProviderApprovalDecision,
    grantChoice?: ComputerApprovalGrant,
  ): boolean {
    const pending = this.pending.get(requestId);
    if (!pending || pending.threadId !== threadId) return false;
    this.pending.delete(requestId);
    // Session-wide approval is deliberately unavailable for this gate.
    const effective = decision === "acceptForSession" ? "decline" : decision;
    if (effective === "accept" && grantChoice !== undefined && pending.grant !== undefined) {
      // Grant creation must never eat the approval it rode in on: a store
      // failure leaves the one-time consent intact and the next call simply
      // prompts again.
      try {
        pending.grant.create(grantChoice, {
          threadId: pending.threadId,
          turnId: pending.turnId,
        });
      } catch {
        // Swallowed on purpose — see above.
      }
    }
    pending.settle(effective);
    return true;
  }

  async request(input: {
    threadId: string;
    turnId?: string | undefined;
    signal: AbortSignal;
    publish: (requestId: string, decision?: ProviderApprovalDecision) => Promise<void>;
    grant?: ComputerApprovalGateGrant | undefined;
  }): Promise<boolean> {
    input.signal.throwIfAborted();
    // A stuck turn must not starve every other chat: each thread gets a small
    // cap inside the shared one, and both refuse retryably so the model waits
    // instead of treating a full queue as a denial.
    let threadPending = 0;
    for (const pending of this.pending.values()) {
      if (pending.threadId === input.threadId) threadPending += 1;
    }
    if (threadPending >= COMPUTER_APPROVAL_QUEUE_THREAD_LIMIT) {
      throw new ComputerApprovalQueueFullError("thread");
    }
    if (this.pending.size >= COMPUTER_APPROVAL_QUEUE_GLOBAL_LIMIT) {
      throw new ComputerApprovalQueueFullError("global");
    }
    const requestId = `computer:${randomUUID()}`;
    let settle!: (decision: ProviderApprovalDecision) => void;
    const answer = new Promise<ProviderApprovalDecision>((resolve) => {
      settle = resolve;
    });
    this.pending.set(requestId, {
      threadId: input.threadId,
      turnId: input.turnId,
      settle,
      ...(input.grant !== undefined ? { grant: input.grant } : {}),
    });
    const cancel = () => settle("cancel");
    input.signal.addEventListener("abort", cancel, { once: true });
    const timeout = setTimeout(cancel, 5 * 60_000);
    timeout.unref?.();
    let decision: ProviderApprovalDecision = "cancel";
    try {
      // Publish is on the critical path but is not the decision path: an
      // answer that settles first (a cancel, or a decision that arrived
      // while publish was still in flight) releases the slot instead of
      // leaving the consent pending on a wedged publish forever.
      const published = input.publish(requestId).then(() => "ok" as const);
      const outcome = await Promise.race([published, answer]);
      void published.catch(() => undefined);
      if (outcome === "ok") {
        if (input.signal.aborted) cancel();
        decision = await answer;
      } else {
        decision = outcome;
      }
      input.signal.throwIfAborted();
      return decision === "accept";
    } finally {
      clearTimeout(timeout);
      input.signal.removeEventListener("abort", cancel);
      this.pending.delete(requestId);
      // Best-effort dismissal: a hung or failed publish must not turn an
      // accepted consent into a rejection or hold the caller.
      void input.publish(requestId, decision).catch(() => undefined);
    }
  }
}

export const computerApprovalGate = new ComputerApprovalGate();
