import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Effect, Schema } from "effect";
import {
  CanvasId,
  DesignFrame,
  ThreadId,
  type CanvasTurnActivity,
  type CanvasWork,
} from "@synara/contracts";
import { writeFileStringAtomically } from "./atomicWrite";

const MAX_ENTRIES = 40;
const MAX_FILE_BYTES = 6 * 1024 * 1024;

/** The frames one agent turn touched on one page, as they were before its first write. */
const HistoryEntry = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.String,
  workId: CanvasId,
  workTitle: Schema.String,
  pageId: CanvasId,
  pageTitle: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  createdFrameIds: Schema.Array(Schema.String),
  updatedFrameIds: Schema.Array(Schema.String),
  /** Frame ID to its state before the turn; null means the turn created it. */
  before: Schema.Record(Schema.String, Schema.NullOr(DesignFrame)),
  restorable: Schema.Boolean,
  restoredAt: Schema.NullOr(Schema.String),
});
type HistoryEntry = typeof HistoryEntry.Type;
const HistoryFile = Schema.Struct({
  version: Schema.Literal(1),
  threadId: ThreadId,
  entries: Schema.Array(HistoryEntry),
});
type HistoryFile = typeof HistoryFile.Type;

export type CanvasTurnCaller = { threadId: ThreadId; turnId: string };

const frameChanged = (before: DesignFrame, after: DesignFrame) =>
  before.revision !== after.revision ||
  before.x !== after.x ||
  before.y !== after.y ||
  before.width !== after.width ||
  before.height !== after.height ||
  before.title !== after.title;

const toActivity = (entry: HistoryEntry): CanvasTurnActivity => ({
  threadId: entry.threadId,
  turnId: entry.turnId,
  workId: entry.workId,
  workTitle: entry.workTitle,
  pageId: entry.pageId,
  pageTitle: entry.pageTitle,
  createdFrameIds: [...entry.createdFrameIds],
  updatedFrameIds: [...entry.updatedFrameIds],
  firstFrameId: entry.createdFrameIds[0] ?? entry.updatedFrameIds[0] ?? null,
  createdAt: entry.createdAt,
  updatedAt: entry.updatedAt,
  restorable: entry.restorable,
  restoredAt: entry.restoredAt,
});

/**
 * Per-chat restore points for agent turns. Writes happen inside the library's serialized
 * mutation queue, so a file has one writer at a time. Oldest snapshots are evicted first.
 */
