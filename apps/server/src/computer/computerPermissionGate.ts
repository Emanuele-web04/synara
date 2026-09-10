import { ComputerBackendError } from "./ComputerBackend.ts";

/** Revocation fences queued reads and writes as well as currently running tools. */
export class ComputerPermissionGate {
  private readonly blocked = new Set<string>();
  private readonly calls = new Map<string, Map<AbortController, Promise<unknown>>>();
  private readonly changes = new Map<string, Promise<void>>();
  private closed = false;

  constructor(private readonly timeoutMs = 30_000) {}

  close(): void {
    this.closed = true;
    for (const calls of this.calls.values()) {
      for (const controller of calls.keys()) controller.abort();
    }
    this.blocked.clear();
  }

  async forget(threadId: string): Promise<void> {
    await this.changes.get(threadId)?.catch(() => undefined);
    const calls = this.calls.get(threadId);
    for (const controller of calls?.keys() ?? []) controller.abort();
    // Deletion already prevents gateway calls through the orchestration guard.
    // A native call that ignores cancellation must not retain deleted state.
    this.blocked.delete(threadId);
  }

  run<A>(
    threadId: string,
    signal: AbortSignal | undefined,
    action: (signal: AbortSignal) => Promise<A>,
  ): Promise<A> {
    if (this.closed || this.blocked.has(threadId)) {
      return Promise.reject(
        new ComputerBackendError("Computer control has been revoked for this chat."),
      );
    }
    const controller = new AbortController();
    const calls = this.calls.get(threadId) ?? new Map<AbortController, Promise<unknown>>();
    this.calls.set(threadId, calls);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const result = Promise.resolve()
      .then(() => {
        combined.throwIfAborted();
        return action(combined);
      })
      .finally(() => {
        calls.delete(controller);
        if (calls.size === 0 && this.calls.get(threadId) === calls) this.calls.delete(threadId);
      });
    calls.set(controller, result);
    return result;
  }

  change(threadId: string, enabled: boolean, stopRuntime: () => Promise<void>): Promise<void> {
    if (this.closed) return Promise.reject(new ComputerBackendError("Computer manager is closed."));
    if (this.changes.has(threadId)) {
      return Promise.reject(
        new ComputerBackendError(
          "A computer permission change is already pending. Try again when it finishes.",
        ),
      );
    }
    this.blocked.add(threadId);
    const calls = this.calls.get(threadId);
    for (const controller of calls?.keys() ?? []) controller.abort();
    const result = Promise.resolve()
      .then(async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.all([Promise.allSettled(calls?.values() ?? []), stopRuntime()]),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new ComputerBackendError(
                      "Computer permission change timed out. Access remains blocked; retry the change.",
                    ),
                  ),
                this.timeoutMs,
              );
              timer.unref?.();
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        // Old tokens must be retired before a grant can reopen the gate.
        if (enabled && !this.closed) this.blocked.delete(threadId);
      })
      .finally(() => this.changes.delete(threadId));
    this.changes.set(threadId, result);
    return result;
  }
}
