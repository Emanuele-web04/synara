import { CanvasScene, type CanvasScene as CanvasSceneType } from "@synara/contracts";
import { Schema } from "effect";

export const MAX_CANVAS_SCENE_BYTES = 5_000_000;
export const MAX_CANVAS_SCENE_ELEMENTS = 20_000;

export const EMPTY_CANVAS_SCENE: CanvasSceneType = {
  type: "excalidraw",
  version: 2,
  source: "https://synara.app",
  elements: [],
  appState: {},
  files: {},
};

export class InvalidCanvasSceneError extends Error {
  readonly name = "InvalidCanvasSceneError";
}

export function normalizeCanvasScene(value: unknown): CanvasSceneType {
  const candidate =
    value && typeof value === "object" && !Array.isArray(value)
      ? {
          type: "excalidraw",
          version: 2,
          source: "https://synara.app",
          appState: {},
          files: {},
          ...value,
        }
      : value;

  let scene: CanvasSceneType;
  try {
    scene = Schema.decodeUnknownSync(CanvasScene)(candidate);
  } catch (cause) {
    throw new InvalidCanvasSceneError(
      cause instanceof Error ? cause.message : "Invalid Excalidraw scene",
    );
  }
  if (scene.elements.length > MAX_CANVAS_SCENE_ELEMENTS) {
    throw new InvalidCanvasSceneError(
      `Canvas scene exceeds the ${MAX_CANVAS_SCENE_ELEMENTS} element limit.`,
    );
  }
  return scene;
}

export function serializeCanvasScene(value: unknown): string {
  const serialized = `${JSON.stringify(normalizeCanvasScene(value), null, 2)}\n`;
  if (new TextEncoder().encode(serialized).byteLength > MAX_CANVAS_SCENE_BYTES) {
    throw new InvalidCanvasSceneError(
      `Canvas scene exceeds the ${MAX_CANVAS_SCENE_BYTES} byte limit.`,
    );
  }
  return serialized;
}

export function parseCanvasScene(contents: string): CanvasSceneType {
  if (new TextEncoder().encode(contents).byteLength > MAX_CANVAS_SCENE_BYTES) {
    throw new InvalidCanvasSceneError(
      `Canvas scene exceeds the ${MAX_CANVAS_SCENE_BYTES} byte limit.`,
    );
  }
  try {
    return normalizeCanvasScene(JSON.parse(contents));
  } catch (cause) {
    if (cause instanceof InvalidCanvasSceneError) throw cause;
    throw new InvalidCanvasSceneError(
      cause instanceof Error ? cause.message : "Invalid Excalidraw JSON",
    );
  }
}
