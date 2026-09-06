import { AsyncLocalStorage } from "node:async_hooks";

import { ComputerBackendError } from "./ComputerBackend.ts";

const execution = new AsyncLocalStorage<{ active: boolean; signal?: AbortSignal | undefined }>();
export function desktopOperationSignal(): AbortSignal | undefined {
  const operation = execution.getStore();
  return operation?.active ? operation.signal : undefined;
}
export function assertDesktopOperationActive(): void {
  desktopOperationSignal()?.throwIfAborted();
}

export function withoutDesktopCancellation<A>(action: () => A): A {
  return execution.run({ active: true }, action);
}

export const DESKTOP_OPERATION_QUEUE_LIMIT = 64;

/** One desktop operation includes targeting, input, and its returned observation. */
export class DesktopOperationQueue {
  private readonly context = new AsyncLocalStorage<{ active: boolean }>();
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private closed = false;
  private activeController: AbortController | undefined;

  run<A>(action: () => Promise<A>, signal?: AbortSignal): Promise<A> {
    if (this.closed) return Promise.reject(new ComputerBackendError("Computer manager is closed."));
    // Tool calls wrap manager actions in the same transaction. Detached work
    // must enqueue again once that transaction finishes.
    if (this.context.getStore()?.active) {
      assertDesktopOperationActive();
      return action();
    }
    if (this.pending >= DESKTOP_OPERATION_QUEUE_LIMIT) {
      return Promise.reject(
        new ComputerBackendError("Too many computer operations are queued; try again later.", {
          retryable: true,
        }),
      );
    }
    this.pending += 1;
    const result = this.tail.then(async () => {
      if (this.closed) throw new ComputerBackendError("Computer manager is closed.");
      signal?.throwIfAborted();
      const controller = new AbortController();
      this.activeController = controller;
      const transaction = {
        active: true,
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      };
      try {
        return await execution.run(transaction, () => this.context.run(transaction, action));
      } finally {
        transaction.active = false;
        this.activeController = undefined;
      }
    });
    this.tail = result.then(
      () => {
        this.pending -= 1;
      },
      () => {
        this.pending -= 1;
      },
    );
    return result;
  }

  /** Reject waiting work, then let the active input sequence release its keys. */
  async close(): Promise<void> {
    this.closed = true;
    this.activeController?.abort();
    await this.tail;
  }
}
