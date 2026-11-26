import { describe, expect, it } from "vitest";
import { resolveLayerDrop, type DropRow } from "./canvasLayerDrop";

// Front-most first: frame F > card (open) > [b, a]; then x; frame G (empty).
const rows: DropRow[] = [
  { key: "F", depth: 0, parent: null, container: true, open: true },
  { key: "card", depth: 1, parent: "F", container: true, open: true },
  { key: "b", depth: 2, parent: "card", container: false, open: false },
  { key: "a", depth: 2, parent: "card", container: false, open: false },
  { key: "x", depth: 1, parent: "F", container: true, open: false },
  { key: "G", depth: 0, parent: null, container: true, open: false },
];
const drop = (at: number, ratio: number, depth: number, slow = false, dragged = ["y"]) =>
  resolveLayerDrop({ rows, at, ratio, depth, slow, frameOnly: false, dragged: new Set(dragged) });

describe("resolveLayerDrop", () => {
  it("drops inside a container only in the middle and only while moving slowly", () => {
    expect(drop(4, 0.5, 1, true)).toMatchObject({
      parent: "x",
      below: null,
      line: { edge: "inside" },
    });
    expect(drop(4, 0.5, 1, false)).toMatchObject({ parent: "F", below: "x" });
    // Frame rows always take layers inside.
    expect(drop(5, 0.1, 1)).toMatchObject({ parent: "G", line: { edge: "inside" } });
  });

  it("picks the depth with sideways steps among the valid parents", () => {
    // Below "a", the last child of card: inside card (2) or outdented beside card (1).
    expect(drop(3, 0.9, 2)).toMatchObject({ parent: "card", below: "a", depth: 2 });
    expect(drop(3, 0.9, 1)).toMatchObject({ parent: "F", below: "card", depth: 1 });
    // Deeper than allowed clamps; between b and a only depth 2 is valid.
    expect(drop(2, 0.9, 5)).toMatchObject({ parent: "card", below: "b", depth: 2 });
    expect(drop(2, 0.9, 1)).toMatchObject({ parent: "card", below: "b", depth: 2 });
    // Under an open container: on top of its children.
    expect(drop(1, 0.9, 1)).toMatchObject({ parent: "card", below: null, depth: 2 });
  });

  it("never drops a row into itself", () => {
    expect(drop(4, 0.5, 1, true, ["x"])).not.toMatchObject({ parent: "x" });
    expect(drop(3, 0.9, 2, false, ["card"])).toBeNull();
  });

  it("reorders frames among frames", () => {
    const frames = (at: number, ratio: number) =>
      resolveLayerDrop({
        rows,
        at,
        ratio,
        depth: 0,
        slow: false,
        frameOnly: true,
        dragged: new Set(["G"]),
      });
    expect(frames(0, 0.2)).toMatchObject({ below: null, line: { key: "F", edge: "before" } });
    expect(frames(2, 0.2)).toMatchObject({ below: "F", line: { key: "F", edge: "after" } });
  });
});
