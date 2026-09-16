import { AsyncLocalStorage } from "node:async_hooks";

import { ComputerBackendError } from "./ComputerBackend.ts";

const execution = new AsyncLocalStorage<{ active: boolean; signal?: AbortSignal | undefined }>();
export function desktopOperationSignal(): AbortSignal | undefined {
  const operation = execution.getStore();
  return operation?.active ? operation.signal : undefined;
}
export async function withDesktopOperationSignal<A>(
  signal: AbortSignal,
  action: () => Promise<A>,
): Promise<A> {
  const parent = desktopOperationSignal();
  const scope = { active: true, signal: parent ? AbortSignal.any([parent, signal]) : signal };
  try {
    return await execution.run(scope, action);
  } finally {
    scope.active = false;
  }
}
/** A detached continuation cannot turn a completed call into fresh input authority. */
export function assertDesktopOperationAdmission(): void {
  const operation = execution.getStore();
  if (operation && !operation.active) {
    throw new ComputerBackendError(
      "The computer operation has ended; no new input may be dispatched.",
    );
  }
  operation?.signal?.throwIfAborted();
}

export function assertDesktopOperationActive(): void {
  desktopOperationSignal()?.throwIfAborted();
}

export function withoutDesktopCancellation<A>(action: () => A): A {
  return execution.run({ active: true }, action);
}

const delivery = new AsyncLocalStorage<"background" | "foreground">();
export const desktopDeliveryMode = () => delivery.getStore() ?? "background";
export const withDesktopDeliveryMode = <A>(mode: "background" | "foreground", action: () => A): A =>
  delivery.run(mode, action);

export const DESKTOP_OPERATION_QUEUE_LIMIT = 64;

/** One desktop operation includes targeting, input, and its returned observation. */
export class DesktopOperationQueue {
  private readonly context = new AsyncLocalStorage<{ active: boolean }>();
  private readonly scopedContext = new AsyncLocalStorage<{ active: boolean; key: string }>();
  private tail: Promise<void> = Promise.resolve();
  private readonly scopedTails = new Map<string, Promise<void>>();
  private readonly activeScoped = new Set<Promise<void>>();
  private readonly scopedControllers = new Set<AbortController>();
  private pending = 0;
  private closed = false;
  private activeController: AbortController | undefined;

