// FILE: providerUsageSnapshot.test.ts
// Purpose: Verifies provider usage scans stay bounded for large local archives.
// Layer: Server provider usage tests

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  readClaudeUsageSamples,
  readCodexSessionSummary,
  readRecentClaudeUsageSamples,
} from "./providerUsageSnapshot";

const tempDirs: string[] = [];

function tokenCountLine(timestamp: string, totalTokens: number, note?: string): string {
  return JSON.stringify({
    timestamp,
    ...(note ? { note } : {}),
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: { total_tokens: totalTokens } },
      rate_limits: {
        primary: { used_percent: 25, window_minutes: 300 },
      },
    },
  });
}

async function makeSessionFile(contents: string, name = "rollout.jsonl"): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "synara-provider-usage-"));
  tempDirs.push(dir);
  const file = path.join(dir, name);
  await fs.writeFile(file, contents);
  return file;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("readCodexSessionSummary", () => {
  it("reads the latest token count from the file tail without readFile", async () => {
    const file = await makeSessionFile(
      [
        tokenCountLine("2026-08-13T10:00:00.000Z", 100),
        JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }),
        tokenCountLine("2026-08-14T10:00:00.000Z", 250),
        "not-json",
      ].join("\n"),
    );
    const probe = await fs.open(file, "r");
    const handlePrototype: Pick<typeof probe, "read"> = Object.getPrototypeOf(probe);
    await probe.close();
    const read = vi.spyOn(handlePrototype, "read");
    const readFile = vi.spyOn(fs, "readFile");

    await expect(readCodexSessionSummary(file)).resolves.toEqual({
      timestampMs: Date.parse("2026-08-14T10:00:00.000Z"),
      totalTokens: 250,
      limits: [{ window: "5h", usedPercent: 25, windowDurationMins: 300 }],
    });
    expect(readFile).not.toHaveBeenCalled();
    const positionalReadCalls = read.mock.calls as unknown as readonly (readonly [
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number | null,
    ])[];
    expect(positionalReadCalls.every(([, , length]) => length <= 64 * 1024)).toBe(true);
  });

  it("parses a CRLF token record split across read chunks", async () => {
    const tokenLine = tokenCountLine("2026-08-14T10:00:00.000Z", 250, "café 🧠");
    const trailingLength = 64 * 1024 - Math.floor(Buffer.byteLength(tokenLine) / 2) - 2;
    const file = await makeSessionFile(`ignored\r\n${tokenLine}\r\n${"x".repeat(trailingLength)}`);

    await expect(readCodexSessionSummary(file)).resolves.toMatchObject({
      timestampMs: Date.parse("2026-08-14T10:00:00.000Z"),
      totalTokens: 250,
    });
  });

  it("skips an oversized trailing record without retaining it in memory", async () => {
    const file = await makeSessionFile(
      `${tokenCountLine("2026-08-14T10:00:00.000Z", 250)}\n${"x".repeat(2 * 1024 * 1024)}`,
    );

    await expect(readCodexSessionSummary(file)).resolves.toMatchObject({
      timestampMs: Date.parse("2026-08-14T10:00:00.000Z"),
      totalTokens: 250,
    });
  });
});

function assistantLine(input: {
  timestamp: string;
  totalTokens: number;
  sessionId?: string;
  messageId?: string;
}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: input.timestamp,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    message: {
      ...(input.messageId ? { id: input.messageId } : {}),
      model: "claude-opus-4-5",
      usage: { input_tokens: input.totalTokens, output_tokens: 0 },
    },
  });
}

describe("readClaudeUsageSamples", () => {
  it("reads samples from the transcript stream without readFile", async () => {
    // A record carrying no session or message id falls back to its line number, so the
    // blank line has to keep its place in the count for that key to stay stable.
    const file = await makeSessionFile(
      [
        JSON.stringify({ type: "user", timestamp: "2026-08-14T09:00:00.000Z" }),
        "",
        assistantLine({ timestamp: "2026-08-14T10:00:00.000Z", totalTokens: 40 }),
        assistantLine({
          timestamp: "2026-08-14T11:00:00.000Z",
          totalTokens: 60,
          sessionId: "session-a",
          messageId: "message-a",
        }),
        "not-json",
      ].join("\n"),
      "transcript.jsonl",
    );
    const readFile = vi.spyOn(fs, "readFile");

    await expect(readClaudeUsageSamples(file)).resolves.toEqual([
      {
        sessionId: `${file}:2`,
        timestampMs: Date.parse("2026-08-14T10:00:00.000Z"),
        totalTokens: 40,
        model: "claude-opus-4-5",
      },
      {
        sessionId: "session-a",
        timestampMs: Date.parse("2026-08-14T11:00:00.000Z"),
        totalTokens: 60,
        model: "claude-opus-4-5",
      },
    ]);
    expect(readFile).not.toHaveBeenCalled();
  });

  it("returns no samples for a missing transcript", async () => {
    const file = await makeSessionFile("", "transcript.jsonl");

    await expect(readClaudeUsageSamples(`${file}.absent`)).resolves.toEqual([]);
  });

  it("skips an oversized record and resumes at the next line", async () => {
    const oversizedAssistantLine = JSON.stringify({
      type: "assistant",
      timestamp: "2026-08-14T10:30:00.000Z",
      message: {
        model: "claude-opus-4-5",
        content: "x".repeat(2 * 1024 * 1024),
        usage: { input_tokens: 50, output_tokens: 0 },
      },
    });
    const file = await makeSessionFile(
      [
        assistantLine({ timestamp: "2026-08-14T10:00:00.000Z", totalTokens: 40 }),
        oversizedAssistantLine,
        assistantLine({ timestamp: "2026-08-14T11:00:00.000Z", totalTokens: 60 }),
      ].join("\n"),
      "transcript.jsonl",
    );

    await expect(readClaudeUsageSamples(file)).resolves.toEqual([
      {
        sessionId: `${file}:0`,
        timestampMs: Date.parse("2026-08-14T10:00:00.000Z"),
        totalTokens: 40,
        model: "claude-opus-4-5",
      },
      {
        sessionId: `${file}:2`,
        timestampMs: Date.parse("2026-08-14T11:00:00.000Z"),
        totalTokens: 60,
        model: "claude-opus-4-5",
      },
    ]);
  });
});

