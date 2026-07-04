// FILE: exportThreadArchive.ts
// Purpose: Build a ZIP archive that exports a single Synara thread so a user
//          can download the conversation as a portable, compressed package —
//          mirroring the `/export` affordance of agent CLIs.
// Layer: Orchestration utility (plain async module; HTTP composes it through
//          Stream.fromAsyncIterable). ZIP is produced with node:zlib and a
//          hand-written central directory, streamed one entry at a time so the
//          server never holds the whole archive in memory.
// Exports: threadArchiveChunks, buildThreadArchiveBytes, threadArchiveFileName.
// The export-eligibility guard lives in @t3tools/shared/threadExport so the
// web composer and the HTTP route share one predicate.

import zlib from "node:zlib";
import { promisify } from "node:util";

import type { OrchestrationThread } from "@t3tools/contracts";

export interface ThreadArchiveEntry {
  readonly name: string;
  readonly data: string;
}

const crc32 = (buf: Buffer): number => zlib.crc32(buf) >>> 0;

const u16 = (value: number): Buffer => {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value >>> 0, 0);
  return buffer;
};

const u32 = (value: number): Buffer => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
};

const UTF8_FLAG = 0x0800;
const deflateRaw = promisify(zlib.deflateRaw);

interface ZipEntryRecord {
  readonly localChunk: Buffer;
  readonly centralRecord: (offset: number) => Buffer;
}

// Zeroed DOS time/date (1980-01-01 00:00) keeps exports deterministic without
// adding date conversion code to the archive writer.
async function buildZipEntry(entry: ThreadArchiveEntry): Promise<ZipEntryRecord> {
  const nameBuffer = Buffer.from(entry.name, "utf8");
  const data = Buffer.from(entry.data, "utf8");
  const crc = crc32(data);

  const compressed = await deflateRaw(data);
  const useDeflate = compressed.length < data.length;
  const stored = useDeflate ? compressed : data;
  const method = useDeflate ? 8 : 0;

  const localChunk = Buffer.concat([
    u32(0x04034b50), // local file header signature
    u16(20), // version needed to extract
    u16(UTF8_FLAG), // general purpose: UTF-8 names
    u16(method), // compression method (8 deflate, 0 store)
    u16(0), // last mod time
    u16(0), // last mod date
    u32(crc), // CRC-32
    u32(stored.length), // compressed size
    u32(data.length), // uncompressed size
    u16(nameBuffer.length), // file name length
    u16(0), // extra field length
    nameBuffer,
    stored,
  ]);

  const centralRecord = (offset: number): Buffer =>
    Buffer.concat([
      u32(0x02014b50), // central directory header signature
      u16(20), // version made by
      u16(20), // version needed to extract
      u16(UTF8_FLAG), // general purpose: UTF-8 names
      u16(method), // compression method
      u16(0), // last mod time
      u16(0), // last mod date
      u32(crc), // CRC-32
      u32(stored.length), // compressed size
      u32(data.length), // uncompressed size
      u16(nameBuffer.length), // file name length
      u16(0), // extra field length
      u16(0), // file comment length
      u16(0), // disk number start
      u16(0), // internal file attributes
      u32(0), // external file attributes
      u32(offset), // offset of local header
      nameBuffer,
    ]);

  return { localChunk, centralRecord };
}

const MESSAGE_ROLE_HEADING: Record<string, string> = {
  user: "User",
  assistant: "Assistant",
  system: "System",
};

function buildTranscriptMarkdown(thread: OrchestrationThread): string {
  const lines: string[] = [`# ${thread.title}`, "", `> Exported from Synara.`, ""];

  for (const message of thread.messages) {
    const heading = MESSAGE_ROLE_HEADING[message.role] ?? "Message";
    const timestamp = ` \`${message.createdAt}\``;
    lines.push(`## ${heading}${timestamp}`, "", message.text, "");
  }

  return lines.join("\n");
}

function buildThreadJson(thread: OrchestrationThread): string {
  return JSON.stringify(
    {
      threadId: thread.id,
      title: thread.title,
      modelSelection: thread.modelSelection,
      runtimeMode: thread.runtimeMode,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      messages: thread.messages.map((message) => ({
        id: message.id,
        role: message.role,
        text: message.text,
        source: message.source,
        // Attachment/skill/mention references are part of the user's input for a
        // turn; keep them in the structured export (metadata only — the archive
        // does not bundle the referenced files).
        ...(message.attachments?.length ? { attachments: message.attachments } : {}),
        ...(message.skills?.length ? { skills: message.skills } : {}),
        ...(message.mentions?.length ? { mentions: message.mentions } : {}),
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
      })),
    },
    null,
    2,
  );
}

// Lazy per-entry generation: each entry's string is materialized only while
// that entry is being compressed and emitted, then becomes collectible.
function* threadArchiveEntries(thread: OrchestrationThread): Generator<ThreadArchiveEntry> {
  yield { name: "thread.json", data: buildThreadJson(thread) };
  yield { name: "transcript.md", data: buildTranscriptMarkdown(thread) };
}

// Streams the ZIP as it is produced: one local header+payload chunk per entry,
// then the central directory and end record. Peak memory is bounded by a single
// entry (its text, compressed copy, and header), never the whole archive.
export async function* threadArchiveChunks(thread: OrchestrationThread): AsyncGenerator<Buffer> {
  const centralRecords: Buffer[] = [];
  let offset = 0;
  let entryCount = 0;

  for (const entry of threadArchiveEntries(thread)) {
    const { localChunk, centralRecord } = await buildZipEntry(entry);
    centralRecords.push(centralRecord(offset));
    offset += localChunk.length;
    entryCount += 1;
    yield localChunk;
  }

  const centralDirectoryBody = Buffer.concat(centralRecords);
  yield centralDirectoryBody;

  yield Buffer.concat([
    u32(0x06054b50), // end of central directory signature
    u16(0), // number of this disk
    u16(0), // disk where central directory starts
    u16(entryCount), // entries on this disk
    u16(entryCount), // total entries
    u32(centralDirectoryBody.length), // size of central directory
    u32(offset), // offset of central directory
    u16(0), // comment length
  ]);
}

// Convenience for tests and small callers that want the whole archive at once.
export async function buildThreadArchiveBytes(thread: OrchestrationThread): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of threadArchiveChunks(thread)) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const FILENAME_SAFE_REPLACE = /[^a-z0-9-]+/g;

function slugifyTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .trim()
    .replace(FILENAME_SAFE_REPLACE, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug.slice(0, 48) : "thread";
}

// Stable date bucket derived from the ISO timestamp keeps filenames sortable
// without pulling in a date library for formatting.
export function threadArchiveFileName(input: {
  readonly title: string;
  readonly isoTimestamp: string;
}): string {
  const dateBucket = input.isoTimestamp.slice(0, 10).replaceAll("-", "");
  return `synara-thread-${slugifyTitle(input.title)}-${dateBucket}.zip`;
}
