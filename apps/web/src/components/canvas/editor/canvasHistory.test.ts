import type { CanvasCommentThread, DesignFrame } from "@synara/contracts";
import { declaredStyles } from "@synara/shared/designCanvasLayers";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CANVAS_HISTORY_GRACE_MS,
  CanvasHistory,
  canvasHistoryFor,
  CanvasHistoryRecorder,
  deletedLayerRows,
  holdCanvasHistory,
  invertEdit,
  invertExportSettings,
  invertLayout,
  invertRestore,
  replayableEdit,
  replayCanvasHistory,
  subtreeOf,
  type CanvasChange,
  type CanvasHistoryStep,
} from "./canvasHistory";

const frame: DesignFrame = {
  id: "f",
  title: "Frame",
  x: 0,
  y: 0,
  width: 400,
  height: 300,
  revision: 3,
  layers: {
    roots: ["a", "b"],
    nodes: [
      {
        id: "a",
        type: "element",
        tag: "p",
        attributes: { style: "color:red;padding:4px 8px" },
        children: ["t"],
      },
      { id: "t", type: "text", text: "Hello" },
      { id: "b", type: "element", tag: "div", attributes: {}, children: ["c"] },
      { id: "c", type: "element", tag: "span", attributes: {}, children: [] },
    ],
  },
};

describe("invertEdit", () => {
  it("restores each changed property as written, leaving other properties alone", () => {
    expect(
      invertEdit(
        frame,
        [{ type: "set_styles", nodeId: "a", styles: { padding: "0", margin: "4px" } }],
        [],
        frame,
      ),
    ).toEqual([{ type: "set_styles", nodeId: "a", styles: { padding: "4px 8px", margin: null } }]);
  });

  it("puts text back and re-inserts deleted subtrees with their IDs and position", () => {
    expect(invertEdit(frame, [{ type: "set_text", nodeId: "t", text: "Hi" }], [], frame)).toEqual([
      { type: "set_text", nodeId: "t", text: "Hello" },
    ]);
    expect(invertEdit(frame, [{ type: "delete", nodeId: "a" }], [], frame)).toEqual([
      {
        type: "insert_layers",
        parentId: null,
        beforeId: "b",
        layers: subtreeOf(frame.layers, "a"),
      },
    ]);
  });

  it("removes only the inserted roots, and redo replays them with the same IDs", () => {
    const after: DesignFrame = {
      ...frame,
      layers: {
        roots: ["a", "b", "n"],
        nodes: [
          ...frame.layers.nodes,
          { id: "n", type: "element", tag: "div", attributes: {}, children: ["m"] },
          { id: "m", type: "text", text: "New" },
        ],
      },
    };
    const insert = [{ type: "insert_html" as const, parentId: null, html: "<div>New</div>" }];
    expect(invertEdit(frame, insert, ["n", "m"], after)).toEqual([{ type: "delete", nodeId: "n" }]);
    expect(replayableEdit(insert, ["n", "m"], after)).toEqual([
      { type: "insert_layers", parentId: null, layers: subtreeOf(after.layers, "n") },
    ]);
  });

  it("inverts and replays an edit with several inserts once, not once per insert", () => {
    const after: DesignFrame = {
      ...frame,
      layers: {
        roots: ["a", "b", "n", "k"],
        nodes: [
          ...frame.layers.nodes,
          { id: "n", type: "element", tag: "div", attributes: {}, children: [] },
          { id: "k", type: "element", tag: "div", attributes: {}, children: [] },
        ],
      },
    };
    const kept = { roots: ["k"], nodes: [after.layers.nodes.at(-1)!] };
    const operations = [
      { type: "insert_html" as const, parentId: null, html: "<div></div>" },
      { type: "insert_layers" as const, parentId: null, layers: kept },
    ];
    expect(invertEdit(frame, operations, ["n", "k"], after)).toEqual([
      { type: "delete", nodeId: "k" },
      { type: "delete", nodeId: "n" },
    ]);
    expect(replayableEdit(operations, ["n", "k"], after)).toEqual([
      {
        type: "insert_layers",
        parentId: null,
        beforeId: "k",
        layers: subtreeOf(after.layers, "n"),
      },
      operations[1],
    ]);
  });
});

