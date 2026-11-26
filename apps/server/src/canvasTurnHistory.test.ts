import { createHash } from "node:crypto";
import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ThreadId, type CanvasWork, type DesignFrame } from "@synara/contracts";
import { afterEach, expect, it } from "vitest";
import { makeCanvasTurnHistory } from "./canvasTurnHistory";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), "synara-canvas-history-"));
  directories.push(directory);
  return { directory, history: makeCanvasTurnHistory(directory) };
}
const historyFile = (directory: string, threadId: string) =>
  path.join(
    directory,
    "design-canvases",
    "history",
    `${createHash("sha256").update(threadId).digest("hex")}.json`,
  );

const thread = ThreadId.makeUnsafe("agent-chat");
const caller = (turnId: string) => ({ threadId: thread, turnId });

function frame(id: string, revision = 1, extra: Partial<DesignFrame> = {}, text = id): DesignFrame {
  return {
    id,
    title: id,
    x: 0,
    y: 0,
    width: 390,
    height: 844,
    revision,
    layers: {
      roots: [`${id}-p`],
      nodes: [
        { id: `${id}-p`, type: "element", tag: "p", attributes: {}, children: [`${id}-t`] },
        { id: `${id}-t`, type: "text", text },
      ],
    },
    ...extra,
  };
}
function work(pages: Record<string, DesignFrame[]>, id = "work"): CanvasWork {
  return {
    version: 3,
    kind: "work",
    id,
    title: "Work",
    folderId: null,
    projectId: null,
    createdAt: "2026-11-07T00:00:00.000Z",
    updatedAt: "2026-11-07T00:00:00.000Z",
    archivedAt: null,
    pages: Object.entries(pages).map(([pageId, frames]) => ({
      id: pageId,
      title: pageId,
      viewport: { x: 0, y: 0, zoom: 1 },
      frames,
      comments: [],
    })),
    chats: [],
  };
}

it("keeps each frame's earliest snapshot in a turn and records created frames as null", async () => {
  const { history } = await setup();
  const a1 = frame("a"),
    b1 = frame("b"),
    c1 = frame("c");
  const w0 = work({ main: [a1, b1, c1] });
  const w1 = work({ main: [frame("a", 2), { ...b1, x: 400 }, c1, frame("d"), frame("e")] });
  const w2 = work({ main: [frame("a", 3), { ...b1, x: 400 }, frame("d", 2)] });
  await history.record(caller("turn-1"), w0, w1, "main");
  await history.record(caller("turn-1"), w1, w2, "main");
  // A write that changes nothing records nothing, even for a new turn.
  await history.record(caller("turn-2"), w2, w2, "main");

  const [entry, ...rest] = await history.entries(thread, "turn-1", "work");
  expect(rest).toEqual([]);
  expect(entry!.before).toEqual({ a: a1, b: b1, c: c1, d: null, e: null });
  const activities = await history.list(thread);
  expect(activities).toEqual([
    expect.objectContaining({
      turnId: "turn-1",
      workId: "work",
      pageId: "main",
      // e was created and deleted within the turn: neither created nor updated.
      createdFrameIds: ["d"],
      updatedFrameIds: ["a", "b", "c"],
      firstFrameId: "d",
      restorable: true,
      restoredAt: null,
    }),
  ]);
});