const recentIso = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();

async function makeProjectsRoot(): Promise<{ root: string; projectDir: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-claude-projects-"));
  tempDirs.push(root);
  const projectDir = path.join(root, "project-a");
  await fs.mkdir(projectDir);
  return { root, projectDir };
}

function line(hoursAgo: number, totalTokens: number, messageId: string): string {
  return `${assistantLine({
    timestamp: recentIso(hoursAgo),
    totalTokens,
    sessionId: "session-a",
    messageId,
  })}\n`;
}

function totalTokens(samples: ReadonlyArray<{ totalTokens: number }>): number {
  return samples.reduce((total, sample) => total + sample.totalTokens, 0);
}

// Bumps mtime past filesystem timestamp granularity so a rewrite is always observable.
async function touchLater(file: string): Promise<void> {
  const later = new Date(Date.now() + 5_000);
  await fs.utimes(file, later, later);
}

describe("readRecentClaudeUsageSamples", () => {
  it("does not reopen unchanged transcripts on a later pass", async () => {
    const { root, projectDir } = await makeProjectsRoot();
    await fs.writeFile(path.join(projectDir, "a.jsonl"), line(2, 40, "m1") + line(1, 60, "m2"));
    await fs.writeFile(path.join(projectDir, "b.jsonl"), line(3, 5, "m3"));

    const first = await readRecentClaudeUsageSamples(root);
    expect(totalTokens(first)).toBe(105);

    const open = vi.spyOn(fs, "open");
    const second = await readRecentClaudeUsageSamples(root);
    expect(open).not.toHaveBeenCalled();
    expect(second).toEqual(first);
  });

  it("parses only appended records and keeps deduping across the boundary", async () => {
    const { root, projectDir } = await makeProjectsRoot();
    const file = path.join(projectDir, "a.jsonl");
    const prefix = line(2, 40, "m1");
    await fs.writeFile(file, prefix);
    await readRecentClaudeUsageSamples(root);

    // The repeated m1 record is the SDK writing another content block of the same message.
    await fs.appendFile(file, line(2, 40, "m1") + line(1, 60, "m2"));
    await touchLater(file);
    const probe = await fs.open(file, "r");
    const handlePrototype = Object.getPrototypeOf(probe) as Pick<typeof probe, "createReadStream">;
    await probe.close();
    const createReadStream = vi.spyOn(handlePrototype, "createReadStream");

    const samples = await readRecentClaudeUsageSamples(root);
    expect(samples.map((sample) => sample.totalTokens)).toEqual([40, 60]);
    expect(createReadStream).toHaveBeenCalledTimes(1);
    expect(createReadStream.mock.calls[0]?.[0]).toMatchObject({
      start: Buffer.byteLength(prefix),
    });
  });

  it("reparses a transcript that was truncated or replaced", async () => {
    const { root, projectDir } = await makeProjectsRoot();
    const file = path.join(projectDir, "a.jsonl");
    await fs.writeFile(file, line(3, 40, "m1") + line(2, 60, "m2"));
    expect(totalTokens(await readRecentClaudeUsageSamples(root))).toBe(100);

    await fs.writeFile(file, line(1, 7, "m3"));
    await touchLater(file);
    expect(totalTokens(await readRecentClaudeUsageSamples(root))).toBe(7);

    // A larger file whose first record keeps its length: only the new inode reveals the rewrite.
    const replacement = path.join(projectDir, "replacement.tmp");
    await fs.writeFile(replacement, line(1, 9, "m4") + line(1, 11, "m5"));
    await fs.rename(replacement, file);
    await touchLater(file);
    expect(totalTokens(await readRecentClaudeUsageSamples(root))).toBe(20);
  });

  it("defers a partial trailing record until its newline arrives", async () => {
    const { root, projectDir } = await makeProjectsRoot();
    const file = path.join(projectDir, "a.jsonl");
    const pending = line(1, 60, "m2");
    const splitAt = Math.floor(pending.length / 2);
    await fs.writeFile(file, line(2, 40, "m1") + pending.slice(0, splitAt));
    expect(totalTokens(await readRecentClaudeUsageSamples(root))).toBe(40);

    await fs.appendFile(file, pending.slice(splitAt));
    await touchLater(file);
    expect(totalTokens(await readRecentClaudeUsageSamples(root))).toBe(100);
  });

  it("skips transcripts last written more than 30 days ago without opening them", async () => {
    const { root, projectDir } = await makeProjectsRoot();
    const stale = path.join(projectDir, "stale.jsonl");
    await fs.writeFile(stale, line(24 * 40, 500, "old"));
    const staleTime = new Date(Date.now() - 31 * 24 * 3_600_000);
    await fs.utimes(stale, staleTime, staleTime);
    await fs.writeFile(path.join(projectDir, "fresh.jsonl"), line(1, 5, "new"));

    const open = vi.spyOn(fs, "open");
    expect(totalTokens(await readRecentClaudeUsageSamples(root))).toBe(5);
    expect(open.mock.calls.map(([file]) => path.basename(String(file)))).toEqual(["fresh.jsonl"]);
  });
});
