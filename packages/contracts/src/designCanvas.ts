import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas";

export const DESIGN_CANVAS_MAX_FRAMES = 48;
/** Serialized inline-styled HTML of one frame. Inline styles cost more bytes than classes. */
export const DESIGN_CANVAS_MAX_SOURCE_BYTES = 192 * 1024;
export const DESIGN_CANVAS_MAX_LAYERS = 3000;
export const DESIGN_CANVAS_MAX_DEPTH = 64;
/**
 * Layers one inline SVG may hold (its root, shapes, definitions and title text). They count
 * toward the frame's layer, depth and source limits too; this keeps one icon from taking them.
 */
export const DESIGN_CANVAS_MAX_SVG_LAYERS = 1000;
export const DESIGN_FRAME_MIN_SIZE = 16;
export const DESIGN_FRAME_MAX_WIDTH = 4096;
export const DESIGN_FRAME_MAX_HEIGHT = 16384;
export const DESIGN_CANVAS_MIN_ZOOM = 0.05;
export const DESIGN_CANVAS_MAX_ZOOM = 8;
const Coordinate = Schema.Finite.check(
  Schema.isBetween({ minimum: -1_000_000, maximum: 1_000_000 }),
);
export const DesignFrameWidth = Schema.Int.check(
  Schema.isBetween({ minimum: DESIGN_FRAME_MIN_SIZE, maximum: DESIGN_FRAME_MAX_WIDTH }),
);
export const DesignFrameHeight = Schema.Int.check(
  Schema.isBetween({ minimum: DESIGN_FRAME_MIN_SIZE, maximum: DESIGN_FRAME_MAX_HEIGHT }),
);
export const DesignFrameId = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/),
);
export const DesignLayerId = DesignFrameId;
const LayerString = Schema.String.check(Schema.isMaxLength(DESIGN_CANVAS_MAX_SOURCE_BYTES));
/** Inline declarations of the frame itself (its fill, layout and padding). */
export const DesignFrameStyle = Schema.String.check(Schema.isMaxLength(16 * 1024));
export const DesignLayer = Schema.Union([
  Schema.Struct({
    id: DesignLayerId,
    type: Schema.Literal("element"),
    tag: Schema.String.check(Schema.isMaxLength(32)),
    attributes: Schema.Record(Schema.String, LayerString),
    children: Schema.Array(DesignLayerId).check(Schema.isMaxLength(DESIGN_CANVAS_MAX_LAYERS)),
  }),
  Schema.Struct({ id: DesignLayerId, type: Schema.Literal("text"), text: LayerString }),
]);
export type DesignLayer = typeof DesignLayer.Type;
export const DesignLayerTree = Schema.Struct({
  roots: Schema.Array(DesignLayerId).check(Schema.isMaxLength(DESIGN_CANVAS_MAX_LAYERS)),
  nodes: Schema.Array(DesignLayer).check(Schema.isMaxLength(DESIGN_CANVAS_MAX_LAYERS)),
});
export type DesignLayerTree = typeof DesignLayerTree.Type;
export const DesignViewport = Schema.Struct({
  x: Coordinate,
  y: Coordinate,
  zoom: Schema.Finite.check(
    Schema.isBetween({ minimum: DESIGN_CANVAS_MIN_ZOOM, maximum: DESIGN_CANVAS_MAX_ZOOM }),
  ),
});
export type DesignViewport = typeof DesignViewport.Type;
/** One `duplicate` operation's copy: its root and every original layer ID mapped to its copy. */
export const DesignLayerDuplicate = Schema.Struct({
  sourceId: DesignLayerId,
  newId: DesignLayerId,
  idMap: Schema.Record(Schema.String, DesignLayerId),
});
export type DesignLayerDuplicate = typeof DesignLayerDuplicate.Type;
/** The last layer edit a frame applied, so a retried mutation ID returns the same result. */
export const DesignLayerEditReceipt = Schema.Struct({
  mutationId: DesignFrameId,
  fingerprint: Schema.String,
  createdNodeIds: Schema.Array(DesignLayerId),
  /** Present when the edit duplicated layers. */
  duplicates: Schema.optional(Schema.Array(DesignLayerDuplicate).check(Schema.isMaxLength(100))),
  /** Declarations the edit left out (agent edits only), as the first answer reported them. */
  dropped: Schema.optional(Schema.Array(Schema.String).check(Schema.isMaxLength(100))),
});
export type DesignLayerEditReceipt = typeof DesignLayerEditReceipt.Type;
export const DesignFrame = Schema.Struct({
  id: DesignFrameId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  x: Coordinate,
  y: Coordinate,
  width: DesignFrameWidth,
  height: DesignFrameHeight,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  style: Schema.optional(DesignFrameStyle),
  layers: DesignLayerTree,
  lastLayerEdit: Schema.optional(DesignLayerEditReceipt),
  /** Hidden from the canvas (the frame's eye in the layers panel). Absent means shown. */
  hidden: Schema.optional(Schema.Boolean),
  /** Not selectable or editable on the canvas (the frame's lock). Absent means unlocked. */
  locked: Schema.optional(Schema.Boolean),
});
export type DesignFrame = typeof DesignFrame.Type;
/**
 * Zero creates; an existing view requires its current revision. HTML may carry <style>
 * blocks and `css` adds a stylesheet: both are inlined into layer styles on import.
 */
