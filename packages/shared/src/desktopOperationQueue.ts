import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";

export interface DesktopOperationContext {
  active: boolean;
  signal?: AbortSignal | undefined;
}

const execution = new AsyncLocalStorage<DesktopOperationContext>();

/** The raw operation context — the `active` half is what admission checks
 * need; `desktopOperationSignal` hides it on purpose for ordinary callers. */
export function desktopOperationContext(): DesktopOperationContext | undefined {
  return execution.getStore();
}

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

/** The error a queue throws for closed/full/target-switch failures. Any
 * `Error` subtype with this constructor shape qualifies — the host product
 * injects its classified backend error so callers keep flag-based checks. */
export type DesktopOperationErrorCtor = new (
  message: string,
  options?: { retryable?: boolean; cause?: unknown },
) => Error;

/** Resolves once `promise` settles or `signal` aborts, whichever comes first. */
async function settledOrAborted(promise: Promise<unknown>, signal: AbortSignal): Promise<void> {
  const listener: { onAbort?: () => void } = {};
  const aborted = new Promise<void>((resolve) => {
    const onAbort = () => resolve();
    listener.onAbort = onAbort;
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([promise, aborted]);
  } finally {
    if (listener.onAbort) signal.removeEventListener("abort", listener.onAbort);
  }
}

/**
 * One running transaction's stance toward pane input. `observing` counts the
 * observation regions it is inside (`observing`), `inputting` the input
 * regions (`inputting`); pane input may start only while every running
 * transaction is observing and none is inputting.
 */
interface DesktopTransactionStance {
  observing: number;
  inputting: number;
}

interface PaneInputOperation {
  /** Arrival order; see `afterPaneInput`. */
  readonly ticket: number;
  readonly execute: () => Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

/**
 * One desktop operation includes targeting, input, and its returned observation.
 *
 * Pane input (`runPaneInput`) is the human's own input from the computer pane.
 * It keeps the queue's one guarantee — no input interleaves with another
 * party's input mid-action — but it does not wait out a whole agent
 * transaction: a transaction that is only observing (`observing`: the settle
 * wait, the capture, the tree walk after its input already landed) lets it
 * run, and does not resume past that observation, or start its next input
 * (`inputting`), until the pane input in flight has finished. Between
 * transactions pane input goes ahead of queued work, but only the pane input
 * that arrived before that work started waiting: a steady stream of pane
 * input cannot starve the agent.
 *
 * Callers opt in per use: a queue whose callers never mark `observing` and
 * never call `runPaneInput` behaves exactly like a plain exclusive queue.
 */
export class DesktopOperationQueue {
  private readonly context = new AsyncLocalStorage<{ active: boolean }>();
  private readonly scopedContext = new AsyncLocalStorage<{ active: boolean; key: string }>();
  private readonly stanceContext = new AsyncLocalStorage<DesktopTransactionStance>();
  private readonly stances = new Set<DesktopTransactionStance>();
  private readonly paneQueue: PaneInputOperation[] = [];
  private readonly paneControllers = new Set<AbortController>();
  private paneRunning: Promise<void> | undefined;
  /** The last ticket handed to pane input. */
  private paneTickets = 0;
  /** Tickets of the parked `afterPaneInput` waiters: no later pane input starts. */
  private readonly paneWaiters = new Set<{ readonly ticket: number }>();
  private panePending = 0;
  private tail: Promise<void> = Promise.resolve();
  private readonly scopedTails = new Map<string, Promise<void>>();
  private readonly activeScoped = new Set<Promise<void>>();
  private readonly scopedControllers = new Set<AbortController>();
  private pending = 0;
  private closed = false;
  private activeController: AbortController | undefined;

  constructor(private readonly errorCtor: DesktopOperationErrorCtor = Error) {}

  run<A>(action: () => Promise<A>, signal?: AbortSignal): Promise<A> {
    if (this.closed) return Promise.reject(new this.errorCtor("Computer manager is closed."));
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
        new this.errorCtor("Too many computer operations are queued; try again later.", {
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
      if (this.closed) throw new this.errorCtor("Computer manager is closed.");
      callerSignal?.throwIfAborted();
      await Promise.all([...this.activeScoped]);
      // Pane input that arrived before this point goes first.
      const stance = await this.afterPaneInput(callerSignal, () => {
        if (this.closed) throw new this.errorCtor("Computer manager is closed.");
        callerSignal?.throwIfAborted();
        return this.enterStance();
      });
      const controller = new AbortController();
      this.activeController = controller;
      const transaction = {
        active: true,
        signal: callerSignal
          ? AbortSignal.any([callerSignal, controller.signal])
          : controller.signal,
      };
      try {
        return await execution.run(transaction, () =>
          this.context.run(transaction, () => this.stanceContext.run(stance, action)),
        );
      } finally {
        transaction.active = false;
        this.activeController = undefined;
        this.leaveStance(stance);
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
    if (this.closed) return Promise.reject(new this.errorCtor("Computer manager is closed."));
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
          new this.errorCtor(
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
        new this.errorCtor("Too many computer operations are queued; try again later.", {
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
      const stance = await this.afterPaneInput(callerSignal, () => {
        if (this.closed) throw new this.errorCtor("Computer manager is closed.");
        callerSignal?.throwIfAborted();
        return this.enterStance();
      });

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
          this.scopedContext.run({ active: true, key }, () =>
            this.stanceContext.run(stance, action),
          ),
        );
      } finally {
        transaction.active = false;
        this.scopedControllers.delete(controller);
        this.leaveStance(stance);
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
      if (this.closed) throw new this.errorCtor("Computer manager is closed.");
      signal?.throwIfAborted();
      this.activeScoped.add(active);
    });
    this.tail = admission.then(
      () => undefined,
      () => undefined,
    );
    return admission;
  }

  /**
   * Run the human's own input from the computer pane.
   *
   * Pane input runs one at a time, in arrival order, each as a transaction of
   * its own: nested `run`/`runScoped` calls inside join it. One starts only
   * when no transaction is running, or when every running one is inside an
   * `observing` region and none inside `inputting` — so it never lands between
   * two halves of another party's input. Queued exclusive and scoped work
   * waits for the pane input that arrived before it started waiting, not for
   * any that arrives later.
   *
   * Pane input has its own pending limit, so a burst of it (a wheel storm)
   * is refused on its own lane and never fills the queue the agent's calls
   * are admitted to.
   */
  runPaneInput<A>(action: () => Promise<A>, signal?: AbortSignal): Promise<A> {
    if (this.closed) return Promise.reject(new this.errorCtor("Computer manager is closed."));
    if (this.context.getStore()?.active || this.scopedContext.getStore()?.active) {
      assertDesktopOperationActive();
      if (signal) {
        return withDesktopOperationSignal(signal, async () => {
          assertDesktopOperationActive();
          return action();
        });
      }
      return action();
    }
    if (this.panePending >= DESKTOP_OPERATION_QUEUE_LIMIT) {
      return Promise.reject(
        new this.errorCtor("Too many computer operations are queued; try again later.", {
          retryable: true,
        }),
      );
    }
    const inheritedSignal = desktopOperationSignal();
    const callerSignal =
      signal && inheritedSignal
        ? AbortSignal.any([signal, inheritedSignal])
        : (signal ?? inheritedSignal);
    this.panePending += 1;
    // Bound to the caller's async context: the operation may be started from
    // inside an agent transaction's observation, and must not inherit that
    // transaction's context (its call timing, its task attribution).
    const execute = AsyncResource.bind(async (): Promise<A> => {
      if (this.closed) throw new this.errorCtor("Computer manager is closed.");
      callerSignal?.throwIfAborted();
      const controller = new AbortController();
      this.paneControllers.add(controller);
      const transaction = {
        active: true,
        signal: callerSignal
          ? AbortSignal.any([callerSignal, controller.signal])
          : controller.signal,
      };
      try {
        return await execution.run(transaction, () =>
          this.context.run(transaction, () => this.stanceContext.exit(action)),
        );
      } finally {
        transaction.active = false;
        this.paneControllers.delete(controller);
      }
    });
    this.paneTickets += 1;
    const ticket = this.paneTickets;
    const result = new Promise<A>((resolve, reject) => {
      this.paneQueue.push({
        ticket,
        execute,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.pumpPaneInput();
    });
    void result.then(
      () => {
        this.panePending -= 1;
      },
      () => {
        this.panePending -= 1;
      },
    );
    return result;
  }

  /**
   * Mark a stretch of the current transaction that sends no input —
   * observation after its input has landed, or a pause between steps — as a
   * point where pane input may run. Leaving it waits for the pane input in
   * flight, so the transaction never resumes alongside it. Outside a
   * transaction, inside `inputting`, and in foreground delivery (an excursion
   * that raised the target app must not take the human's input while it is
   * raised) it is a plain call.
   *
   * What the transaction observes inside the region can include what the
   * pane input changed meanwhile: a post-action capture is no longer
   * attributable to the action alone.
   */
  async observing<A>(action: () => Promise<A>): Promise<A> {
    const stance = this.stanceContext.getStore();
    if (
      stance === undefined ||
      !this.stances.has(stance) ||
      stance.inputting > 0 ||
      desktopDeliveryMode() === "foreground"
    ) {
      return action();
    }
    stance.observing += 1;
    this.pumpPaneInput();
    try {
      return await action();
    } finally {
      stance.observing -= 1;
      // A cancelled transaction stops waiting: `inputting` still keeps any
      // input it might try from running alongside the pane's.
      if (stance.observing === 0) {
        await this.afterPaneInput(desktopOperationSignal(), () => undefined);
      }
    }
  }

  /**
   * Mark a stretch of the current transaction that sends input. Pane input
   * never starts inside it, even when an enclosing `observing` region would
   * allow it, and entering it waits for the pane input in flight.
   * Cancellation refuses the input instead of waiting on.
   */
  async inputting<A>(action: () => Promise<A>): Promise<A> {
    const stance = this.stanceContext.getStore();
    if (stance === undefined || !this.stances.has(stance)) return action();
    const signal = desktopOperationSignal();
    if (stance.inputting === 0) {
      await this.afterPaneInput(signal, () => {
        signal?.throwIfAborted();
        stance.inputting += 1;
      });
    } else {
      signal?.throwIfAborted();
      stance.inputting += 1;
    }
    try {
      return await action();
    } finally {
      stance.inputting -= 1;
      // Back to observing only: pane input queued during the input may start.
      if (stance.inputting === 0) this.pumpPaneInput();
    }
  }

  /** Abort active work and reject queued work; native cleanup is backend-owned. */
  async close(): Promise<void> {
    this.closed = true;
    this.activeController?.abort();
    for (const controller of this.scopedControllers) controller.abort();
    for (const controller of this.paneControllers) controller.abort();
    for (const queued of this.paneQueue.splice(0)) {
      queued.reject(new this.errorCtor("Computer manager is closed."));
    }
    await this.tail;
    await Promise.all([...this.scopedTails.values()]);
    while (this.paneRunning !== undefined) await this.paneRunning;
  }

  /**
   * Wait for the pane input in flight to finish, then call `admit`
   * synchronously — nothing can start between the last check and `admit`, so
   * `admit` registers the caller's stance before any more pane input can
   * look at it.
   *
   * The wait is bounded: while it is parked, only pane input that arrived
   * before it may start (its ticket is at or below the waiter's), so a steady
   * stream of pane input delays the caller by at most the backlog it found.
   * `signal` ends the wait early; `admit` decides what an abort means.
   */
  private async afterPaneInput<A>(signal: AbortSignal | undefined, admit: () => A): Promise<A> {
    if (this.paneRunning === undefined) return admit();
    const waiter = { ticket: this.paneTickets };
    this.paneWaiters.add(waiter);
    try {
      while (this.paneRunning !== undefined) {
        if (signal?.aborted) break;
        await (signal ? settledOrAborted(this.paneRunning, signal) : this.paneRunning);
      }
      return admit();
    } finally {
      this.paneWaiters.delete(waiter);
      this.pumpPaneInput();
    }
  }

  private enterStance(): DesktopTransactionStance {
    const stance: DesktopTransactionStance = { observing: 0, inputting: 0 };
    this.stances.add(stance);
    return stance;
  }

  private leaveStance(stance: DesktopTransactionStance): void {
    this.stances.delete(stance);
    this.pumpPaneInput();
  }

  private pumpPaneInput(): void {
    if (this.paneRunning !== undefined) return;
    const next = this.paneQueue[0];
    if (next === undefined) return;
    for (const waiter of this.paneWaiters) {
      if (next.ticket > waiter.ticket) return;
    }
    for (const stance of this.stances) {
      if (stance.observing === 0 || stance.inputting > 0) return;
    }
    this.paneQueue.shift();
    const running = next.execute().then(next.resolve, next.reject);
    this.paneRunning = running;
    // Registered before any waiter can await `running`, so the slot is clear
    // (or holds the next admissible pane input) by the time a waiter resumes.
    void running.then(() => {
      if (this.paneRunning === running) this.paneRunning = undefined;
      this.pumpPaneInput();
    });
  }
}
