import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ReliabilityRecord } from "@synara/contracts";

import { ReliabilityReporter } from "./reliabilityReporter";

const roots: string[] = [];
const reporters: ReliabilityReporter[] = [];

function makeHome() {
  const homeDir = mkdtempSync(join(tmpdir(), "synara-reliability-"));
  roots.push(homeDir);
  return {
    homeDir,
    path: join(homeDir, "product-analytics", "reliability.json"),
  };
}

function makeReporter(homeDir: string, fetcher: typeof fetch) {
  const reporter = new ReliabilityReporter({
    homeDir,
    channel: "stable",
    appVersion: "1.5.1",
    platform: "darwin",
    fetcher,
  });
  reporters.push(reporter);
  return reporter;
}

function deferredResponse(): { promise: Promise<Response>; resolve: (response: Response) => void } {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function readQueue(path: string): ReliabilityRecord[] {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readBatch(init?: RequestInit): ReliabilityRecord[] {
  return JSON.parse(String(init?.body)).events;
}

function acknowledge(events: ReadonlyArray<ReliabilityRecord>): Response {
  return Response.json({ stored: true, acknowledged: events.map(({ id }) => id) });
}

const acknowledgeBatch = async (_url: RequestInfo | URL, init?: RequestInit) =>
  acknowledge(readBatch(init));

afterEach(() => {
  for (const reporter of reporters.splice(0)) reporter.dispose();
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("requires consent, rejects private input fields, and deletes unsent data on opt-out", async () => {
  const { homeDir, path } = makeHome();
  const fetcher = vi.fn(acknowledgeBatch);
  const reporter = makeReporter(homeDir, fetcher);

  reporter.track({ code: "app.main_unhandled" });
  await reporter.flush();
  expect(existsSync(path)).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();

  reporter.setEnabled(true);
  reporter.track({ code: "app.main_unhandled", threadId: "private thread" });
  reporter.track({ code: "private path" });
  reporter.track({ code: "backend.exit_after_ready", error: "private error" });
  reporter.track({ code: "chat.settlement_unavailable" });
  await reporter.flush();
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, init] = fetcher.mock.calls[0]!;
  expect(new URL(String(url)).pathname).toBe("/v1/reliability-events");
  expect(readBatch(init)).toEqual([
    {
      v: 1,
      id: expect.any(String),
      day: new Date().toISOString().slice(0, 10),
      code: "chat.settlement_unavailable",
      channel: "stable",
      appVersion: "1.5.1",
      platform: "darwin",
    },
  ]);

  reporter.track({ code: "app.renderer_crashed" });
  const orphan = `${path}.tmp-4321`;
  writeFileSync(orphan, "interrupted write");
  const unrelated = `${path}.unrelated`;
  writeFileSync(unrelated, "keep");
  expect(readQueue(path)).toHaveLength(1);

  reporter.setEnabled(false);
  expect(existsSync(path)).toBe(false);
  expect(existsSync(orphan)).toBe(false);
  expect(readFileSync(unrelated, "utf8")).toBe("keep");
  reporter.setEnabled(true);
  await reporter.flush();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("replays persisted receipts after restart and retains only unacknowledged records", async () => {
  vi.useFakeTimers();
  const { homeDir, path } = makeHome();
  const fetcher = vi
    .fn(acknowledgeBatch)
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockResolvedValueOnce(new Response(null, { status: 405 }))
    .mockImplementationOnce(async (_url, init) => {
      const [first] = readBatch(init);
      return Response.json({ stored: true, acknowledged: [first!.id, randomUUID()] });
    });
  const firstProcess = makeReporter(homeDir, fetcher);
  firstProcess.setEnabled(true);
  firstProcess.track({ code: "recovery.crash_resume_accepted" });
  firstProcess.track({ code: "backend.exit_after_ready" });
  const [first, second] = readQueue(path);
  expect(first?.id).not.toBe(second?.id);
  firstProcess.dispose();

  const restarted = makeReporter(homeDir, fetcher);
  restarted.setEnabled(true, { restorePending: true });
  await restarted.flush();
  expect(readBatch(fetcher.mock.calls[0]?.[1])).toEqual([first, second]);
  expect(readQueue(path)).toEqual([first, second]);

  await vi.advanceTimersByTimeAsync(1_000);
  expect(readBatch(fetcher.mock.calls[1]?.[1])).toEqual([first, second]);
  expect(readQueue(path)).toEqual([first, second]);

  await vi.advanceTimersByTimeAsync(2_000);
  expect(readBatch(fetcher.mock.calls[2]?.[1])).toEqual([first, second]);
  expect(readQueue(path)).toEqual([second]);

  await vi.advanceTimersByTimeAsync(1_000);
  expect(readBatch(fetcher.mock.calls[3]?.[1])).toEqual([second]);
  expect(readQueue(path)).toEqual([]);
  expect(fetcher).toHaveBeenCalledTimes(4);
});

it("a stale in-flight acknowledgement cannot alter the queue or upload in a new consent epoch", async () => {
  const { homeDir, path } = makeHome();
  const oldResponse = deferredResponse();
  const newResponse = deferredResponse();
  const fetcher = vi
    .fn(acknowledgeBatch)
    .mockImplementationOnce(() => oldResponse.promise)
    .mockImplementationOnce(() => newResponse.promise);
  const reporter = makeReporter(homeDir, fetcher);
  reporter.setEnabled(true);
  reporter.track({ code: "backend.exit_before_ready" });
  const oldFlush = reporter.flush();
  const oldRequest = fetcher.mock.calls[0]?.[1];
  const oldBatch = readBatch(oldRequest);

  reporter.setEnabled(false);
  expect(oldRequest?.signal?.aborted).toBe(true);
  expect(existsSync(path)).toBe(false);
  reporter.setEnabled(true);
  reporter.track({ code: "backend.spawn_failed" });
  const newFlush = reporter.flush();
  const newRequest = fetcher.mock.calls[1]?.[1];
  const newBatch = readBatch(newRequest);

  oldResponse.resolve(acknowledge(oldBatch));
  await oldFlush;
  expect(readQueue(path)).toEqual(newBatch);
  expect(newRequest?.signal?.aborted).toBe(false);
  await reporter.flush();
  expect(fetcher).toHaveBeenCalledTimes(2);

  newResponse.resolve(acknowledge(newBatch));
  await newFlush;
  expect(readQueue(path)).toEqual([]);
});

it("a new opt-in cannot restore data left behind by a failed opt-out cleanup", async () => {
  const { homeDir, path } = makeHome();
  const fetcher = vi.fn(acknowledgeBatch);
  const reporter = makeReporter(homeDir, fetcher);
  reporter.setEnabled(true);
  reporter.track({ code: "backend.spawn_failed" });
  const previous = readQueue(path);

  // Make the existing spool unavailable without deleting its bytes.
  const directory = dirname(path);
  const heldDirectory = join(homeDir, "held-product-analytics");
  renameSync(directory, heldDirectory);
  reporter.setEnabled(false);
  writeFileSync(directory, "blocks spool persistence");
  expect(() => reporter.setEnabled(true)).toThrow();
  reporter.track({ code: "app.renderer_crashed" });
  await reporter.flush();
  expect(fetcher).not.toHaveBeenCalled();

  rmSync(directory);
  renameSync(heldDirectory, directory);
  expect(readQueue(path)).toEqual(previous);
  reporter.setEnabled(true);
  expect(readQueue(path)).toEqual([]);
  reporter.track({ code: "chat.settlement_unavailable" });
  await reporter.flush();
  expect(fetcher).toHaveBeenCalledOnce();
  expect(readBatch(fetcher.mock.calls[0]?.[1]).map(({ code }) => code)).toEqual([
    "chat.settlement_unavailable",
  ]);
});

it("bounds the persisted queue and drains it in bounded batches", async () => {
  const { homeDir, path } = makeHome();
  const fetcher = vi.fn(acknowledgeBatch);
  const reporter = makeReporter(homeDir, fetcher);
  reporter.setEnabled(true);
  for (let index = 0; index < 5; index++) reporter.track({ code: "backend.spawn_failed" });
  for (let index = 0; index < 500; index++) reporter.track({ code: "backend.exit_after_ready" });
  const retained = readQueue(path);
  expect(retained).toHaveLength(500);
  expect(retained.every((record) => record.code === "backend.exit_after_ready")).toBe(true);

  await reporter.flush();
  await vi.waitFor(() => expect(readQueue(path)).toEqual([]));
  const payloads = fetcher.mock.calls.map(([, init]) => init);
  expect(payloads).toHaveLength(10);
  for (const init of payloads) {
    expect(readBatch(init)).toHaveLength(50);
    expect(Buffer.byteLength(String(init?.body))).toBeLessThanOrEqual(64 * 1024);
  }
  expect(payloads.flatMap(readBatch)).toEqual(retained);
});

it("expires unsent records on disk while the app stays open", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-11T12:00:00Z"));
  const { homeDir, path } = makeHome();
  const fetcher = vi.fn(async () => new Response(null, { status: 503 }));
  const reporter = makeReporter(homeDir, fetcher);
  reporter.setEnabled(true);
  reporter.track({ code: "backend.spawn_failed" });
  await reporter.flush();
  expect(fetcher).toHaveBeenCalledOnce();
  expect(readQueue(path)).toHaveLength(1);

  vi.setSystemTime(new Date("2026-11-19T12:00:00Z"));
  await vi.advanceTimersByTimeAsync(1_000);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(readQueue(path)).toEqual([]);
});

it("drops invalid, expired, future, and cross-channel records from persisted data", async () => {
  const { homeDir, path } = makeHome();
  const fetcher = vi.fn(acknowledgeBatch);
  const writer = makeReporter(homeDir, fetcher);
  writer.setEnabled(true);
  writer.track({ code: "chat.settlement_unavailable" });
  const [valid] = readQueue(path);
  writer.dispose();

  const persisted = [
    valid,
    { ...valid, id: randomUUID(), installId: "private installation" },
    { ...valid, id: randomUUID(), appVersion: "1.5.1+private" },
    { ...valid, id: randomUUID(), code: "private description" },
    { ...valid, id: randomUUID(), channel: "beta" },
    { ...valid, id: randomUUID(), day: "2000-01-01" },
    { ...valid, id: randomUUID(), day: "2999-01-01" },
  ];
  writeFileSync(path, JSON.stringify(persisted));
  const restarted = makeReporter(homeDir, fetcher);
  restarted.setEnabled(true, { restorePending: true });
  expect(readQueue(path)).toEqual([valid]);
  await restarted.flush();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(readBatch(fetcher.mock.calls[0]?.[1])).toEqual([valid]);

  restarted.dispose();
  writeFileSync(path, "malformed private spool");
  const afterCorruption = makeReporter(homeDir, fetcher);
  afterCorruption.setEnabled(true, { restorePending: true });
  expect(readQueue(path)).toEqual([]);
  await afterCorruption.flush();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
