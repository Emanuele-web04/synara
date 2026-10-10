import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

function noop(): void {}

interface ThreadControlState {
  readonly disabled: boolean;
  readonly generation: number;
  readonly chatGeneration?: number;
}

/** Frozen request generations prevent old queued consent from surviving a disable. */
export class ComputerControlState {
  private readonly threads = new Map<string, ThreadControlState>();
  private writes = Promise.resolve();
  /**
   * Per-thread operation chain. Queued-dispatch and edit-resend admissions for
   * the same thread race through admitControl concurrently; without
   * serialization their read-modify-write sequences interleave and the last
   * writer silently wins. Chaining keeps every mutation ordered per thread
   * while reads stay synchronous. Entries are removed once their tail settles
   * so threads do not accumulate here beyond the threads map itself.
   */
  private readonly threadChains = new Map<string, Promise<void>>();
  private loadError: Error | undefined;

  constructor(private readonly filePath?: string) {
    if (!filePath) return;
    try {
      const data: unknown = JSON.parse(readFileSync(filePath, "utf8"));
      if (typeof data !== "object" || data === null || Array.isArray(data))
        throw new Error("Invalid state structure.");
      for (const [threadId, value] of Object.entries(data)) {
        const state = value as Partial<ThreadControlState> | null;
        if (
          state === null ||
          typeof state !== "object" ||
          typeof state.disabled !== "boolean" ||
          !Number.isSafeInteger(state.generation) ||
          (state.generation ?? -1) < 0 ||
          (state.chatGeneration !== undefined &&
            (!Number.isSafeInteger(state.chatGeneration) || state.chatGeneration < 0))
        )
          throw new Error("Invalid thread authorization state.");
        this.threads.set(threadId, state as ThreadControlState);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      // A broken consent file disables Computer, not ordinary coding or server boot.
      this.loadError = new Error(
        "Computer authorization state could not be loaded; control remains disabled.",
        { cause: error },
      );
    }
  }

  get(threadId: string): ThreadControlState {
    if (this.loadError) return { disabled: true, generation: 0 };
    return this.threads.get(threadId) ?? { disabled: false, generation: 0 };
  }

  allows(threadId: string, generation: number): boolean {
    const state = this.get(threadId);
    return !state.disabled && generation === state.generation;
  }

  set(threadId: string, disabled: boolean): Promise<void> {
    if (this.loadError) return Promise.reject(this.loadError);
    const previous = this.get(threadId);
    if (!disabled && !previous.disabled) return Promise.resolve();
    return this.serialize(threadId, () => {
      const current = this.get(threadId);
      if (!disabled && !current.disabled) return Promise.resolve();
      this.threads.set(threadId, {
        disabled,
        generation: current.generation + (disabled ? 1 : 0),
      });
      return this.persist();
    });
  }

  recordChatIntent(threadId: string, enabled: boolean, generation: number): Promise<void> {
    if (this.loadError) return enabled ? Promise.reject(this.loadError) : Promise.resolve();
    return this.serialize(threadId, () => {
      const previous = this.get(threadId);
      const chatGeneration = enabled && this.allows(threadId, generation) ? generation : undefined;
      if (previous.chatGeneration === chatGeneration) return Promise.resolve();
      const next = {
        disabled: previous.disabled,
        generation: previous.generation,
        ...(chatGeneration !== undefined ? { chatGeneration } : {}),
      };
      this.threads.set(threadId, next);
      return this.persist().catch((error) => {
        if (this.threads.get(threadId) === next) {
          this.threads.set(threadId, { disabled: next.disabled, generation: next.generation });
        }
        throw error;
      });
    });
  }

  /**
   * Runs the operation after every earlier operation for this thread settles,
   * successfully or not. The returned promise settles exactly like the
   * operation itself; the stored tail never rejects so a failure cannot stall
   * later work.
   */
  private serialize(threadId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.threadChains.get(threadId) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    const tail = next.then(noop, noop);
    this.threadChains.set(threadId, tail);
    void tail.then(() => {
      if (this.threadChains.get(threadId) === tail) this.threadChains.delete(threadId);
    });
    return next;
  }

  private persist(): Promise<void> {
    if (!this.filePath) return Promise.resolve();
    const filePath = this.filePath;
    const content = JSON.stringify(Object.fromEntries(this.threads));
    const write = this.writes
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
        const temporaryPath = `${filePath}.tmp`;
        await writeFile(temporaryPath, content, { mode: 0o600 });
        await rename(temporaryPath, filePath);
      });
    this.writes = write;
    return write;
  }
}
