import { Schema } from "effect";
import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";
import {
  DesignFrame,
  DesignFrameHeight,
  DesignFrameId,
  DesignFramePutInput,
  DesignFrameStyle,
  DesignFrameWidth,
  DesignLayerAppliedEdit,
  DesignLayerEditReceipt,
  DesignLayerId,
  DesignLayersEditInput,
  DesignLayerTree,
  DesignViewport,
} from "./designCanvas";

export const CanvasId = DesignFrameId;
/** The camera a new page starts with; a page still at it has never been placed. */
export const CANVAS_DEFAULT_VIEWPORT: DesignViewport = { x: 64, y: 80, zoom: 0.5 };
export const CANVAS_MAX_PAGES = 32;
export const CANVAS_MAX_COMMENT_THREADS = 200;
export const CANVAS_MAX_COMMENT_MESSAGES = 50;
export const CANVAS_MAX_COMMENT_LENGTH = 4000;
const Title = TrimmedNonEmptyString.check(Schema.isMaxLength(120));
const Coordinate = Schema.Finite.check(
  Schema.isBetween({ minimum: -1_000_000, maximum: 1_000_000 }),
);
const CommentText = TrimmedNonEmptyString.check(Schema.isMaxLength(CANVAS_MAX_COMMENT_LENGTH));

export const CanvasCommentAuthor = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("user") }),
  Schema.Struct({ kind: Schema.Literal("agent"), threadId: ThreadId }),
]);
export type CanvasCommentAuthor = typeof CanvasCommentAuthor.Type;
export const CanvasCommentMessage = Schema.Struct({
  id: CanvasId,
  author: CanvasCommentAuthor,
  text: CommentText,
  createdAt: Schema.String,
  /** When its author last edited it. */
  editedAt: Schema.optional(Schema.String),
});
export type CanvasCommentMessage = typeof CanvasCommentMessage.Type;
/** A comment thread pinned to a point inside a frame, optionally to one of its layers. */
export const CanvasCommentThread = Schema.Struct({
  id: CanvasId,
  frameId: DesignFrameId,
  layerId: Schema.NullOr(DesignLayerId),
  /**
   * Pin offset in frame pixels: from the layer's top-left corner when layerId is set, so the
   * pin moves with that layer, otherwise from the frame's top-left corner.
   */
  x: Coordinate,
  y: Coordinate,
  status: Schema.Literals(["open", "resolved"]),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  messages: Schema.Array(CanvasCommentMessage).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(CANVAS_MAX_COMMENT_MESSAGES),
  ),
  /**
   * When the user last opened the thread: replies after it are unread
   * (unread state is per thread). Absent: every reply by someone else is unread.
   */
  readAt: Schema.optional(Schema.String),
});
export type CanvasCommentThread = typeof CanvasCommentThread.Type;

/** An export row: a format, a size ("2x", "512w", "512h", "1080p"), a file suffix. */
export const CanvasExportFormat = Schema.Literals(["png", "jpg", "webp", "avif", "pdf"]);
export type CanvasExportFormat = typeof CanvasExportFormat.Type;
export const CanvasExportEntry = Schema.Struct({
  format: CanvasExportFormat,
  scale: Schema.String.check(Schema.isPattern(/^(?:\d+(?:\.\d+)?|\.\d+)(?:x|w|h|p)$/)),
  suffix: Schema.String.check(Schema.isMaxLength(60)),
  /** PDF only. */
  quality: Schema.optional(Schema.Literals(["high", "medium", "low"])),
});
export type CanvasExportEntry = typeof CanvasExportEntry.Type;
/** "frame:<frameId>" or "layer:<frameId>:<layerId>". */
export const CanvasExportKey = Schema.String.check(
  Schema.isPattern(
    /^(?:frame:[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}|layer:[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}:[a-zA-Z0-9][a-zA-Z0-9_-]{0,79})$/,
  ),
);
const CanvasExportEntries = Schema.Array(CanvasExportEntry).check(Schema.isMaxLength(20));

/**
 * The icons a page can wear in the page list (Synara's own set, drawn with its Central icons).
 * Writes must name one of these; a stored page keeps any key of the same shape, so a newer
 * client's icon never makes the work unreadable here (it shows the default icon instead).
 */