export const DesignFramePutInput = Schema.Struct({
  id: DesignFrameId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  html: Schema.String.check(Schema.isMaxLength(DESIGN_CANVAS_MAX_SOURCE_BYTES)),
  css: Schema.optional(Schema.String.check(Schema.isMaxLength(DESIGN_CANVAS_MAX_SOURCE_BYTES))),
  style: Schema.optional(DesignFrameStyle),
  width: DesignFrameWidth,
  height: DesignFrameHeight,
  x: Schema.optional(Coordinate),
  y: Schema.optional(Coordinate),
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type DesignFramePutInput = typeof DesignFramePutInput.Type;

const StylePatch = Schema.Record(Schema.String, Schema.NullOr(LayerString));
const SetTextEdit = Schema.Struct({
  type: Schema.Literal("set_text"),
  nodeId: DesignLayerId,
  text: LayerString,
});
const SetAttributesEdit = Schema.Struct({
  type: Schema.Literal("set_attributes"),
  nodeId: DesignLayerId,
  attributes: Schema.Record(Schema.String, Schema.NullOr(LayerString)),
});
/** Re-inserts known layers with their IDs, e.g. to undo a delete. IDs must be unused. */
const InsertLayersEdit = Schema.Struct({
  type: Schema.Literal("insert_layers"),
  parentId: Schema.NullOr(DesignLayerId),
  beforeId: Schema.optional(DesignLayerId),
  layers: DesignLayerTree,
});
const MoveEdit = Schema.Struct({
  type: Schema.Literal("move"),
  nodeId: DesignLayerId,
  parentId: Schema.NullOr(DesignLayerId),
  beforeId: Schema.optional(DesignLayerId),
});
const DeleteEdit = Schema.Struct({ type: Schema.Literal("delete"), nodeId: DesignLayerId });
export const DesignLayerEdit = Schema.Union([
  SetTextEdit,
  SetAttributesEdit,
  Schema.Struct({ type: Schema.Literal("set_styles"), nodeId: DesignLayerId, styles: StylePatch }),
  Schema.Struct({ type: Schema.Literal("set_frame_styles"), styles: StylePatch }),
  Schema.Struct({
    type: Schema.Literal("insert_html"),
    parentId: Schema.NullOr(DesignLayerId),
    beforeId: Schema.optional(DesignLayerId),
    html: LayerString,
    css: Schema.optional(LayerString),
  }),
  InsertLayersEdit,
  MoveEdit,
  DeleteEdit,
  /**
   * Copies a layer and its subtree with new IDs. Without parentId the copy goes right after
   * the original; with it (null is the frame root) before beforeId or at the end.
   */
  Schema.Struct({
    type: Schema.Literal("duplicate"),
    nodeId: DesignLayerId,
    parentId: Schema.optional(Schema.NullOr(DesignLayerId)),
    beforeId: Schema.optional(DesignLayerId),
  }),
  /** Removes a layer and puts the parsed HTML, with new IDs, in the same sibling slot. */
  Schema.Struct({
    type: Schema.Literal("replace_html"),
    nodeId: DesignLayerId,
    html: LayerString,
    css: Schema.optional(LayerString),
  }),
]);
export type DesignLayerEdit = typeof DesignLayerEdit.Type;
/**
 * An edit as the server applied it, so a client can replay it without parsing HTML or CSS:
 * set_styles becomes the resulting style attribute, insert_html and duplicate the layers they
 * created, replace_html those layers followed by the delete. Frame styles travel separately
 * as the frame's resulting style.
 */
export const DesignLayerAppliedEdit = Schema.Union([
  SetTextEdit,
  SetAttributesEdit,
  InsertLayersEdit,
  MoveEdit,
  DeleteEdit,
]);
export type DesignLayerAppliedEdit = typeof DesignLayerAppliedEdit.Type;
/**
 * `expectedRevision` is optional for editor and agent edits alike: without it, the batch
 * merges onto the latest revision and fails only when a target layer no longer exists.
 * With it, a stale revision refuses the batch.
 */
export const DesignLayersEditInput = Schema.Struct({
  frameId: DesignFrameId,
  expectedRevision: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  mutationId: DesignFrameId,
  operations: Schema.Array(DesignLayerEdit).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
});
export type DesignLayersEditInput = typeof DesignLayersEditInput.Type;
