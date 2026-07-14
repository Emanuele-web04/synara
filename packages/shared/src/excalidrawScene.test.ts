import { describe, expect, it } from "vitest";

import {
  EMPTY_CANVAS_SCENE,
  InvalidCanvasSceneError,
  MAX_CANVAS_SCENE_ELEMENTS,
  parseCanvasScene,
  serializeCanvasScene,
} from "./excalidrawScene";

describe("excalidrawScene", () => {
  it("round-trips an empty scene", () => {
    expect(parseCanvasScene(serializeCanvasScene(EMPTY_CANVAS_SCENE))).toEqual(
      EMPTY_CANVAS_SCENE,
    );
  });

  it("normalizes omitted optional scene fields", () => {
    expect(parseCanvasScene('{"elements":[],"appState":{}}')).toMatchObject({
      type: "excalidraw",
      version: 2,
      files: {},
    });
  });

  it("rejects malformed JSON and excessive elements", () => {
    expect(() => parseCanvasScene("{")).toThrow(InvalidCanvasSceneError);
    expect(() =>
      serializeCanvasScene({
        ...EMPTY_CANVAS_SCENE,
        elements: Array.from({ length: MAX_CANVAS_SCENE_ELEMENTS + 1 }, () => ({})),
      }),
    ).toThrow(InvalidCanvasSceneError);
  });
});
