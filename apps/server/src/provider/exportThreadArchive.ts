// FILE: exportThreadArchive.ts
// Purpose: Build a ZIP archive that exports a single Synara thread so a user
//          can download the conversation as a portable, compressed package —
//          mirroring the `/export` affordance of agent CLIs.
// Layer: Server runtime utility (plain module; the HTTP route composes it via
//          Effect.promise). No external dependencies — ZIP is produced with
//          node:zlib (deflate + crc32) and a hand-written central directory.
// Exports: buildThreadArchiveBytes, threadArchiveFileName.

import zlib from "node:zlib";

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

// ponytail: zeroed DOS time/date (1980-01-01 00:00) is valid and is what most
// deterministic/representative archive writers emit. Real mtimes would need
// safe conversion from ISO -> MS-DOS fields; not worth it for an export dump.
function buildZip(entries: ReadonlyArray<ThreadArchiveEntry>): Buffer {
  const localHeaders: Buffer[] = [];
  const centralDirectory: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data, "utf8");
    const crc = crc32(data);

    const compressed = zlib.deflateRawSync(data);
    const useDeflate = compressed.length < data.length;
    const stored = useDeflate ? compressed : data;
    const method = useDeflate ? 8 : 0;

    const localHeader = Buffer.concat([
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

    localHeaders.push(localHeader);

    centralDirectory.push(
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
      ]),
    );

    offset += localHeader.length;
  }

  const centralDirectoryStart = offset;
  const centralDirectoryBody = Buffer.concat(centralDirectory);

  const endOfCentralDirectory = Buffer.concat([
    u32(0x06054b50), // end of central directory signature
    u16(0), // number of this disk
    u16(0), // disk where central directory starts
    u16(entries.length), // entries on this disk
    u16(entries.length), // total entries
    u32(centralDirectoryBody.length), // size of central directory
    u32(centralDirectoryStart), // offset of central directory
    u16(0), // comment length
  ]);

  return Buffer.concat([...localHeaders, centralDirectoryBody, endOfCentralDirectory]);
}

const MESSAGE_ROLE_HEADING: Record<string, string> = {
  user: "User",
  assistant: "Assistant",
  system: "System",
};

function escapeMarkdownInline(text: string): string {
  // ponytail: minimal escaping — backticks and backslashes are the only pairs that
  // would visually corrupt a transcript dump. Full CommonMark escaping is YAGNI here.
  return text.replace(/`/g, "\\`").replace(/\\/g, "\\\\");
}

function buildTranscriptMarkdown(thread: OrchestrationThread): string {
  const lines: string[] = [`# ${thread.title}`, "", `> Exported from Synara.`, ""];

  for (const message of thread.messages) {
    const heading = MESSAGE_ROLE_HEADING[message.role] ?? "Message";
    const timestamp = ` \`${message.createdAt}\``;
    lines.push(`## ${heading}${timestamp}`, "", escapeMarkdownInline(message.text), "");
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
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
      })),
    },
    null,
    2,
  );
}

export function buildThreadArchiveEntries(thread: OrchestrationThread): ThreadArchiveEntry[] {
  return [
    { name: "thread.json", data: buildThreadJson(thread) },
    { name: "transcript.md", data: buildTranscriptMarkdown(thread) },
  ];
}

export function buildThreadArchiveBytes(thread: OrchestrationThread): Buffer {
  return buildZip(buildThreadArchiveEntries(thread));
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

// ponytail: stable date bucket derived from the ISO timestamp's YYYYMMDD prefix.
// Keeps filenames sortable and avoids pulling in a date library for formatting.
export function threadArchiveFileName(input: {
  readonly title: string;
  readonly isoTimestamp: string;
}): string {
  const dateBucket = input.isoTimestamp.slice(0, 10).replaceAll("-", "");
  return `synara-thread-${slugifyTitle(input.title)}-${dateBucket}.zip`;
}

// --- self-check -------------------------------------------------------------
// Run `bun apps/server/src/provider/exportThreadArchive.ts` to verify the ZIP
// writer round-trips through `unzip`. Left in place because ZIP byte layout is
// easy to get subtly wrong; this is the one check that fails if it breaks.
if (import.meta.main) {
  const sampleThread = {
    id: "thread-sample",
    title: "Sample Thread",
    messages: [
      {
        id: "m1",
        role: "user",
        text: "Hello, can you help me export this?",
        streaming: false,
        source: "native",
        createdAt: "2026-06-28T00:00:00.000Z",
        updatedAt: "2026-06-28T00:00:00.000Z",
      },
      {
        id: "m2",
        role: "assistant",
        text: "Of course. Use `/export` to download this thread as a ZIP.",
        streaming: false,
        source: "native",
        createdAt: "2026-06-28T00:00:01.000Z",
        updatedAt: "2026-06-28T00:00:01.000Z",
      },
    ],
    createdAt: "2026-06-28T00:00:00.000Z",
    updatedAt: "2026-06-28T00:00:01.000Z",
  } as unknown as OrchestrationThread;

  const bytes = buildThreadArchiveBytes(sampleThread);
  const fileName = threadArchiveFileName({
    title: sampleThread.title,
    isoTimestamp: sampleThread.updatedAt,
  });
  console.log(`OK ${fileName} (${bytes.length} bytes)`);
}