export const CANVAS_PAGE_ICONS = [
  "pen",
  "bezier",
  "image",
  "table",
  "slides",
  "plan",
  "swatch",
  "bar-chart",
  "line-chart",
  "pie-chart",
  "phone",
  "dashboard",
  "components",
  "sparkle",
  "archive",
] as const;
export const CanvasPageIcon = Schema.Literals(CANVAS_PAGE_ICONS);
export type CanvasPageIcon = typeof CanvasPageIcon.Type;
const StoredPageIcon = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,39}$/));
/**
 * A page's canvas colour: `#rrggbb` or `#rrggbbaa`, lowercase. Absent, the
 * canvas shows the theme's own canvas colour.
 */
export const CanvasPageColor = Schema.String.check(
  Schema.isPattern(/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/),
);
export type CanvasPageColor = typeof CanvasPageColor.Type;

export const CanvasPage = Schema.Struct({
  id: CanvasId,
  title: Title,
  viewport: DesignViewport,
  frames: Schema.Array(DesignFrame).check(Schema.isMaxLength(48)),
  comments: Schema.Array(CanvasCommentThread).check(Schema.isMaxLength(CANVAS_MAX_COMMENT_THREADS)),
  /** Export rows saved on frames and layers, on each node. */
  exportSettings: Schema.optional(Schema.Record(CanvasExportKey, CanvasExportEntries)),
  /** The page list's icon for this page; absent shows the default page icon. */
  icon: Schema.optional(StoredPageIcon),
  /** The canvas colour behind this page's frames; absent uses the theme's canvas colour. */
  color: Schema.optional(CanvasPageColor),
});
export type CanvasPage = typeof CanvasPage.Type;
/** At most this many dividers in one work's page list. */
export const CANVAS_MAX_PAGE_DIVIDERS = CANVAS_MAX_PAGES;
/**
 * A separator line in the page list. It has no canvas, so nothing can
 * be drawn on it, and it is not a page: page lists, agents and exports never see it as one.
 * It sits right above `beforePageId`, or after the last page when that is null; dividers
 * naming the same page keep their array order.
 */
export const CanvasPageDivider = Schema.Struct({
  id: CanvasId,
  beforePageId: Schema.NullOr(CanvasId),
});
export type CanvasPageDivider = typeof CanvasPageDivider.Type;
/** The frame a work shows as its library thumbnail (its cover). */
export const CanvasWorkCover = Schema.Struct({ pageId: CanvasId, frameId: DesignFrameId });
export type CanvasWorkCover = typeof CanvasWorkCover.Type;
export const CanvasImageMimeType = Schema.Literals([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);
export const CANVAS_MAX_ASSET_BYTES = 2_097_152;
/** Base64 of at most one asset's bytes. */
const AssetData = Schema.String.check(
  Schema.isMaxLength(2_796_204),
  Schema.isPattern(/^[A-Za-z0-9+/]+={0,2}$/),
);
const AssetSha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const AssetFields = {
  id: CanvasId,
  name: Title,
  mimeType: Schema.Literals(["image/png", "image/jpeg", "image/webp", "image/gif", "font/woff2"]),
  sizeBytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: CANVAS_MAX_ASSET_BYTES })),
  width: Schema.optional(Schema.Int),
  height: Schema.optional(Schema.Int),
  /** Present for catalog fonts: the family designs name, plus its @font-face descriptors. */
  font: Schema.optional(
    Schema.Struct({
      family: Title,
      weight: Schema.String.check(Schema.isPattern(/^\d{3}(?: \d{3})?$/)),
      style: Schema.Literals(["normal", "italic"]),
      unicodeRange: Schema.optional(Schema.String.check(Schema.isMaxLength(2000))),
    }),
  ),
};
/**
 * An asset with its bytes, as an import, a paste or a font download hands it to the store.
 * Version 2 work documents kept assets inline in this shape.
 */
export const CanvasAssetUpload = Schema.Struct({ ...AssetFields, data: AssetData });
export type CanvasAssetUpload = typeof CanvasAssetUpload.Type;
/**
 * A work's asset: metadata and the SHA-256 of its bytes. The bytes live in a
 * content-addressed file beside the library and load with `canvas.getAsset`.
 */
