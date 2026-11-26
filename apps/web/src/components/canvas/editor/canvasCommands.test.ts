import { describe, expect, it } from "vitest";
import { arrangedOrder } from "./canvasCommands";

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