  run<A>(action: () => Promise<A>, signal?: AbortSignal): Promise<A> {
    if (this.closed) return Promise.reject(new ComputerBackendError("Computer manager is closed."));
    // Tool calls wrap manager actions in the same transaction. Detached work
    // must enqueue again once that transaction finishes.
    if (this.context.getStore()?.active) {
      assertDesktopOperationActive();
      if (signal) {
        return withDesktopOperationSignal(signal, async () => {
          assertDesktopOperationActive();
          return action();
        });
      }
      return action();
    }
    if (this.scopedContext.getStore()?.active) {
      assertDesktopOperationActive();
      if (signal) {
        return withDesktopOperationSignal(signal, async () => {
          assertDesktopOperationActive();
          return action();
        });
      }
      return action();
    }
    if (this.pending >= DESKTOP_OPERATION_QUEUE_LIMIT) {
      return Promise.reject(
        new ComputerBackendError("Too many computer operations are queued; try again later.", {
          retryable: true,
        }),
      );
    }
    // Capture the caller's live scope before waiting: the queue owns its own
    // transaction, but RPC interruption and caller revocation still cancel it.
    const inheritedSignal = desktopOperationSignal();
    const callerSignal =
      signal && inheritedSignal
        ? AbortSignal.any([signal, inheritedSignal])
        : (signal ?? inheritedSignal);
    this.pending += 1;
    const result = this.tail.then(async () => {
      if (this.closed) throw new ComputerBackendError("Computer manager is closed.");
      callerSignal?.throwIfAborted();
      await Promise.all([...this.activeScoped]);
      if (this.closed) throw new ComputerBackendError("Computer manager is closed.");
      callerSignal?.throwIfAborted();
      const controller = new AbortController();
      this.activeController = controller;
      const transaction = {
        active: true,
        signal: callerSignal
          ? AbortSignal.any([callerSignal, controller.signal])
          : controller.signal,
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

  /**
   * Run an exact-target operation concurrently with other exact targets.
   *
   * Calls sharing a key stay ordered. An exclusive `run` waits for every
   * already-admitted scoped call, while a scoped call waits behind an
   * exclusive call that was queued first. This is a writer barrier with
   * per-key readers: focus-sensitive desktop work remains globally exclusive,
   * but independently addressed semantic mutations can overlap.
   */
  runScoped<A>(key: string, action: () => Promise<A>, signal?: AbortSignal): Promise<A> {
    if (this.closed) return Promise.reject(new ComputerBackendError("Computer manager is closed."));
    if (this.context.getStore()?.active) {
      assertDesktopOperationActive();
      if (signal) {
        return withDesktopOperationSignal(signal, async () => {
          assertDesktopOperationActive();
          return action();
        });
      }
      return action();
    }
    const scoped = this.scopedContext.getStore();
    if (scoped?.active) {
      if (scoped.key !== key) {
        return Promise.reject(
          new ComputerBackendError(
            "A scoped computer operation cannot switch targets before it finishes.",
          ),
        );
      }
      assertDesktopOperationActive();
      if (signal) {
        return withDesktopOperationSignal(signal, async () => {
          assertDesktopOperationActive();
          return action();
        });
      }
      return action();
    }
    if (this.pending >= DESKTOP_OPERATION_QUEUE_LIMIT) {
      return Promise.reject(
        new ComputerBackendError("Too many computer operations are queued; try again later.", {
          retryable: true,
        }),
      );
    }

    const inheritedSignal = desktopOperationSignal();
    const callerSignal =
      signal && inheritedSignal
        ? AbortSignal.any([signal, inheritedSignal])
        : (signal ?? inheritedSignal);
    const predecessor = this.scopedTails.get(key) ?? Promise.resolve();
    this.pending += 1;
    let finish!: () => void;
    const active = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const admission = this.enqueueScopedAdmission(active, callerSignal);
    const operation = Promise.all([predecessor, admission]).then(async () => {
      if (this.closed) throw new ComputerBackendError("Computer manager is closed.");
      callerSignal?.throwIfAborted();

      const controller = new AbortController();
      this.scopedControllers.add(controller);
      const transaction = {
        active: true,
        signal: callerSignal
          ? AbortSignal.any([callerSignal, controller.signal])
          : controller.signal,
      };
      try {
        return await execution.run(transaction, () =>
          this.scopedContext.run({ active: true, key }, action),
        );
      } finally {
        transaction.active = false;
        this.scopedControllers.delete(controller);
      }
    });
    const result = operation.finally(() => {
      this.activeScoped.delete(active);
      finish();
    });
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.scopedTails.set(key, settled);
    void settled.finally(() => {
      this.pending -= 1;
      if (this.scopedTails.get(key) === settled) this.scopedTails.delete(key);
    });
    return result;
  }

  /**
   * Publish a scoped operation into the exclusive queue before it starts.
   *
   * The publication itself never waits for existing scoped work; that is what
   * lets several independent keys become active together. Its position in the
   * exclusive tail still establishes ordering against writers queued before or
   * after it.
   */
  private enqueueScopedAdmission(active: Promise<void>, signal?: AbortSignal): Promise<void> {
    const admission = this.tail.then(() => {
      if (this.closed) throw new ComputerBackendError("Computer manager is closed.");
      signal?.throwIfAborted();
      this.activeScoped.add(active);
    });
    this.tail = admission.then(
      () => undefined,
      () => undefined,
    );
    return admission;
  }

  /** Abort active work and reject queued work; native cleanup is backend-owned. */
  async close(): Promise<void> {
    this.closed = true;
    this.activeController?.abort();
    for (const controller of this.scopedControllers) controller.abort();
    await this.tail;
    await Promise.all([...this.scopedTails.values()]);
  }
}