export function makeCanvasTurnHistory(stateDir: string) {
  const directory = path.join(stateDir, "design-canvases", "history");
  const fileFor = (threadId: string) =>
    path.join(directory, `${createHash("sha256").update(threadId).digest("hex")}.json`);
  const read = async (threadId: ThreadId): Promise<HistoryFile> => {
    try {
      const file = Schema.decodeUnknownSync(HistoryFile)(
        JSON.parse(await readFile(fileFor(threadId), "utf8")),
      );
      if (file.threadId !== threadId) throw new Error("Canvas history identity mismatch.");
      return file;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { version: 1, threadId, entries: [] };
      throw error;
    }
  };
  const write = async (file: HistoryFile) => {
    const entries = file.entries.slice(-MAX_ENTRIES).map((entry) => ({ ...entry }));
    let source = JSON.stringify({ ...file, entries });
    // Drop the oldest snapshots until the file fits; their cards stay, without Restore.
    for (const entry of entries) {
      if (Buffer.byteLength(source) <= MAX_FILE_BYTES) break;
      if (!entry.restorable) continue;
      entry.before = {};
      entry.restorable = false;
      source = JSON.stringify({ ...file, entries });
    }
    if (Buffer.byteLength(source) > MAX_FILE_BYTES) {
      // A single enormous turn: keep the card, give up its snapshot.
      const last = entries.at(-1);
      if (last) {
        last.before = {};
        last.restorable = false;
      }
      source = JSON.stringify({ ...file, entries });
    }
    await Effect.runPromise(
      writeFileStringAtomically({ filePath: fileFor(file.threadId), contents: source }),
    );
  };
  return {
    /** One activity per turn and work; a turn that edited several pages merges them. */
    async list(threadId: ThreadId): Promise<CanvasTurnActivity[]> {
      const merged = new Map<string, CanvasTurnActivity>();
      for (const entry of (await read(threadId)).entries) {
        const key = `${entry.turnId}\0${entry.workId}`;
        const activity = toActivity(entry);
        const previous = merged.get(key);
        merged.set(
          key,
          previous
            ? {
                ...activity,
                createdAt: previous.createdAt,
                createdFrameIds: [...previous.createdFrameIds, ...activity.createdFrameIds],
                updatedFrameIds: [...previous.updatedFrameIds, ...activity.updatedFrameIds],
                firstFrameId: previous.firstFrameId ?? activity.firstFrameId,
                restorable: previous.restorable && activity.restorable,
                restoredAt: previous.restoredAt ?? activity.restoredAt,
              }
            : activity,
        );
      }
      return [...merged.values()];
    },
    /** Record what an agent write changed on one page, keeping the earliest snapshot. */
    async record(caller: CanvasTurnCaller, before: CanvasWork, after: CanvasWork, pageId: string) {
      const previousPage = before.pages.find((page) => page.id === pageId);
      const nextPage = after.pages.find((page) => page.id === pageId);
      if (!nextPage) return;
      const previousFrames = new Map(
        (previousPage?.frames ?? []).map((frame) => [frame.id, frame]),
      );
      const nextFrames = new Map(nextPage.frames.map((frame) => [frame.id, frame]));
      const touched = new Map<string, DesignFrame | null>();
      for (const [id, frame] of nextFrames) {
        const old = previousFrames.get(id);
        if (!old) touched.set(id, null);
        else if (frameChanged(old, frame)) touched.set(id, old);
      }
      for (const [id, frame] of previousFrames) if (!nextFrames.has(id)) touched.set(id, frame);
      if (touched.size === 0) return;
      const file = await read(caller.threadId);
      const timestamp = new Date().toISOString();
      const index = file.entries.findIndex(
        (entry) =>
          entry.turnId === caller.turnId && entry.workId === after.id && entry.pageId === pageId,
      );
      const existing = index >= 0 ? file.entries[index]! : null;
      const snapshot: Record<string, DesignFrame | null> = { ...existing?.before };
      for (const [id, frame] of touched) if (!(id in snapshot)) snapshot[id] = frame;
      const created = Object.entries(snapshot)
        .filter(([id, frame]) => frame === null && nextFrames.has(id))
        .map(([id]) => id);
      const updated = Object.entries(snapshot)
        .filter(([, frame]) => frame !== null)
        .map(([id]) => id);
      const entry: HistoryEntry = {
        threadId: caller.threadId,
        turnId: caller.turnId,
        workId: after.id,
        workTitle: after.title,
        pageId,
        pageTitle: nextPage.title,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
        createdFrameIds: created,
        updatedFrameIds: updated,
        before: snapshot,
        restorable: existing ? existing.restorable : true,
        restoredAt: null,
      };
      const entries = [...file.entries];
      if (index >= 0) entries.splice(index, 1);
      entries.push(entry);
      await write({ ...file, entries });
    },
    async entries(threadId: ThreadId, turnId: string, workId: string) {
      const entries = (await read(threadId)).entries.filter(
        (item) => item.turnId === turnId && item.workId === workId,
      );
      if (entries.length === 0) throw new Error("This canvas change is no longer in history.");
      if (entries.some((entry) => !entry.restorable))
        throw new Error("This change is too old to restore.");
      return entries;
    },
    async markRestored(threadId: ThreadId, turnId: string, workId: string) {
      const file = await read(threadId);
      await write({
        ...file,
        entries: file.entries.map((entry) =>
          entry.turnId === turnId && entry.workId === workId
            ? { ...entry, restoredAt: new Date().toISOString() }
            : entry,
        ),
      });
    },
  };
}
