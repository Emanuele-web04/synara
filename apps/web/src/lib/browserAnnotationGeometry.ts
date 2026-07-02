import type {
  BrowserAnnotationArrow,
  BrowserDrawingPoint,
  BrowserDrawingStroke,
  BrowserTextAnnotation,
} from "./browserEditorContext";

export interface BrowserAnnotationCoordinateGeometry {
  overlayWidth: number;
  overlayHeight: number;
  viewportWidth: number;
  viewportHeight: number;
}

export interface BrowserAnnotationViewportAnnotations {
  strokes: BrowserDrawingStroke[];
  textAnnotations: BrowserTextAnnotation[];
  arrows: BrowserAnnotationArrow[];
}

function safeScale(numerator: number, denominator: number): number {
  // A zero/unmeasured viewport dimension must fall back to identity, not scale
  // everything to the origin and destroy the annotation coordinates.
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    numerator <= 0 ||
    denominator <= 0
  ) {
    return 1;
  }
  return numerator / denominator;
}

export function browserAnnotationCoordinateScale(geometry: BrowserAnnotationCoordinateGeometry): {
  x: number;
  y: number;
  average: number;
} {
  const x = safeScale(geometry.viewportWidth, geometry.overlayWidth);
  const y = safeScale(geometry.viewportHeight, geometry.overlayHeight);
  return {
    x,
    y,
    average: (x + y) / 2,
  };
}

export function browserOverlayPointToViewportPoint(
  point: BrowserDrawingPoint,
  geometry: BrowserAnnotationCoordinateGeometry,
): BrowserDrawingPoint {
  const scale = browserAnnotationCoordinateScale(geometry);
  return {
    x: point.x * scale.x,
    y: point.y * scale.y,
  };
}

export function convertBrowserOverlayAnnotationsToViewport(
  input: BrowserAnnotationViewportAnnotations & {
    geometry: BrowserAnnotationCoordinateGeometry;
  },
): BrowserAnnotationViewportAnnotations {
  const scale = browserAnnotationCoordinateScale(input.geometry);
  const point = (value: BrowserDrawingPoint) =>
    browserOverlayPointToViewportPoint(value, input.geometry);

  return {
    strokes: input.strokes.map((stroke) => ({
      ...stroke,
      points: stroke.points.map(point),
      ...(typeof stroke.strokeSize === "number"
        ? { strokeSize: stroke.strokeSize * scale.average }
        : {}),
    })),
    textAnnotations: input.textAnnotations.map((annotation) => ({
      ...annotation,
      ...point(annotation),
      ...(typeof annotation.boxX === "number" ? { boxX: annotation.boxX * scale.x } : {}),
      ...(typeof annotation.boxY === "number" ? { boxY: annotation.boxY * scale.y } : {}),
      ...(typeof annotation.fontSize === "number"
        ? { fontSize: annotation.fontSize * scale.y }
        : {}),
    })),
    arrows: input.arrows.map((arrow) => ({
      ...arrow,
      from: point(arrow.from),
      to: point(arrow.to),
    })),
  };
}
