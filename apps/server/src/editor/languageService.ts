import { realpath } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import type { EditorIntelligenceInput, EditorIntelligenceResult } from "@synara/contracts";

type Pending = {
  resolve: (value: EditorIntelligenceResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
type Session = {
  worker: Worker;
  pending: Map<number, Pending>;
  touched: number;
  stallTimer?: ReturnType<typeof setTimeout> | undefined;
};
// A request that outlives its deadline is rejected on its own; the worker keeps
// its parsed project. Only a worker that has answered nothing for this long
// while work was pending is treated as stuck and replaced.
const REQUEST_DEADLINE_MS = 15_000;
const WORKER_STALL_MS = 60_000;

/** One isolated compiler per RPC client/workspace; lazy, bounded and read-only. */
export class EditorLanguageService {
  private sessions = new Map<string, Session>();
  private nextId = 0;
  private disposed = false;
  private sweep = setInterval(() => {
    for (const [key, session] of this.sessions) {
      if (!session.pending.size && Date.now() - session.touched > 120_000)
        this.close(key, new Error("Language service was idle."));
    }
  }, 30_000).unref();

  private close(key: string, error: Error) {
    const session = this.sessions.get(key);
    if (!session) return;
    this.sessions.delete(key);
    clearTimeout(session.stallTimer);
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    session.pending.clear();
    void session.worker.terminate();
  }

  private watchWorker(key: string, session: Session) {
    clearTimeout(session.stallTimer);
    session.stallTimer = undefined;
    if (!session.pending.size) return;
    session.stallTimer = setTimeout(() => {
      if (this.sessions.get(key) === session)
        this.close(key, new Error("Language service stopped responding."));
    }, WORKER_STALL_MS).unref();
  }

  async request(
    clientId: string,
    input: EditorIntelligenceInput,
    signal?: AbortSignal,
  ): Promise<EditorIntelligenceResult> {
    if (this.disposed || signal?.aborted) throw new Error("Language request was cancelled.");
    if (input.documents.reduce((size, document) => size + document.contents.length, 0) > 8_000_000)
      throw new Error("Open code snapshots exceed the language service memory limit.");
    const root = await realpath(input.cwd);
    if (this.disposed || signal?.aborted) throw new Error("Language request was cancelled.");
    const key = JSON.stringify([clientId, root]);
    let session = this.sessions.get(key);
    if (!session) {
      if (this.sessions.size >= 4) {
        const idle = [...this.sessions]
          .filter(([, value]) => value.pending.size === 0)
          .sort((a, b) => a[1].touched - b[1].touched)[0];
        if (!idle) throw new Error("Language services are busy. Try again shortly.");
        this.close(idle[0], new Error("Language service was released."));
      }
      const source = import.meta.url.endsWith(".ts");
      const worker = new Worker(
        new URL(source ? "./languageWorker.ts" : "./languageWorker.mjs", import.meta.url),
        {
          workerData: { root },
          resourceLimits: { maxOldGenerationSizeMb: 512 },
        },
      );
      session = { worker, pending: new Map(), touched: Date.now() };
      this.sessions.set(key, session);
      const owned = session;
      worker.on(
        "message",
        (message: { id: number; result?: EditorIntelligenceResult; error?: string }) => {
          const pending = owned.pending.get(message.id);
          if (!pending) return;
          owned.pending.delete(message.id);
          clearTimeout(pending.timer);
          this.watchWorker(key, owned);
          if (message.error || !message.result)
            pending.reject(new Error(message.error ?? "Invalid language service response."));
          else pending.resolve(message.result);
        },
      );
      worker.on("error", (error) => {
        if (this.sessions.get(key) === owned) this.close(key, error);
      });
      worker.on("exit", () => {
        if (this.sessions.get(key) === owned)
          this.close(key, new Error("Language service exited."));
      });
    }
    if (session.pending.size >= 16) throw new Error("Too many pending language requests.");
    session.touched = Date.now();
    const id = ++this.nextId;
    const owned = session;
    return new Promise((resolve, reject) => {
      const abort = () => {
        const pending = owned.pending.get(id);
        // Keep the job counted until the worker replies or is closed.
        // Otherwise cancelled requests could flood the worker's message queue without limit.
        if (pending) pending.reject(new Error("Language request was cancelled."));
      };
      const finish = () => signal?.removeEventListener("abort", abort);
      const timer = setTimeout(() => {
        const pending = owned.pending.get(id);
        if (!pending) return;
        pending.reject(new Error("Language service exceeded its 15-second deadline."));
      }, REQUEST_DEADLINE_MS);
      owned.pending.set(id, {
        timer,
        resolve: (value) => {
          finish();
          resolve(value);
        },
        reject: (error) => {
          finish();
          reject(error);
        },
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        clearTimeout(timer);
        owned.pending.delete(id);
        finish();
        reject(new Error("Language request was cancelled."));
        return;
      }
      try {
        owned.worker.postMessage({ id, input: { ...input, cwd: root } });
        if (owned.pending.size === 1) this.watchWorker(key, owned);
      } catch (error) {
        clearTimeout(timer);
        owned.pending.delete(id);
        finish();
        reject(error);
      }
    });
  }

  dispose() {
    this.disposed = true;
    clearInterval(this.sweep);
    for (const key of this.sessions.keys())
      this.close(key, new Error("Language service shut down."));
  }
}
