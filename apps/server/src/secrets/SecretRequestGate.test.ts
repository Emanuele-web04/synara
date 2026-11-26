import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ThreadId } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SECRET_REQUEST_THREAD_LIMIT,
  SecretRequestGate,
  sweepExpiredSecretFiles,
} from "./SecretRequestGate.ts";

const THREAD = "thread-secret";

let root: string;
let filesDir: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "synara-secret-gate-"));
  filesDir = path.join(root, "requests");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function startRequest(
  gate: SecretRequestGate,
  options: { signal?: AbortSignal; timeoutMs?: number; threadId?: string } = {},
) {
  const settled: string[] = [];
  let resolvePublished!: (requestId: string) => void;
  const published = new Promise<string>((resolve) => {
    resolvePublished = resolve;
  });
  const outcome = gate.request({
    threadId: options.threadId ?? THREAD,
    filesDir,
    timeoutMs: options.timeoutMs ?? 60_000,
    signal: options.signal ?? new AbortController().signal,
    publish: async (requestId) => resolvePublished(requestId),
    onSettled: async (_requestId, status) => void settled.push(status),
  });
  return { outcome, published, settled };
}

const answerInput = (requestId: string, secret: string, threadId = THREAD) => ({
  threadId: ThreadId.makeUnsafe(threadId),
  requestId,
  answer: { type: "save" as const, secret },
});

describe("SecretRequestGate", () => {
  it("writes the saved value to an owner-only file and returns only its path", async () => {
    const gate = new SecretRequestGate();
    const { outcome, published, settled } = startRequest(gate);
    const requestId = await published;
    await gate.answer(answerInput(requestId, "hunter2 with spaces"));
    const result = await outcome;
    expect(result.status).toBe("saved");
    if (result.status !== "saved") return;
    expect(path.dirname(result.file)).toBe(filesDir);
    expect(await readFile(result.file, "utf8")).toBe("hunter2 with spaces");
    if (process.platform !== "win32") {
      expect((await stat(result.file)).mode & 0o777).toBe(0o600);
      expect((await stat(filesDir)).mode & 0o777).toBe(0o700);
    }
    expect(settled).toEqual(["saved"]);
  });

  it("reports a decline without writing anything", async () => {
    const gate = new SecretRequestGate();
    const { outcome, published, settled } = startRequest(gate);
    const requestId = await published;
    await gate.answer({
      threadId: ThreadId.makeUnsafe(THREAD),
      requestId,
      answer: { type: "decline" },
    });
    expect(await outcome).toEqual({ status: "declined" });
    expect(settled).toEqual(["declined"]);
    expect(await readdir(filesDir).catch(() => [])).toEqual([]);
  });

  it("refuses an answer from another chat", async () => {
    const gate = new SecretRequestGate();
    const controller = new AbortController();
    const { outcome, published } = startRequest(gate, { signal: controller.signal });
    const requestId = await published;
    await expect(gate.answer(answerInput(requestId, "x", "other-thread"))).rejects.toThrow(
      /no longer waiting/,
    );
    controller.abort();
    expect(await outcome).toEqual({ status: "cancelled" });
  });

  it("cancels when the caller's signal aborts and rejects a late answer", async () => {
    const gate = new SecretRequestGate();
    const controller = new AbortController();
    const { outcome, published, settled } = startRequest(gate, { signal: controller.signal });
    const requestId = await published;
    controller.abort();
    expect(await outcome).toEqual({ status: "cancelled" });
    expect(settled).toEqual(["cancelled"]);
    await expect(gate.answer(answerInput(requestId, "late"))).rejects.toThrow(/no longer waiting/);
    expect(await readdir(filesDir).catch(() => [])).toEqual([]);
  });

  it("frees the slot when a failed write races Stop", async () => {
    const gate = new SecretRequestGate();
    // A regular file where the directory should be makes every write fail.
    await writeFile(filesDir, "not a directory");
    const controller = new AbortController();
    const { outcome, published } = startRequest(gate, { signal: controller.signal });
    const requestId = await published;
    // Stop lands first; the request closes while the answer's write is failing.
    controller.abort();
    const answer = gate.answer(answerInput(requestId, "x"));
    await expect(answer).rejects.toThrow(/Could not store/);
    expect(await outcome).toEqual({ status: "cancelled" });
    await rm(filesDir, { force: true });
    // The failed answer left no stale entry, so the full per-chat limit is free again.
    const later = new AbortController();
    const next = Array.from({ length: SECRET_REQUEST_THREAD_LIMIT }, () =>
      startRequest(gate, { signal: later.signal }),
    );
    await Promise.all(next.map((request) => request.published));
    later.abort();
    expect(await Promise.all(next.map((request) => request.outcome))).toEqual(
      next.map(() => ({ status: "cancelled" })),
    );
  });

  it("times out without an answer", async () => {
    const gate = new SecretRequestGate();
    const { outcome } = startRequest(gate, { timeoutMs: 5 });
    expect(await outcome).toEqual({ status: "timed_out" });
  });

  it("limits how many requests wait in one chat", async () => {
    const gate = new SecretRequestGate();
    const controller = new AbortController();
    const waiting = Array.from({ length: SECRET_REQUEST_THREAD_LIMIT }, () =>
      startRequest(gate, { signal: controller.signal }),
    );
    await Promise.all(waiting.map((request) => request.published));
    await expect(startRequest(gate).outcome).rejects.toThrow(/Too many secret requests/);
    controller.abort();
    await Promise.all(waiting.map((request) => request.outcome));
  });

  it("sweeps files older than a day and keeps fresh ones", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(filesDir, { recursive: true });
    const oldFile = path.join(filesDir, "a".repeat(32));
    const freshFile = path.join(filesDir, "b".repeat(32));
    const unrelated = path.join(filesDir, "keep-me.txt");
    await Promise.all([oldFile, freshFile, unrelated].map((file) => writeFile(file, "x")));
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await utimes(oldFile, twoDaysAgo, twoDaysAgo);
    await utimes(unrelated, twoDaysAgo, twoDaysAgo);
    expect(await sweepExpiredSecretFiles(filesDir)).toBe(1);
    expect((await readdir(filesDir)).toSorted()).toEqual(
      [path.basename(freshFile), "keep-me.txt"].toSorted(),
    );
  });
});