export const CanvasAsset = Schema.Struct({ ...AssetFields, sha256: AssetSha256 });
export type CanvasAsset = typeof CanvasAsset.Type;
export const CanvasAssetInput = Schema.Struct({ workId: CanvasId, assetId: CanvasId });
export type CanvasAssetInput = typeof CanvasAssetInput.Type;
export const CanvasAssetData = Schema.Struct({
  assetId: CanvasId,
  sha256: AssetSha256,
  mimeType: AssetFields.mimeType,
  data: AssetData,
});
export type CanvasAssetData = typeof CanvasAssetData.Type;
const ResourceFields = {
  id: CanvasId,
  title: Title,
  folderId: Schema.NullOr(CanvasId),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  archivedAt: Schema.NullOr(Schema.String),
};
/** Version 3 keeps asset bytes out of the document; version 2 documents are read and upgraded. */
export const CanvasWork = Schema.Struct({
  ...ResourceFields,
  version: Schema.Literal(3),
  kind: Schema.Literal("work"),
  projectId: Schema.NullOr(ProjectId),
  readOnly: Schema.optional(Schema.Boolean),
  assets: Schema.optional(Schema.Array(CanvasAsset).check(Schema.isMaxLength(192))),
  pages: Schema.Array(CanvasPage).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(CANVAS_MAX_PAGES),
  ),
  chats: Schema.Array(
    Schema.Struct({ threadId: ThreadId, pageId: CanvasId, usedAt: Schema.String }),
  ).check(Schema.isMaxLength(200)),
  /** Separators in the page list; absent when there are none (older readers see nothing new). */
  dividers: Schema.optional(
    Schema.Array(CanvasPageDivider).check(Schema.isMaxLength(CANVAS_MAX_PAGE_DIVIDERS)),
  ),
  /**
   * The frame the library shows for this work. While it names no existing frame (its frame
   * was deleted) the library falls back to the first frame, as when it is absent.
   */
  cover: Schema.optional(CanvasWorkCover),
});
export type CanvasWork = typeof CanvasWork.Type;
export const CanvasFolder = Schema.Struct({
  ...ResourceFields,
  version: Schema.Literal(2),
  kind: Schema.Literal("folder"),
});
export type CanvasFolder = typeof CanvasFolder.Type;
export const CanvasResource = Schema.Union([CanvasWork, CanvasFolder]);
export type CanvasResource = typeof CanvasResource.Type;
export const CanvasFramePreview = Schema.Struct({
  layers: DesignLayerTree,
  style: Schema.String,
  width: DesignFrameWidth,
  height: DesignFrameHeight,
});
export type CanvasFramePreview = typeof CanvasFramePreview.Type;
export const CanvasWorkSummary = Schema.Struct({
  ...ResourceFields,
  kind: Schema.Literal("work"),
  projectId: Schema.NullOr(ProjectId),
  pageCount: Schema.Int,
  frameCount: Schema.Int,
  preview: Schema.NullOr(CanvasFramePreview),
  /** The fonts and images the preview frame uses, so its thumbnail renders as on the canvas. */
  previewAssets: Schema.optional(Schema.Array(CanvasAsset).check(Schema.isMaxLength(192))),
});
export type CanvasWorkSummary = typeof CanvasWorkSummary.Type;
export const CanvasListInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  threadId: Schema.optional(ThreadId),
  folderId: Schema.optional(Schema.NullOr(CanvasId)),
  archived: Schema.optional(Schema.Boolean),
  search: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  offset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});
