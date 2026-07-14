import { Schema } from "effect";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas";

export const CanvasScene = Schema.Struct({
  type: Schema.optional(Schema.Literal("excalidraw")),
  version: Schema.optional(Schema.Number),
  source: Schema.optional(Schema.String),
  elements: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  appState: Schema.Record(Schema.String, Schema.Unknown),
  files: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
export type CanvasScene = typeof CanvasScene.Type;

export const CanvasDrawingRef = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  threadId: ThreadId,
});
export type CanvasDrawingRef = typeof CanvasDrawingRef.Type;

const CanvasDrawingTarget = Schema.Struct({ threadId: ThreadId });

export const CanvasDrawingCreateInput = CanvasDrawingTarget;
export type CanvasDrawingCreateInput = typeof CanvasDrawingCreateInput.Type;

export const CanvasDrawingReadInput = CanvasDrawingTarget;
export type CanvasDrawingReadInput = typeof CanvasDrawingReadInput.Type;

export const CanvasDrawingSaveInput = Schema.Struct({
  ...CanvasDrawingTarget.fields,
  scene: CanvasScene,
  expectedRevision: TrimmedNonEmptyString,
});
export type CanvasDrawingSaveInput = typeof CanvasDrawingSaveInput.Type;

export const CanvasDrawingDeleteInput = CanvasDrawingTarget;
export type CanvasDrawingDeleteInput = typeof CanvasDrawingDeleteInput.Type;

export interface CanvasDrawingSnapshot {
  readonly relativePath: string;
  readonly scene: CanvasScene;
  readonly revision: string;
}

export interface CanvasDrawingDeleteResult {
  readonly deleted: boolean;
}
