import { describe, expect, it } from "vitest";

import { applyElementOperations } from "./scene";

describe("applyElementOperations", () => {
  it("preserves unaffected elements, replaces stable ids, and deletes requested ids", () => {
    const scene = {
      elements: [
        { id: "keep", type: "rectangle" },
        { id: "replace", type: "text", text: "old" },
        { id: "replace-label", type: "text", containerId: "replace", text: "old label" },
        { id: "remove", type: "arrow" },
      ],
      appState: {},
      files: {},
    };
    expect(
      applyElementOperations(scene, [
        { type: "delete", ids: "remove" },
        { id: "replace", type: "text", text: "new" },
      ]).elements,
    ).toEqual([
      { id: "keep", type: "rectangle" },
      { id: "replace", type: "text", text: "new" },
    ]);
  });

  it("rejects missing or duplicate ids instead of dropping unrelated elements", () => {
    const scene = {
      elements: [{ id: "keep", type: "rectangle" }],
      appState: {},
      files: {},
    };

    expect(() => applyElementOperations(scene, [{ type: "rectangle" }])).toThrow(
      /non-empty string id/,
    );
    expect(() =>
      applyElementOperations(scene, [
        { id: "duplicate", type: "rectangle" },
        { id: "duplicate", type: "text" },
      ]),
    ).toThrow(/Duplicate Excalidraw element id/);
    expect(scene.elements).toEqual([{ id: "keep", type: "rectangle" }]);
  });
});