const rows = [{ format: "png" as const, scale: "2x", suffix: "@2x" }];
const thread: CanvasCommentThread = {
  id: "t1",
  frameId: "f",
  layerId: null,
  x: 0,
  y: 0,
  status: "open",
  createdAt: "2026-11-10T00:00:00.000Z",
  updatedAt: "2026-11-10T00:00:00.000Z",
  messages: [
    { id: "m", author: { kind: "user" }, text: "Hi", createdAt: "2026-11-10T00:00:00.000Z" },
  ],
};

describe("inverses", () => {
  it("restores moved geometry", () => {
    expect(invertLayout({ frames: [frame], comments: [] }, [{ id: "f", x: 50 }])).toEqual([
      { kind: "layout", frames: [{ id: "f", x: 0 }] },
    ]);
  });

  it("B16: a removed frame comes back with its comment threads, then its export rows", () => {
    const page = {
      frames: [frame],
      comments: [thread, { ...thread, id: "elsewhere", frameId: "g" }],
      exportSettings: { "frame:f": rows, "layer:f:a": rows, "frame:g": rows },
    };
    expect(invertLayout(page, [{ id: "f", remove: true }])).toEqual([
      { kind: "restore", frames: [frame], removeFrameIds: [], comments: [thread] },
      {
        kind: "exports",
        settings: [
          { key: "frame:f", entries: rows },
          { key: "layer:f:a", entries: rows },
        ],
      },
    ]);
    expect(invertRestore(page, { kind: "restore", frames: [], removeFrameIds: ["f"] })).toEqual(
      invertLayout(page, [{ id: "f", remove: true }]),
    );
    expect(
      invertRestore(page, {
        kind: "restore",
        frames: [{ ...frame, id: "new" }],
        removeFrameIds: [],
      }),
    ).toEqual([{ kind: "restore", frames: [], removeFrameIds: ["new"] }]);
  });

  it("B16: deleting a layer keeps the export rows of it and its descendants for undo", () => {
    const page = { exportSettings: { "layer:f:b": rows, "layer:f:c": rows, "layer:f:a": rows } };
    expect(deletedLayerRows(page, frame, [{ type: "delete", nodeId: "b" }])).toEqual([
      {
        kind: "exports",
        settings: [
          { key: "layer:f:b", entries: rows },
          { key: "layer:f:c", entries: rows },
        ],
      },
    ]);
    expect(deletedLayerRows(page, frame, [{ type: "move", nodeId: "b", parentId: null }])).toEqual(
      [],
    );
  });

  it("puts back each node's previous export rows, removing rows that were new", () => {
    expect(
      invertExportSettings({ exportSettings: { "frame:f": rows } }, [
        { key: "frame:f", entries: null },
        { key: "layer:f:a", entries: rows },
      ]),
    ).toEqual({
      kind: "exports",
      settings: [
        { key: "frame:f", entries: rows },
        { key: "layer:f:a", entries: null },
      ],
    });
  });
});

const step = (x: number): CanvasHistoryStep => ({
  undo: [{ kind: "layout", frames: [{ id: "f", x }] }],
  redo: [{ kind: "layout", frames: [{ id: "f", x: x + 1 }] }],
});
const xOf = (change: CanvasChange) => (change.kind === "layout" ? change.frames[0]!.x : null);