it("merges one turn across pages into one activity and keeps turns and works apart", async () => {
  const { history } = await setup();
  const before = work({ one: [frame("x")], two: [frame("y")] });
  const afterOne = work({ one: [frame("x"), frame("created")], two: [frame("y")] });
  const afterTwo = work({ one: [frame("x"), frame("created")], two: [frame("y", 2)] });
  await history.record(caller("turn-1"), before, afterOne, "one");
  await history.record(caller("turn-1"), afterOne, afterTwo, "two");
  await history.record(caller("turn-2"), afterTwo, work({ one: [frame("x", 2)], two: [] }), "one");
  await history.record(
    caller("turn-1"),
    work({ main: [] }, "other"),
    work({ main: [frame("z")] }, "other"),
    "main",
  );

  const activities = await history.list(thread);
  expect(activities.map((item) => [item.turnId, item.workId])).toEqual([
    ["turn-1", "work"],
    ["turn-2", "work"],
    ["turn-1", "other"],
  ]);
  expect(activities[0]).toMatchObject({
    createdFrameIds: ["created"],
    updatedFrameIds: ["y"],
    firstFrameId: "created",
    restorable: true,
  });
  expect(activities[1]).toMatchObject({ createdFrameIds: [], updatedFrameIds: ["x", "created"] });
  expect(await history.entries(thread, "turn-1", "work")).toHaveLength(2);
  await expect(history.entries(thread, "turn-9", "work")).rejects.toThrow("no longer in history");

  await history.markRestored(thread, "turn-1", "work");
  const restored = await history.list(thread);
  expect(restored[0]!.restoredAt).toEqual(expect.any(String));
  expect(restored[1]!.restoredAt).toBeNull();
  expect(restored[2]!.restoredAt).toBeNull();
});

it("evicts the oldest snapshots once the file passes 6 MiB but keeps their cards", async () => {
  const { directory, history } = await setup();
  const big = (revision: number) =>
    Array.from({ length: 10 }, (_, index) =>
      frame(`f${index}`, revision, {}, `${index}`.repeat(190_000)),
    );
  for (let turn = 1; turn <= 4; turn++)
    await history.record(
      caller(`turn-${turn}`),
      work({ main: big(turn) }),
      work({ main: big(turn + 1) }),
      "main",
    );
  expect((await stat(historyFile(directory, thread))).size).toBeLessThanOrEqual(6 * 1024 * 1024);
  const activities = await history.list(thread);
  expect(activities.map((item) => [item.turnId, item.restorable])).toEqual([
    ["turn-1", false],
    ["turn-2", true],
    ["turn-3", true],
    ["turn-4", true],
  ]);
  expect(activities[0]!.updatedFrameIds).toHaveLength(10);
  await expect(history.entries(thread, "turn-1", "work")).rejects.toThrow("too old");
  expect(Object.keys((await history.entries(thread, "turn-4", "work"))[0]!.before)).toHaveLength(
    10,
  );
});

it("gives up the snapshot of a single turn larger than the limit", async () => {
  const { history } = await setup();
  const big = (revision: number) =>
    Array.from({ length: 34 }, (_, index) => frame(`f${index}`, revision, {}, "x".repeat(190_000)));
  await history.record(caller("huge"), work({ main: big(1) }), work({ main: big(2) }), "main");
  expect(await history.list(thread)).toEqual([
    expect.objectContaining({ turnId: "huge", restorable: false }),
  ]);
  await expect(history.entries(thread, "huge", "work")).rejects.toThrow("too old");
  // Later writes in the same turn cannot make it restorable from a partial snapshot.
  await history.record(caller("huge"), work({ main: [] }), work({ main: [frame("late")] }), "main");
  await expect(history.entries(thread, "huge", "work")).rejects.toThrow("too old");
});

it("keeps the 40 most recent entries per chat", async () => {
  const { history } = await setup();
  for (let turn = 0; turn <= 40; turn++)
    await history.record(
      caller(`turn-${turn}`),
      work({ main: [] }),
      work({ main: [frame(`f${turn}`)] }),
      "main",
    );
  const activities = await history.list(thread);
  expect(activities).toHaveLength(40);
  expect(activities[0]!.turnId).toBe("turn-1");
  await expect(history.entries(thread, "turn-0", "work")).rejects.toThrow("no longer in history");
});

it("refuses a history file that belongs to another chat", async () => {
  const { directory, history } = await setup();
  await history.record(caller("turn-1"), work({ main: [] }), work({ main: [frame("a")] }), "main");
  const other = ThreadId.makeUnsafe("other-chat");
  await copyFile(historyFile(directory, thread), historyFile(directory, other));
  await expect(history.list(other)).rejects.toThrow("identity mismatch");
  expect(await history.list(ThreadId.makeUnsafe("empty-chat"))).toEqual([]);
});
