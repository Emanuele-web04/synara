// FILE: parallel-transform.ts
// Purpose: Runs one Vite plugin's transform hook on worker threads so a
//          single-threaded compiler pass uses every core.
// Layer: Web build config
// Depends on: Node worker threads.

import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";

interface TransformTask {
  readonly code: string;
  readonly id: string;
  readonly moduleType: string | undefined;
  readonly environment: { readonly name: string; readonly consumer: string | undefined };
}

interface TransformFailure {
  readonly message: string;
  readonly loc?: unknown;
  readonly pos?: unknown;
  readonly pluginCode?: unknown;
  readonly stack?: string;
}

type WorkerReply =
  | { readonly taskId: number; readonly kind: "result"; readonly value: unknown }
  | { readonly taskId: number; readonly kind: "transform-error"; readonly error: TransformFailure }
  | { readonly taskId: number; readonly kind: "crash"; readonly message: string };

/** The part of `worker_threads.Worker` the pool uses; tests substitute it. */
export interface TransformWorker {
  postMessage(message: unknown): void;
  on(event: "message", listener: (reply: WorkerReply) => void): unknown;
  on(event: "error", listener: (error: unknown) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  ref(): void;
  unref(): void;
  terminate(): Promise<number>;
}

interface PendingTask {
  readonly task: TransformTask;
  readonly resolve: (reply: WorkerReply) => void;
  readonly reject: (error: Error) => void;
}

interface PoolWorker {
  readonly worker: TransformWorker;
  current: (PendingTask & { readonly taskId: number }) | undefined;
}

type TransformContext = {
  readonly environment?: {
    readonly name?: unknown;
    readonly config?: { readonly consumer?: unknown };
  };
  readonly error: (failure: unknown) => never;
};

type TransformHandler = (
  this: TransformContext,
  code: string,
  id: string,
  options?: { moduleType?: string },
) => unknown;

/**
 * How many transform workers to start. One core stays with the bundler's own
 * thread; `SYNARA_WEB_TRANSFORM_WORKERS=0` keeps the pass on the main thread.
 */
export function transformWorkerCount(
  env: Readonly<Record<string, string | undefined>> = process.env,
  cores: number = availableParallelism(),
): number {
  const override = env.SYNARA_WEB_TRANSFORM_WORKERS?.trim();
  if (override) {
    const count = Number(override);
    if (!Number.isInteger(count) || count < 0)
      throw new Error(`Invalid SYNARA_WEB_TRANSFORM_WORKERS: ${override}`);
    return count;
  }
  return Math.max(0, Math.min(cores - 1, 8));
}

/**
 * Replaces `plugin.transform.handler` with one that runs the same plugin's
 * handler on a pool of worker threads.
 *
 * Each worker builds its own instance of the plugin from the same definition
 * and calls its unmodified handler, so a module compiles to the same output as
 * on the main thread; only which thread does the work changes. Nothing is
 * retried or skipped: a compile error is reported through the bundler exactly
 * once, and a worker that crashes or exits fails every transform it was given
 * and every later one. Workers start on the first transform.
 */
export function withParallelTransform<T extends { readonly name: string; transform?: unknown }>(
  plugin: T,
  options: { readonly workers: number; readonly createWorker: () => TransformWorker },
): T & { buildStart(): Promise<void>; closeBundle(): Promise<void> } {
  const hook = plugin.transform as { handler?: unknown } | null | undefined;
  if (typeof hook !== "object" || hook === null || typeof hook.handler !== "function") {
    throw new Error(`Plugin ${plugin.name} has no object transform hook to parallelize.`);
  }
  if (!Number.isInteger(options.workers) || options.workers < 1)
    throw new Error(`A transform pool needs at least one worker, got ${options.workers}.`);

  const queue: PendingTask[] = [];
  const pool: PoolWorker[] = [];
  let nextTaskId = 0;
  let poolFailure: Error | undefined;
  let termination: Promise<void> | undefined;
  const bundleClosed = new Error("Transform worker pool closed.");

  const failPool = (error: Error) => {
    poolFailure ??= error;
    if (termination) return termination;
    const workers = pool.splice(0);
    for (const entry of workers) {
      entry.current?.reject(poolFailure);
      entry.current = undefined;
    }
    for (const pending of queue.splice(0)) pending.reject(poolFailure);
    termination = Promise.allSettled(workers.map(({ worker }) => worker.terminate())).then(
      () => undefined,
    );
    return termination;
  };

  const dispatch = () => {
    for (const entry of pool) {
      if (entry.current) continue;
      const pending = queue.shift();
      if (!pending) return;
      nextTaskId += 1;
      entry.current = { ...pending, taskId: nextTaskId };
      entry.worker.ref();
      try {
        // oxlint-disable-next-line unicorn/require-post-message-target-origin
        entry.worker.postMessage({ taskId: nextTaskId, ...pending.task });
      } catch (cause) {
        void failPool(new Error("Could not dispatch a transform to its worker.", { cause }));
        return;
      }
    }
  };

  const startPool = () => {
    for (let index = 0; index < options.workers; index += 1) {
      const worker = options.createWorker();
      const entry: PoolWorker = { worker, current: undefined };
      worker.on("message", (reply) => {
        if (poolFailure) return;
        const current = entry.current;
        if (!current || current.taskId !== reply.taskId) {
          void failPool(new Error(`Transform worker answered task ${reply.taskId} out of turn.`));
          return;
        }
        if (reply.kind === "crash") {
          void failPool(
            new Error(`Transform worker crashed on ${current.task.id}: ${reply.message}`),
          );
          return;
        }
        entry.current = undefined;
        worker.unref();
        current.resolve(reply);
        dispatch();
      });
      worker.on("error", (error) => {
        void failPool(new Error(`Transform worker failed: ${String(error)}`, { cause: error }));
      });
      worker.on("exit", (code) => {
        void failPool(new Error(`Transform worker exited unexpectedly (code ${code}).`));
      });
      // An idle pool must not keep a finished build or test run alive.
      worker.unref();
      pool.push(entry);
    }
  };

  const run = (task: TransformTask) =>
    new Promise<WorkerReply>((resolve, reject) => {
      if (poolFailure) {
        reject(poolFailure);
        return;
      }
      queue.push({ task, resolve, reject });
      try {
        if (pool.length === 0) startPool();
        dispatch();
      } catch (cause) {
        void failPool(new Error("Could not start the transform worker pool.", { cause }));
      }
    });

  const parallelHandler: TransformHandler = async function (code, id, hookOptions) {
    const name = this.environment?.name;
    if (typeof name !== "string")
      throw new Error(`Plugin ${plugin.name} was called without a named environment.`);
    const consumer = this.environment?.config?.consumer;
    const reply = await run({
      code,
      id,
      moduleType: hookOptions?.moduleType,
      environment: { name, consumer: typeof consumer === "string" ? consumer : undefined },
    });
    if (reply.kind === "result") return reply.value ?? undefined;
    if (reply.kind === "transform-error") {
      const { stack, ...failure } = reply.error;
      return this.error({ ...failure, ...(stack ? { stack } : {}) });
    }
    throw new Error(`Transform worker crashed on ${id}: ${reply.message}`);
  };

  // The plugin mutates `transform.filter` on this same object after the config
  // resolves, so replace the handler in place instead of copying the hook.
  hook.handler = parallelHandler;
  return Object.assign(plugin, {
    async buildStart() {
      // Vite closes each watch output before it starts the next build.
      if (poolFailure === bundleClosed) {
        await termination;
        poolFailure = undefined;
        termination = undefined;
      }
    },
    closeBundle() {
      return failPool(bundleClosed);
    },
  });
}

/** Starts a real worker thread from a module URL. */
export function threadWorkerFactory(workerUrl: URL): () => TransformWorker {
  return () => new Worker(workerUrl) as unknown as TransformWorker;
}