describe("history", () => {
  it("a new change clears redo", () => {
    const history = new CanvasHistory();
    const entry = { pageId: "p", steps: [step(0)] };
    history.push(entry);
    expect(history.takeUndo()).toBe(entry);
    expect(history.canRedo).toBe(true);
    history.push(entry);
    expect(history.canRedo).toBe(false);
  });

  it("one gesture is one undo step; later changes undo first", async () => {
    const history = new CanvasHistory();
    const recorder = new CanvasHistoryRecorder(history);
    recorder.open();
    recorder.record("p", step(1));
    recorder.record("p", step(2));
    recorder.close();
    const applied: (number | null | undefined)[] = [];
    await replayCanvasHistory(history, "undo", async (change) => void applied.push(xOf(change)));
    expect(applied).toEqual([2, 1]);
    await replayCanvasHistory(history, "redo", async (change) => void applied.push(xOf(change)));
    expect(applied).toEqual([2, 1, 2, 3]);
  });

  it("B17: another editor's change never lands in an open group", () => {
    const history = new CanvasHistory();
    const first = new CanvasHistoryRecorder(history);
    const second = new CanvasHistoryRecorder(history);
    first.open();
    first.record("p", step(1));
    second.record("p", step(5));
    first.record("p", step(2));
    first.close();
    expect(history.takeUndo()?.steps).toEqual([step(1), step(2)]);
    expect(history.takeUndo()?.steps).toEqual([step(5)]);
  });

  it("B15: a failed undo reverts what it applied and keeps the entry", async () => {
    const history = new CanvasHistory();
    const recorder = new CanvasHistoryRecorder(history);
    recorder.open();
    recorder.record("p", step(1));
    recorder.record("p", step(2));
    recorder.close();
    const applied: (number | null | undefined)[] = [];
    const result = await replayCanvasHistory(history, "undo", async (change) => {
      if (xOf(change) === 1) throw new Error("refused");
      applied.push(xOf(change));
    });
    // Step 2 was undone (x 2), then put back by its redo (x 3); step 1 never applied.
    expect(result).toMatchObject({ status: "failed", reverted: true });
    expect(applied).toEqual([2, 3]);
    expect(history.canUndo).toBe(true);
    expect(history.canRedo).toBe(false);
  });

  it("B15: an entry that cannot be reverted either is dropped", async () => {
    const history = new CanvasHistory();
    history.push({ pageId: "p", steps: [step(1), step(2)] });
    const result = await replayCanvasHistory(history, "undo", async (change) => {
      if (xOf(change) !== 2) throw new Error("refused");
    });
    expect(result).toMatchObject({ status: "failed", reverted: false });
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
  });
});

describe("history lifetime (B17)", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps a work's history while held and forgets it after the grace period", () => {
    vi.useFakeTimers();
    const history = canvasHistoryFor("work-lifetime");
    const release = holdCanvasHistory("work-lifetime");
    const again = holdCanvasHistory("work-lifetime");
    release();
    vi.advanceTimersByTime(CANVAS_HISTORY_GRACE_MS * 2);
    expect(canvasHistoryFor("work-lifetime")).toBe(history);
    again();
    vi.advanceTimersByTime(CANVAS_HISTORY_GRACE_MS - 1);
    // Reopened within the grace period (side pane → full layout): the same history.
    const reopened = holdCanvasHistory("work-lifetime");
    vi.advanceTimersByTime(CANVAS_HISTORY_GRACE_MS * 2);
    expect(canvasHistoryFor("work-lifetime")).toBe(history);
    reopened();
    vi.advanceTimersByTime(CANVAS_HISTORY_GRACE_MS);
    expect(canvasHistoryFor("work-lifetime")).not.toBe(history);
  });
});

it("reads declarations as written, including values with semicolons in strings", () => {
  const styles = declaredStyles(
    'font-family:"A;B", serif;background:url("data:image/png;base64,AA==");COLOR:red',
  );
  expect(styles.get("font-family")).toBe('"A;B", serif');
  expect(styles.get("background")).toBe('url("data:image/png;base64,AA==")');
  expect(styles.get("color")).toBe("red");
});