export type CanvasListInput = typeof CanvasListInput.Type;
export const CanvasListResult = Schema.Struct({
  works: Schema.Array(CanvasWorkSummary),
  folders: Schema.Array(CanvasFolder),
  unavailableIds: Schema.Array(Schema.String),
  total: Schema.Int,
});
export type CanvasListResult = typeof CanvasListResult.Type;
export const CanvasWorkInput = Schema.Struct({ workId: CanvasId });
export type CanvasWorkInput = typeof CanvasWorkInput.Type;
export const CanvasPageInput = Schema.Struct({ workId: CanvasId, pageId: CanvasId });
export type CanvasPageInput = typeof CanvasPageInput.Type;
export const CanvasCreateInput = Schema.Struct({
  id: CanvasId,
  title: Title,
  folderId: Schema.optional(Schema.NullOr(CanvasId)),
  projectId: Schema.optional(Schema.NullOr(ProjectId)),
});
export type CanvasCreateInput = typeof CanvasCreateInput.Type;
export const CanvasResourceUpdateInput = Schema.Struct({
  id: CanvasId,
  title: Schema.optional(Title),
  folderId: Schema.optional(Schema.NullOr(CanvasId)),
  archived: Schema.optional(Schema.Boolean),
  projectId: Schema.optional(Schema.NullOr(ProjectId)),
  /** A work's library thumbnail frame; null goes back to the first frame. */
  cover: Schema.optional(Schema.NullOr(CanvasWorkCover)),
});
export type CanvasResourceUpdateInput = typeof CanvasResourceUpdateInput.Type;
export const CanvasDuplicateInput = Schema.Struct({ workId: CanvasId, id: CanvasId, title: Title });
export type CanvasDuplicateInput = typeof CanvasDuplicateInput.Type;
/**
 * Page list changes. `move` takes a page or a divider and puts it before another page or
 * divider (`beforeId: null` puts it last). Dividers are added before an item (null: last),
 * `set_icon` with null puts a page back on the default icon, and `set_color` with null puts its
 * canvas back on the theme's colour.
 */
export const CanvasPageChangeInput = Schema.Struct({
  workId: CanvasId,
  operation: Schema.Union([
    Schema.Struct({ type: Schema.Literal("create"), id: CanvasId, title: Title }),
    Schema.Struct({ type: Schema.Literal("rename"), id: CanvasId, title: Title }),
    Schema.Struct({ type: Schema.Literal("delete"), id: CanvasId }),
    Schema.Struct({
      type: Schema.Literal("move"),
      id: CanvasId,
      beforeId: Schema.NullOr(CanvasId),
    }),
    Schema.Struct({
      type: Schema.Literal("set_icon"),
      id: CanvasId,
      icon: Schema.NullOr(CanvasPageIcon),
    }),
    Schema.Struct({
      type: Schema.Literal("set_color"),
      id: CanvasId,
      color: Schema.NullOr(CanvasPageColor),
    }),
    Schema.Struct({
      type: Schema.Literal("add_divider"),
      id: CanvasId,
      beforeId: Schema.NullOr(CanvasId),
    }),
    Schema.Struct({ type: Schema.Literal("delete_divider"), id: CanvasId }),
  ]),
});
export type CanvasPageChangeInput = typeof CanvasPageChangeInput.Type;
export const CanvasBindChatInput = Schema.Struct({
  workId: CanvasId,
  pageId: CanvasId,
  threadId: ThreadId,
});
export type CanvasBindChatInput = typeof CanvasBindChatInput.Type;
export const CanvasFrameLayoutPatch = Schema.Struct({
  id: DesignFrameId,
  x: Schema.optional(Coordinate),
  y: Schema.optional(Coordinate),
  width: Schema.optional(DesignFrameWidth),
  height: Schema.optional(DesignFrameHeight),
  title: Schema.optional(Title),
  remove: Schema.optional(Schema.Boolean),
  /** Hides or shows the frame on the canvas (layers panel eye). */
  hidden: Schema.optional(Schema.Boolean),
  /** Locks or unlocks the frame on the canvas (layers panel lock). */
  locked: Schema.optional(Schema.Boolean),
});
export type CanvasFrameLayoutPatch = typeof CanvasFrameLayoutPatch.Type;
export const CanvasPageLayoutInput = Schema.Struct({
  workId: CanvasId,
  pageId: CanvasId,
  viewport: Schema.optional(DesignViewport),
  frames: Schema.optional(Schema.Array(CanvasFrameLayoutPatch).check(Schema.isMaxLength(48))),
  /**
   * The page's frames in their new paint order, back to front (a layers panel reorder).
   * Frames it leaves out keep their relative order after the listed ones.
   */
  order: Schema.optional(Schema.Array(DesignFrameId).check(Schema.isMaxLength(48))),
  /** Replaces the export rows of each listed node; null or [] removes them. */
  exportSettings: Schema.optional(
    Schema.Array(
      Schema.Struct({ key: CanvasExportKey, entries: Schema.NullOr(CanvasExportEntries) }),
    ).check(Schema.isMaxLength(200)),
  ),
});
export type CanvasPageLayoutInput = typeof CanvasPageLayoutInput.Type;
export const CanvasPutFrameInput = Schema.Struct({
  workId: CanvasId,
  pageId: CanvasId,
  frame: DesignFramePutInput,
});
export type CanvasPutFrameInput = typeof CanvasPutFrameInput.Type;
export const CanvasEditLayersInput = Schema.Struct({
  workId: CanvasId,
  pageId: CanvasId,
  edit: DesignLayersEditInput,
});
export type CanvasEditLayersInput = typeof CanvasEditLayersInput.Type;
/** Exact frame restore for undo: frames come back with their IDs, layers and placement. */
export const CanvasRestoreFramesInput = Schema.Struct({
  workId: CanvasId,
  pageId: CanvasId,
  frames: Schema.Array(DesignFrame).check(Schema.isMaxLength(48)),
  removeFrameIds: Schema.Array(DesignFrameId).check(Schema.isMaxLength(48)),
  /**
   * Comment threads that come back with restored frames (the undo of a frame delete, which
   * deleted them). Threads whose frame is not on the page, or whose ID is taken, are skipped.
   */
  comments: Schema.optional(
    Schema.Array(CanvasCommentThread).check(Schema.isMaxLength(CANVAS_MAX_COMMENT_THREADS)),
  ),
});
export type CanvasRestoreFramesInput = typeof CanvasRestoreFramesInput.Type;
export const CanvasEditResult = Schema.Struct({
  work: CanvasWork,
  createdNodeIds: Schema.Array(DesignLayerId),
  dropped: Schema.Array(Schema.String),
});
export type CanvasEditResult = typeof CanvasEditResult.Type;

