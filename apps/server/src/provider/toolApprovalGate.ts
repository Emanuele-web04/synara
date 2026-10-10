import { randomUUID } from "node:crypto";
import {
  EventId,
  RuntimeRequestId,
  type ProviderApprovalDecision,
  type ProviderKind,
  type ProviderRuntimeEvent,
  type RuntimeItemId,
  type ThreadId,
  type TurnId,
} from "@synara/contracts";

/** Bridges pre-tool hooks to the same durable approval lifecycle as native callbacks. */
export class ToolApprovalGate {
  private readonly pending = new Map<
    string,
    {
      turnId: TurnId;
      finish: (decision: ProviderApprovalDecision) => void;
    }
  >();

  constructor(
    private readonly options: {
      provider: ProviderKind;
      threadId: ThreadId;
      lifecycleGeneration?: string | undefined;
      emit: (event: ProviderRuntimeEvent) => void;
    },
  ) {}

  request(input: {
    turnId: TurnId;
    toolName: string;
    input: unknown;
    cwd?: string | undefined;
    itemId?: RuntimeItemId | undefined;
    requestId?: string | undefined;
    signal?: AbortSignal | undefined;
    incompleteContext?: boolean | undefined;
  }): Promise<ProviderApprovalDecision> {
    if (input.signal?.aborted) return Promise.resolve("cancel");
    const requestId = RuntimeRequestId.makeUnsafe(input.requestId ?? randomUUID());
    // Duplicate hook delivery must never replace an outstanding response.
    if (this.pending.has(requestId)) return Promise.resolve("cancel");
    const base = {
      provider: this.options.provider,
      threadId: this.options.threadId,
      turnId: input.turnId,
      requestId,
      ...(input.itemId ? { itemId: input.itemId } : {}),
      ...(this.options.lifecycleGeneration
        ? { lifecycleGeneration: this.options.lifecycleGeneration }
        : {}),
    };
    const stamp = () => ({
      eventId: EventId.makeUnsafe(randomUUID()),
      createdAt: new Date().toISOString(),
    });
    return new Promise((resolve) => {
      const abort = () => finish("cancel");
      const finish = (decision: ProviderApprovalDecision) => {
        if (!this.pending.delete(requestId)) return;
        input.signal?.removeEventListener("abort", abort);
        this.options.emit({
          ...base,
          ...stamp(),
          type: "request.resolved",
          payload: { requestType: "unknown", decision },
        });
        resolve(decision);
      };
      this.pending.set(requestId, { turnId: input.turnId, finish });
      input.signal?.addEventListener("abort", abort, { once: true });
      this.options.emit({
        ...base,
        ...stamp(),
        type: "request.opened",
        payload: {
          requestType: "unknown",
          detail: input.toolName,
          args: {
            toolName: input.toolName,
            input: input.input,
            cwd: input.cwd,
            sessionApprovalAvailable: false,
            ...(input.incompleteContext ? { incompleteContext: true } : {}),
          },
        },
      });
      if (input.signal?.aborted) abort();
    });
  }

  respond(requestId: string, decision: ProviderApprovalDecision): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    pending.finish(decision);
    return true;
  }

  cancel(turnId?: TurnId) {
    for (const entry of this.pending.values()) {
      if (turnId === undefined || entry.turnId === turnId) entry.finish("cancel");
    }
  }
}
