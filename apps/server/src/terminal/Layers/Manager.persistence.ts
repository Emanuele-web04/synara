// Purpose: TerminalHistoryStore — debounced, atomic, per-terminal history
//   persistence for the terminal manager. Owns the pending-write buffer, debounce
//   timers, and serialized write queues; performs atomic temp-file-then-rename
//   writes, capped reads with legacy-path migration, and per-thread deletion.
// Layer: Stateful collaborator instantiated by TerminalManagerRuntime. The runtime
//   injects logsDir, history caps, debounce interval, and a logger; the store owns
//   all persist-related maps so the runtime no longer threads them through `this`.
// Exports: TerminalHistoryStore, TerminalHistoryStoreDeps.
import fs from "node:fs";
import path from "node:path";

import { DEFAULT_TERMINAL_ID } from "@t3tools/contracts";

import { createLogger } from "../../logger";
import { capHistoryByLimits } from "../terminalHistory";
import {
  legacySafeThreadId,
  sanitizePersistedTerminalHistory,
  toSafeTerminalId,
  toSafeThreadId,
  toSessionKey,
} from "./Manager.helpers";

export interface TerminalHistoryStoreDeps {
  logsDir: string;
  historyLineLimit: number;
  historyByteLimit: number;
  persistDebounceMs: number;
  logger: ReturnType<typeof createLogger>;
}

export class TerminalHistoryStore {
  private readonly persistQueues = new Map<string, Promise<void>>();
  private readonly persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pendingPersistHistory = new Map<string, string>();
  private persistTempCounter = 0;

  constructor(private readonly deps: TerminalHistoryStoreDeps) {}

  queuePersist(threadId: string, terminalId: string, history: string): void {
    const persistenceKey = toSessionKey(threadId, terminalId);
    this.pendingPersistHistory.set(persistenceKey, history);
    this.schedulePersist(threadId, terminalId);
  }

  async persistHistory(threadId: string, terminalId: string, history: string): Promise<void> {
    const persistenceKey = toSessionKey(threadId, terminalId);
    this.clearPersistTimer(threadId, terminalId);
    this.pendingPersistHistory.delete(persistenceKey);
    await this.enqueuePersistWrite(threadId, terminalId, history);
  }