export const CanvasCommentChangeInput = Schema.Struct({
  workId: CanvasId,
  pageId: CanvasId,
  operation: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("create"),
      threadId: CanvasId,
      messageId: CanvasId,
      frameId: DesignFrameId,
      layerId: Schema.NullOr(DesignLayerId),
      x: Coordinate,
      y: Coordinate,
      text: CommentText,
    }),
    Schema.Struct({
      type: Schema.Literal("reply"),
      threadId: CanvasId,
      messageId: CanvasId,
      text: CommentText,
    }),
    Schema.Struct({
      type: Schema.Literal("set_status"),
      threadId: CanvasId,
      status: Schema.Literals(["open", "resolved"]),
    }),
    Schema.Struct({
      type: Schema.Literal("move"),
      threadId: CanvasId,
      x: Coordinate,
      y: Coordinate,
    }),
    Schema.Struct({ type: Schema.Literal("delete"), threadId: CanvasId }),
    /** Rewrites one of the caller's own messages. */
    Schema.Struct({
      type: Schema.Literal("edit_message"),
      threadId: CanvasId,
      messageId: CanvasId,
      text: CommentText,
    }),
    /** Deletes one of the caller's own replies (the first message is the thread: delete that). */
    Schema.Struct({
      type: Schema.Literal("delete_message"),
      threadId: CanvasId,
      messageId: CanvasId,
    }),
    /** The user has read the thread up to now. */
    Schema.Struct({ type: Schema.Literal("mark_read"), threadId: CanvasId }),
  ]),
});
export type CanvasCommentChangeInput = typeof CanvasCommentChangeInput.Type;

export const CanvasImportImageInput = Schema.Struct({
  workId: CanvasId,
  assetId: CanvasId,
  name: Title,
  mimeType: CanvasImageMimeType,
  data: AssetData,
});
export type CanvasImportImageInput = typeof CanvasImportImageInput.Type;

export const CanvasFontFamily = Schema.Struct({
  family: Schema.String,
  category: Schema.String,
  /** Weights available for upright text; variable families report their axis range. */
  weights: Schema.Array(Schema.Int),
  italic: Schema.Boolean,
  variable: Schema.Boolean,
});
export type CanvasFontFamily = typeof CanvasFontFamily.Type;
export const CanvasFontCatalog = Schema.Struct({
  families: Schema.Array(CanvasFontFamily),
  /** False when the catalog could not be fetched; installed work fonts still render. */
  available: Schema.Boolean,
});
export type CanvasFontCatalog = typeof CanvasFontCatalog.Type;
export const CanvasAddFontInput = Schema.Struct({
  workId: CanvasId,
  family: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
});
export type CanvasAddFontInput = typeof CanvasAddFontInput.Type;

