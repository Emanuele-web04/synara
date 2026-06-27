import zlib from "node:zlib";

import { describe, expect, it } from "@effect/vitest";

import { buildThreadArchiveBytes, threadArchiveFileName } from "./exportThreadArchive.ts";

import type { OrchestrationThread } from "@t3tools/contracts";

// Minimal ZIP reader: walks the central directory, inflates each raw-deflate
// entry. Enough to prove the writer emits a valid archive without depending on
// a host `unzip` binary in CI.
interface ZipEntry {
  readonly name: string;
  readonly data: Buffer;
}

const LOCAL_HEADER_SIG = 0x04034b50;
const CENTRAL_HEADER_SIG = 0x02014b50;

function readZip(buffer: Buffer): ZipEntry[] {
  // EOCD is the last record; scan backwards for its signature.
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  expect(eocdOffset).toBeGreaterThanOrEqual(0);

  const cdOffset = buffer.readUInt32LE(eocdOffset + 16);
  const cdEntries = buffer.readUInt16LE(eocdOffset + 10);

  const entries: ZipEntry[] = [];
  let cursor = cdOffset;
  for (let index = 0; index < cdEntries; index += 1) {
    expect(buffer.readUInt32LE(cursor)).toBe(CENTRAL_HEADER_SIG);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");

    expect(buffer.readUInt32LE(localHeaderOffset)).toBe(LOCAL_HEADER_SIG);
    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const dataOffset = localHeaderOffset + 30 + localNameLength;
    const stored = buffer.subarray(dataOffset, dataOffset + compressedSize);
    const data = method === 0 ? stored : zlib.inflateRawSync(stored);

    entries.push({ name, data });
    cursor += 46 + nameLength;
  }
  return entries;
}

function sampleThread(): OrchestrationThread {
  return {
    id: "thread-abc",
    title: "Export Demo",
    modelSelection: { provider: "claudeAgent" } as OrchestrationThread["modelSelection"],
    runtimeMode: "default" as OrchestrationThread["runtimeMode"],
    messages: [
      {
        id: "m1",
        role: "user",
        text: "Hello",
        streaming: false,
        source: "native",
        turnId: null,
        createdAt: "2026-06-28T00:00:00.000Z",
        updatedAt: "2026-06-28T00:00:00.000Z",
      },
      {
        id: "m2",
        role: "assistant",
        text: "Hi there",
        streaming: false,
        source: "native",
        turnId: null,
        createdAt: "2026-06-28T00:00:01.000Z",
        updatedAt: "2026-06-28T00:00:01.000Z",
      },
    ],
    createdAt: "2026-06-28T00:00:00.000Z",
    updatedAt: "2026-06-28T00:00:01.000Z",
  } as unknown as OrchestrationThread;
}

describe("exportThreadArchive", () => {
  it("builds a zip containing thread.json and transcript.md", () => {
    const entries = readZip(buildThreadArchiveBytes(sampleThread())).reduce<Record<string, Buffer>>(
      (acc, entry) => {
        acc[entry.name] = entry.data;
        return acc;
      },
      {},
    );

    expect(Object.keys(entries).sort()).toEqual(["thread.json", "transcript.md"]);

    const threadJson = JSON.parse(entries["thread.json"]!.toString("utf8"));
    expect(threadJson.threadId).toBe("thread-abc");
    expect(threadJson.messages).toHaveLength(2);
    expect(threadJson.messages[0].role).toBe("user");

    const transcript = entries["transcript.md"]!.toString("utf8");
    expect(transcript).toContain("# Export Demo");
    expect(transcript).toContain("Hello");
    expect(transcript).toContain("Hi there");
  });

  it("slugifies the title and stamps the date bucket into the filename", () => {
    expect(
      threadArchiveFileName({ title: "Fix: nasty bug!!", isoTimestamp: "2026-06-28T01:02:03Z" }),
    ).toBe("synara-thread-fix-nasty-bug-20260628.zip");
  });

  it("falls back to a generic slug when the title has no safe characters", () => {
    expect(threadArchiveFileName({ title: "   ", isoTimestamp: "2026-06-28T00:00:00Z" })).toBe(
      "synara-thread-thread-20260628.zip",
    );
  });
});