  enqueuePersistWrite(threadId: string, terminalId: string, history: string): Promise<void> {
    const persistenceKey = toSessionKey(threadId, terminalId);
    const task = async () => {
      // Atomic replace: write a temp file then rename, so a crash mid-write can
      // never leave a torn history file. History is byte-capped, so this writes
      // at most ~historyByteLimit bytes regardless of total output volume.
      const finalPath = this.historyPath(threadId, terminalId);
      const tempPath = `${finalPath}.tmp-${process.pid}-${(this.persistTempCounter += 1)}`;
      try {
        await fs.promises.writeFile(tempPath, history, "utf8");
        await fs.promises.rename(tempPath, finalPath);
      } catch (error) {
        await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
        throw error;
      }
    };
    const previous = this.persistQueues.get(persistenceKey) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(task)
      .catch((error) => {
        this.deps.logger.warn("failed to persist terminal history", {
          threadId,
          terminalId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    this.persistQueues.set(persistenceKey, next);
    const finalized = next.finally(() => {
      if (this.persistQueues.get(persistenceKey) === next) {
        this.persistQueues.delete(persistenceKey);
      }
      if (
        this.pendingPersistHistory.has(persistenceKey) &&
        !this.persistTimers.has(persistenceKey)
      ) {
        this.schedulePersist(threadId, terminalId);
      }
    });
    void finalized.catch(() => undefined);
    return finalized;
  }

  private schedulePersist(threadId: string, terminalId: string): void {
    const persistenceKey = toSessionKey(threadId, terminalId);
    if (this.persistTimers.has(persistenceKey)) return;
    const timer = setTimeout(() => {
      this.persistTimers.delete(persistenceKey);
      const pendingHistory = this.pendingPersistHistory.get(persistenceKey);
      if (pendingHistory === undefined) return;
      this.pendingPersistHistory.delete(persistenceKey);
      void this.enqueuePersistWrite(threadId, terminalId, pendingHistory);
    }, this.deps.persistDebounceMs);
    this.persistTimers.set(persistenceKey, timer);
  }

  clearPersistTimer(threadId: string, terminalId: string): void {
    const persistenceKey = toSessionKey(threadId, terminalId);
    const timer = this.persistTimers.get(persistenceKey);
    if (!timer) return;
    clearTimeout(timer);
    this.persistTimers.delete(persistenceKey);
  }

  /** Drop the in-memory pending write for an evicted session and flush it to disk. */
  evictSession(threadId: string, terminalId: string, history: string): void {
    this.clearPersistTimer(threadId, terminalId);
    this.pendingPersistHistory.delete(toSessionKey(threadId, terminalId));
    void this.enqueuePersistWrite(threadId, terminalId, history);
  }

  async readHistory(threadId: string, terminalId: string): Promise<string> {
    const nextPath = this.historyPath(threadId, terminalId);
    try {
      const raw = await fs.promises.readFile(nextPath, "utf8");
      const capped = capHistoryByLimits(sanitizePersistedTerminalHistory(raw), {
        maxLines: this.deps.historyLineLimit,
        maxBytes: this.deps.historyByteLimit,
      });
      if (capped !== raw) {
        await fs.promises.writeFile(nextPath, capped, "utf8");
      }
      return capped;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    if (terminalId !== DEFAULT_TERMINAL_ID) {
      return "";
    }

    const legacyPath = this.legacyHistoryPath(threadId);
    try {
      const raw = await fs.promises.readFile(legacyPath, "utf8");
      const capped = capHistoryByLimits(sanitizePersistedTerminalHistory(raw), {
        maxLines: this.deps.historyLineLimit,
        maxBytes: this.deps.historyByteLimit,
      });

      // Migrate legacy transcript filename to the terminal-scoped path.
      await fs.promises.writeFile(nextPath, capped, "utf8");
      try {
        await fs.promises.rm(legacyPath, { force: true });
      } catch (cleanupError) {
        this.deps.logger.warn("failed to remove legacy terminal history", {
          threadId,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }

      return capped;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return "";
      }
      throw error;
    }
  }

  async deleteHistory(threadId: string, terminalId: string): Promise<void> {
    const deletions = [fs.promises.rm(this.historyPath(threadId, terminalId), { force: true })];
    if (terminalId === DEFAULT_TERMINAL_ID) {
      deletions.push(fs.promises.rm(this.legacyHistoryPath(threadId), { force: true }));
    }
    try {
      await Promise.all(deletions);
    } catch (error) {
      this.deps.logger.warn("failed to delete terminal history", {
        threadId,
        terminalId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async flushPersistQueue(threadId: string, terminalId: string): Promise<void> {
    const persistenceKey = toSessionKey(threadId, terminalId);
    this.clearPersistTimer(threadId, terminalId);

    while (true) {
      const pendingHistory = this.pendingPersistHistory.get(persistenceKey);
      if (pendingHistory !== undefined) {
        this.pendingPersistHistory.delete(persistenceKey);
        await this.enqueuePersistWrite(threadId, terminalId, pendingHistory);
      }

      const pending = this.persistQueues.get(persistenceKey);
      if (!pending) {
        return;
      }
      await pending.catch(() => undefined);
    }
  }

  async deleteAllHistoryForThread(threadId: string): Promise<void> {
    const threadPrefix = `${toSafeThreadId(threadId)}_`;
    try {
      const entries = await fs.promises.readdir(this.deps.logsDir, { withFileTypes: true });
      const removals = entries
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .filter(
          (name) =>
            name === `${toSafeThreadId(threadId)}.log` ||
            name === `${legacySafeThreadId(threadId)}.log` ||
            name.startsWith(threadPrefix),
        )
        .map((name) => fs.promises.rm(path.join(this.deps.logsDir, name), { force: true }));
      await Promise.all(removals);
    } catch (error) {
      this.deps.logger.warn("failed to delete terminal histories for thread", {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Cancel all debounce timers and drop in-memory buffers. */
  dispose(): void {
    for (const timer of this.persistTimers.values()) {
      clearTimeout(timer);
    }
    this.persistTimers.clear();
    this.pendingPersistHistory.clear();
    this.persistQueues.clear();
  }

  private historyPath(threadId: string, terminalId: string): string {
    const threadPart = toSafeThreadId(threadId);
    if (terminalId === DEFAULT_TERMINAL_ID) {
      return path.join(this.deps.logsDir, `${threadPart}.log`);
    }
    return path.join(this.deps.logsDir, `${threadPart}_${toSafeTerminalId(terminalId)}.log`);
  }

  private legacyHistoryPath(threadId: string): string {
    return path.join(this.deps.logsDir, `${legacySafeThreadId(threadId)}.log`);
  }
}