/** Thread activity kind for the per-turn chat card; its payload is CanvasTurnActivityPayload. */
export const CANVAS_TURN_ACTIVITY_KIND = "canvas.turn";
export const CanvasTurnActivityPayload = Schema.Struct({
  workId: CanvasId,
  workTitle: Schema.String,
  pageId: CanvasId,
});
export type CanvasTurnActivityPayload = typeof CanvasTurnActivityPayload.Type;

/** What one agent turn changed on one work, shown as a chat card and restorable. */
export const CanvasTurnActivity = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.String,
  workId: CanvasId,
  workTitle: Title,
  pageId: CanvasId,
  pageTitle: Title,
  createdFrameIds: Schema.Array(DesignFrameId),
  updatedFrameIds: Schema.Array(DesignFrameId),
  firstFrameId: Schema.NullOr(DesignFrameId),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  restorable: Schema.Boolean,
  restoredAt: Schema.NullOr(Schema.String),
});
export type CanvasTurnActivity = typeof CanvasTurnActivity.Type;
export const CanvasTurnActivityInput = Schema.Struct({ threadId: ThreadId });
export type CanvasTurnActivityInput = typeof CanvasTurnActivityInput.Type;
export const CanvasTurnActivityResult = Schema.Struct({
  activities: Schema.Array(CanvasTurnActivity),
});
export type CanvasTurnActivityResult = typeof CanvasTurnActivityResult.Type;
export const CanvasRestoreTurnInput = Schema.Struct({
  workId: CanvasId,
  threadId: ThreadId,
  turnId: Schema.String,
});
export type CanvasRestoreTurnInput = typeof CanvasRestoreTurnInput.Type;

/** A layer edit as the server applied it, for clients holding the frame's previous revision. */
export const CanvasFrameDelta = Schema.Struct({
  operations: Schema.Array(DesignLayerAppliedEdit).check(Schema.isMaxLength(100)),
  /** The frame's style after the edit; absent when it has none. */
  style: Schema.optional(DesignFrameStyle),
  lastLayerEdit: DesignLayerEditReceipt,
});
export type CanvasFrameDelta = typeof CanvasFrameDelta.Type;

/**
 * A committed change. Without a scope anything may have changed (a new subscription, lost
 * events, a folder archive). `library` changes only the list and folders. `work` changes one
 * work: its `updatedAt` after and before the commit order the events, and a layer edit names
 * its page, frame and new revision with an optional delta. A client applies the delta only
 * when it holds exactly the previous state; otherwise it refetches that one work.
 */
export const CanvasChangedEvent = Schema.Struct({
  type: Schema.Literal("changed"),
  scope: Schema.optional(Schema.Literals(["library", "work"])),
  workId: Schema.optional(CanvasId),
  updatedAt: Schema.optional(Schema.String),
  previousUpdatedAt: Schema.optional(Schema.String),
  pageId: Schema.optional(CanvasId),
  frameId: Schema.optional(DesignFrameId),
  revision: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  mutationId: Schema.optional(DesignFrameId),
  delta: Schema.optional(CanvasFrameDelta),
});
export type CanvasChangedEvent = typeof CanvasChangedEvent.Type;

/**
 * What an agent did to the layers an activity event names: read them, wrote new ones, edited
 * existing ones or deleted them.
 */
export const CanvasAgentActivityKind = Schema.Literals(["read", "write", "edit", "delete"]);
export type CanvasAgentActivityKind = typeof CanvasAgentActivityKind.Type;
/** Layer IDs an activity event lists per frame; more are left out. */
export const CANVAS_ACTIVITY_MAX_LAYERS = 200;
/** At most this many layers per measure request, and styles for at most this many. */
export const CANVAS_MEASURE_MAX_LAYERS = 3000;
export const CANVAS_MEASURE_MAX_STYLED_LAYERS = 20;

