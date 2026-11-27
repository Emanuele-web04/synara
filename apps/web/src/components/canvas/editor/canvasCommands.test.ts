import { describe, expect, it } from "vitest";
import { arrangedOrder, reachableFrames } from "./canvasCommands";

const order = ["a", "b", "c", "d", "e"];

describe("arrangedOrder (B18)", () => {
  it("brings to front and sends to back keeping the selected layers' order", () => {
    expect(arrangedOrder(order, new Set(["d", "b"]), "front")).toEqual(["a", "c", "e", "b", "d"]);
    expect(arrangedOrder(order, new Set(["d", "b"]), "back")).toEqual(["b", "d", "a", "c", "e"]);
  });

  it("steps each selected layer past one unselected neighbour", () => {
    expect(arrangedOrder(order, new Set(["b", "c"]), "forward")).toEqual(["a", "d", "b", "c", "e"]);
    expect(arrangedOrder(order, new Set(["b", "c"]), "backward")).toEqual([
      "b",
      "c",
      "a",
      "d",
      "e",
    ]);
    // Already at the end: nothing to step past.
    expect(arrangedOrder(order, new Set(["d", "e"]), "forward")).toEqual(order);
  });
});

const frame = (id: string, flags: { hidden?: boolean; locked?: boolean } = {}) => ({
  id,
  title: id,
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  revision: 1,
  layers: { roots: [], nodes: [] },
  ...flags,
});

describe("reachableFrames", () => {
  it("leaves hidden and locked frames out of select-all, select-others and N", () => {
    const frames = [
      frame("a"),
      frame("h", { hidden: true }),
      frame("l", { locked: true }),
      frame("b"),
    ];
    expect(reachableFrames(frames).map((item) => item.id)).toEqual(["a", "b"]);
  });
});
