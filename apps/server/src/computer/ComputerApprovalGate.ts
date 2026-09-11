import { randomUUID } from "node:crypto";
import type { ProviderApprovalDecision } from "@synara/contracts";

interface PendingApproval {
  readonly threadId: string;
  readonly turnId?: string | undefined;
  readonly settle: (decision: ProviderApprovalDecision) => void;
}

interface TaskApproval {
  readonly turnId: string;
  granted?: boolean;
  pending?: Promise<boolean> | undefined;
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

  respond(threadId: string, requestId: string, decision: ProviderApprovalDecision): boolean {
    const pending = this.pending.get(requestId);
    if (!pending || pending.threadId !== threadId) return false;
    this.pending.delete(requestId);
    // Session-wide approval is deliberately unavailable for this gate.
    pending.settle(decision === "acceptForSession" ? "decline" : decision);
    return true;
  }

  async request(input: {
    threadId: string;
    turnId?: string | undefined;
    signal: AbortSignal;
    publish: (requestId: string, decision?: ProviderApprovalDecision) => Promise<void>;
  }): Promise<boolean> {
    input.signal.throwIfAborted();
    if (this.pending.size >= 128) throw new Error("Too many computer approvals are waiting.");
    const requestId = `computer:${randomUUID()}`;
    let settle!: (decision: ProviderApprovalDecision) => void;
    const answer = new Promise<ProviderApprovalDecision>((resolve) => {
      settle = resolve;
    });
    this.pending.set(requestId, { threadId: input.threadId, turnId: input.turnId, settle });
    const cancel = () => settle("cancel");
    input.signal.addEventListener("abort", cancel, { once: true });
    const timeout = setTimeout(cancel, 5 * 60_000);
    timeout.unref?.();
    let decision: ProviderApprovalDecision = "cancel";
    try {
      await input.publish(requestId);
      if (input.signal.aborted) cancel();
      decision = await answer;
      input.signal.throwIfAborted();
      return decision === "accept";
    } finally {
      clearTimeout(timeout);
      input.signal.removeEventListener("abort", cancel);
      this.pending.delete(requestId);
      await input.publish(requestId, decision);
    }
  }
}

export const computerApprovalGate = new ComputerApprovalGate();