/** Invalidations, optionally with a delta: one notification also covers dropped predecessors. */
export const CanvasStreamEvent = Schema.Union([
  CanvasChangedEvent,
  /**
   * Frames (and layers) an agent is working on right now; the badge expires on its own.
   * Without `kind` the event is a write, as older servers sent it. An `ended` event says
   * the thread's turn ended: drop its activity on this page.
   */
  Schema.Struct({
    type: Schema.Literal("activity"),
    workId: CanvasId,
    pageId: CanvasId,
    frameIds: Schema.Array(DesignFrameId),
    threadId: ThreadId,
    expiresAt: Schema.String,
    kind: Schema.optional(CanvasAgentActivityKind),
    /** Per frame of `frameIds`, the layers involved; a frame left out means the whole frame. */
    layerIds: Schema.optional(
      Schema.Record(
        DesignFrameId,
        Schema.Array(DesignLayerId).check(Schema.isMaxLength(CANVAS_ACTIVITY_MAX_LAYERS)),
      ),
    ),
    ended: Schema.optional(Schema.Boolean),
  }),
  /**
   * An agent asked for a screenshot (or, with `measure`, for layer boxes); any connected
   * editor client may answer it. `maxSide` caps the image and is ignored when measuring.
   */
  Schema.Struct({
    type: Schema.Literal("render"),
    requestId: CanvasId,
    workId: CanvasId,
    pageId: CanvasId,
    frameId: Schema.NullOr(DesignFrameId),
    maxSide: Schema.Int.check(Schema.isBetween({ minimum: 64, maximum: 4096 })),
    /** Crop the frame to this layer's box (needs `frameId`). */
    layerId: Schema.optional(DesignLayerId),
    /** Image pixels per design pixel, still capped by `maxSide`. */
    scale: Schema.optional(Schema.Literals([1, 2])),
    /** Answer with the boxes of these layers of `frameId` instead of an image. */
    measure: Schema.optional(
      Schema.Struct({
        layerIds: Schema.Array(DesignLayerId).check(Schema.isMaxLength(CANVAS_MEASURE_MAX_LAYERS)),
        /** Also report computed styles (for at most CANVAS_MEASURE_MAX_STYLED_LAYERS). */
        styles: Schema.optional(Schema.Boolean),
      }),
    ),
  }),
]);
export type CanvasStreamEvent = typeof CanvasStreamEvent.Type;

/** A layer's border box in frame pixels as an open window laid it out. */
export const CanvasMeasuredLayer = Schema.Struct({
  id: DesignLayerId,
  x: Schema.Finite,
  y: Schema.Finite,
  width: Schema.Finite,
  height: Schema.Finite,
  styles: Schema.optional(
    Schema.Record(Schema.String, Schema.String.check(Schema.isMaxLength(2000))),
  ),
});
export type CanvasMeasuredLayer = typeof CanvasMeasuredLayer.Type;

export const CanvasSubmitRenderInput = Schema.Struct({
  requestId: CanvasId,
  result: Schema.Union([
    Schema.Struct({
      png: Schema.String.check(
        Schema.isMaxLength(8_000_000),
        Schema.isPattern(/^[A-Za-z0-9+/]+={0,2}$/),
      ),
      width: Schema.Int,
      height: Schema.Int,
    }),
    Schema.Struct({ error: Schema.String.check(Schema.isMaxLength(500)) }),
    /** The answer to a `measure` request. */
    Schema.Struct({
      layers: Schema.Array(CanvasMeasuredLayer).check(
        Schema.isMaxLength(CANVAS_MEASURE_MAX_LAYERS),
      ),
    }),
  ]),
});
export type CanvasSubmitRenderInput = typeof CanvasSubmitRenderInput.Type;
export const CanvasSubmitRenderResult = Schema.Struct({ accepted: Schema.Boolean });
export type CanvasSubmitRenderResult = typeof CanvasSubmitRenderResult.Type;

/** What the user has selected on the canvas shown beside a chat; sent with that chat's turns. */
export const CanvasChatSelectionInput = Schema.Struct({
  threadId: ThreadId,
  workId: CanvasId,
  pageId: CanvasId,
  items: Schema.Array(
    Schema.Struct({ frameId: DesignFrameId, layerId: Schema.NullOr(DesignLayerId) }),
  ).check(Schema.isMaxLength(50)),
});
export type CanvasChatSelectionInput = typeof CanvasChatSelectionInput.Type;
