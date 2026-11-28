// FILE: SecretRequestGate.ts
// Purpose: Holds pending agent secret requests in memory and delivers each answer
//          straight to an owner-only file. The value never enters orchestration
//          events, projections, logs, or the agent's context; the agent learns the
//          file path only.
// Layer: server runtime (shared by the Agent Gateway tool and the WS answer handler)

import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  SECRET_FILE_TTL_MS,
  type SecretRequestAnswerInput,
  type SecretRequestStatus,
} from "@synara/contracts";

import { ensurePrivateDirectorySync, PRIVATE_FILE_MODE } from "../privatePathPermissions.ts";

export const SECRET_REQUEST_THREAD_LIMIT = 4;
const SECRET_FILE_NAME_PATTERN = /^[0-9a-f]{32}(\.partial)?$/;

export type SecretRequestOutcome =
  | { readonly status: "saved"; readonly file: string }
  | { readonly status: Exclude<SecretRequestStatus, "saved"> };

interface PendingSecretRequest {
  readonly threadId: string;
  readonly filesDir: string;
  /** False when the request already settled (Stop, timeout, or another answer). */
  readonly settle: (outcome: SecretRequestOutcome) => boolean;
  readonly isOpen: () => boolean;
}

export class SecretRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretRequestError";
  }
}

/** Writes one secret to a fresh owner-only file and returns its path. */
export async function writeSecretFile(filesDir: string, value: string): Promise<string> {
  ensurePrivateDirectorySync(filesDir);
  const file = path.join(filesDir, randomBytes(16).toString("hex"));
  const partial = `${file}.partial`;
  try {
    // `wx` never follows or replaces an existing path.
    await fs.writeFile(partial, value, { flag: "wx", mode: PRIVATE_FILE_MODE, encoding: "utf8" });
    await fs.rename(partial, file);
  } catch (cause) {
    await fs.rm(partial, { force: true }).catch(() => undefined);
    throw cause;
  }
  return file;
}

/** Deletes secret files older than the TTL, plus any leftover partial writes. */
export async function sweepExpiredSecretFiles(filesDir: string, now = Date.now()): Promise<number> {
  let names: string[];
  try {
    names = await fs.readdir(filesDir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!SECRET_FILE_NAME_PATTERN.test(name)) continue;
    const file = path.join(filesDir, name);
    try {
      const stat = await fs.lstat(file);
      if (now - stat.mtimeMs <= SECRET_FILE_TTL_MS) continue;
      await fs.rm(file, { force: true });
      removed += 1;
    } catch {
      // Already gone or unreadable; the next sweep retries.
    }
  }
  return removed;
}

export class SecretRequestGate {
  private readonly pending = new Map<string, PendingSecretRequest>();

  /**
   * Publishes a card and waits for the user's answer, the timeout, or the
   * caller's signal (Stop, turn end, server shutdown). `onSettled` runs once
   * with the final status so the card can close.
   */
  async request(input: {
    readonly threadId: string;
    readonly filesDir: string;
    readonly timeoutMs: number;
    readonly signal: AbortSignal;
    readonly publish: (requestId: string) => Promise<void>;
    readonly onSettled: (requestId: string, status: SecretRequestStatus) => Promise<void>;
  }): Promise<SecretRequestOutcome> {
    input.signal.throwIfAborted();
    let threadPending = 0;
    for (const pending of this.pending.values()) {
      if (pending.threadId === input.threadId) threadPending += 1;
    }
    if (threadPending >= SECRET_REQUEST_THREAD_LIMIT) {
      throw new SecretRequestError(
        "Too many secret requests are waiting in this chat; wait for one to be answered.",
      );
    }
    const requestId = `secret:${randomUUID()}`;
    let resolveAnswer!: (outcome: SecretRequestOutcome) => void;
    const answered = new Promise<SecretRequestOutcome>((resolve) => {
      resolveAnswer = resolve;
    });
    let settled = false;
    const settle = (next: SecretRequestOutcome): boolean => {
      if (settled) return false;
      settled = true;
      resolveAnswer(next);
      return true;
    };
    this.pending.set(requestId, {
      threadId: input.threadId,
      filesDir: input.filesDir,
      settle,
      isOpen: () => !settled,
    });
    const cancel = () => void settle({ status: "cancelled" });
    input.signal.addEventListener("abort", cancel, { once: true });
    const timeout = setTimeout(() => void settle({ status: "timed_out" }), input.timeoutMs);
    timeout.unref?.();
    let outcome: SecretRequestOutcome = { status: "cancelled" };
    try {
      await input.publish(requestId);
      outcome = await answered;
      return outcome;
    } finally {
      clearTimeout(timeout);
      input.signal.removeEventListener("abort", cancel);
      // Settle first so an answer still writing its file sees it lost and removes it.
      settle({ status: "cancelled" });
      this.pending.delete(requestId);
      await input.onSettled(requestId, outcome.status).catch(() => undefined);
    }
  }

  /** Delivers the user's answer. Throws when the request is gone or another chat's. */
  async answer(input: SecretRequestAnswerInput): Promise<void> {
    const pending = this.pending.get(input.requestId);
    if (!pending || pending.threadId !== input.threadId) {
      throw new SecretRequestError(
        "This secret request is no longer waiting. The agent stopped or the request timed out.",
      );
    }
    if (input.answer.type === "decline") {
      this.pending.delete(input.requestId);
      pending.settle({ status: "declined" });
      return;
    }
    // Claim before the write so a second click cannot write a second file.
    this.pending.delete(input.requestId);
    let file: string;
    try {
      file = await writeSecretFile(pending.filesDir, input.answer.secret);
    } catch {
      // Let the user try again on the same card, unless Stop or the timeout closed it meanwhile.
      if (pending.isOpen()) this.pending.set(input.requestId, pending);
      throw new SecretRequestError("Could not store the secret. Try again.");
    }
    if (!pending.settle({ status: "saved", file })) {
      // Stop or the timeout won while the file was written; no one will read it.
      await fs.rm(file, { force: true }).catch(() => undefined);
      throw new SecretRequestError(
        "This secret request is no longer waiting. The agent stopped or the request timed out.",
      );
    }
  }
}

export const secretRequestGate = new SecretRequestGate();
