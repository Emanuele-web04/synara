import { describe, expect, it } from "vitest";

import {
  browserOverlayPointToViewportPoint,
  convertBrowserOverlayAnnotationsToViewport,
} from "./browserAnnotationGeometry";

const geometry = {
  overlayWidth: 1200,
  overlayHeight: 900,
  viewportWidth: 800,
  viewportHeight: 600,
};

describe("browser annotation geometry", () => {
  it("maps overlay points into guest viewport coordinates", () => {
    expect(browserOverlayPointToViewportPoint({ x: 600, y: 450 }, geometry)).toEqual({
      x: 400,
      y: 300,
    });
  });

  it("converts visual annotation positions and display sizes", () => {
    const converted = convertBrowserOverlayAnnotationsToViewport({
      geometry,
      strokes: [
        {
          id: "stroke-1",
          points: [
            { x: 0, y: 0 },
            { x: 1200, y: 900 },
          ],
          strokeSize: 6,
          animated: true,
        },
      ],
      textAnnotations: [
        {
          id: "note-1",
          x: 300,
          y: 180,
          boxX: 360,
          boxY: 90,
          text: "Check this",
          fontSize: 18,
        },
      ],
      arrows: [
        {
          id: "arrow-1",
          from: { x: 360, y: 90 },
          to: { x: 900, y: 450 },
          sourceTextAnnotationId: "note-1",
          sourceHandle: "right",
        },
      ],
    });

    expect(converted.strokes[0]).toMatchObject({
      id: "stroke-1",
      strokeSize: 4,
      animated: true,
      points: [
        { x: 0, y: 0 },
        { x: 800, y: 600 },
      ],
    });
    expect(converted.textAnnotations[0]).toMatchObject({
      id: "note-1",
      x: 200,
      y: 120,
      boxX: 240,
      boxY: 60,
      fontSize: 12,
    });
    expect(converted.arrows[0]).toMatchObject({
      id: "arrow-1",
      from: { x: 240, y: 60 },
      to: { x: 600, y: 300 },
      sourceTextAnnotationId: "note-1",
      sourceHandle: "right",
    });
  });

  it("falls back to identity scale for invalid overlay dimensions", () => {
    expect(
      convertBrowserOverlayAnnotationsToViewport({
        geometry: {
          overlayWidth: 0,
          overlayHeight: Number.NaN,
          viewportWidth: 800,
          viewportHeight: 600,
        },
        strokes: [{ id: "stroke-1", points: [{ x: 12, y: 34 }], strokeSize: 5 }],
        textAnnotations: [],
        arrows: [],
      }).strokes[0],
    ).toMatchObject({
      points: [{ x: 12, y: 34 }],
      strokeSize: 5,
    });
  });
});
