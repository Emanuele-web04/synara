// FILE: canvasLayerDrop.ts
// Purpose: Where a row dragged in the layers panel lands: the top or bottom 24% of a row drops beside it, the middle inside it but
//          only while the pointer moves slowly, and moving sideways in 15 px steps picks the
//          nesting depth among the parents that are valid there. Pure: rows in, a target out.
// Layer: Canvas editor layers panel
// Exports: LAYER_DROP_EDGE, LAYER_DEPTH_STEP, LAYER_ROW_HEIGHT, LAYER_INDENT, LAYER_AUTOSCROLL_EDGE,
//          LAYER_INSIDE_MAX_SPEED, DropRow, LayerDrop, resolveLayerDrop

/** The top and bottom share of a row that drop beside it rather than inside it. */
export const LAYER_DROP_EDGE = 0.24;
/** Sideways pointer travel per nesting level while dragging. */
export const LAYER_DEPTH_STEP = 15;
/** The row height and indent per level. */
export const LAYER_ROW_HEIGHT = 28;
export const LAYER_INDENT = 16;
/** The tree scrolls while the pointer is this close to its top or bottom edge. */
export const LAYER_AUTOSCROLL_EDGE = 20;
/**
 * "Inside" needs the pointer to be moving slower than this (px per ms).
 */
export const LAYER_INSIDE_MAX_SPEED = 0.3;

/** A row as the drop logic sees it, in list order (the front-most layer first). */
export type DropRow = {
  key: string;
  depth: number;
  /** The parent row's key (null for a frame row). */
  parent: string | null;
  /** Can hold layers (a frame or a container element). */
  container: boolean;
  /** Its children are listed below it. */
  open: boolean;
};

/**
 * Where a drop lands: inside `parent` (a row key), visually just below the row `below`
 * (which, front-most first, means behind it in paint order) or on top of all of `parent`'s
 * children when `below` is null. `line` is the row the indicator is drawn under (`above`:
 * over it) at `depth`.
 */
export type LayerDrop = {
  parent: string;
  below: string | null;
  depth: number;
  line: { key: string; edge: "before" | "after" | "inside" };
};

/**
 * Resolves a drop over `rows[at]`. `ratio` is the pointer's height within that row (0 top,
 * 1 bottom), `depth` the nesting level the pointer's sideways position asks for, `slow`
 * whether it moves slowly enough for "inside", `frameOnly` whether frames are dragged (they
 * only reorder among frames). `dragged` keys cannot become their own parents.
 */
export function resolveLayerDrop(input: {
  rows: readonly DropRow[];
  at: number;
  ratio: number;
  depth: number;
  slow: boolean;
  frameOnly: boolean;
  dragged: ReadonlySet<string>;
}): LayerDrop | null {
  const { rows, at, ratio, slow, frameOnly, dragged } = input;
  const row = rows[at];
  if (!row) return null;
  const byKey = new Map(rows.map((entry) => [entry.key, entry]));
  const insideDragged = (key: string | null) => {
    for (let current = key; current; current = byKey.get(current)?.parent ?? null)
      if (dragged.has(current)) return true;
    return false;
  };
  if (frameOnly) {
    // Frames reorder among frames: above or below the frame the pointer is over.
    const frame = rowFrame(byKey, row);
    const edge = ratio < 0.5 && row === frame ? "before" : "after";
    const index = rows.indexOf(frame);
    const previous = rows.slice(0, index).findLast((entry) => entry.depth === 0) ?? null;
    return {
      parent: "",
      below: edge === "after" ? frame.key : (previous?.key ?? null),
      depth: 0,
      line: { key: frame.key, edge },
    };
  }
  const middle = ratio > LAYER_DROP_EDGE && ratio < 1 - LAYER_DROP_EDGE;
  if (row.container && (row.depth === 0 || (middle && slow)) && !insideDragged(row.key))
    return {
      parent: row.key,
      below: null,
      depth: row.depth + 1,
      line: { key: row.key, edge: "inside" },
    };
  // A gap between two rows: `upper` above it, `lower` below it.
  const before = ratio < 0.5;
  const upper = before ? rows[at - 1] : row;
  const lower = before ? row : rows[at + 1];
  if (!upper) {
    // Above the first row: on top inside its parent.
    if (!lower?.parent || insideDragged(lower.parent)) return null;
    return {
      parent: lower.parent,
      below: null,
      depth: lower.depth,
      line: { key: lower.key, edge: "before" },
    };
  }
  // The deepest level: as a sibling of `upper`, or as the first child of an open `upper`.
  const deepest =
    upper.open && upper.container && lower?.parent === upper.key ? upper.depth + 1 : upper.depth;
  // The shallowest: the level of the row below the gap (outdenting past the end of a list).
  const shallowest = Math.max(1, lower && lower.parent !== null ? lower.depth : 1);
  const depth = Math.max(Math.min(input.depth, deepest), Math.min(shallowest, deepest));
  if (depth === upper.depth + 1) {
    if (insideDragged(upper.key)) return null;
    return { parent: upper.key, below: null, depth, line: { key: upper.key, edge: "after" } };
  }
  // The ancestor of `upper` at this depth: the drop goes visually below it, in its parent.
  let sibling: DropRow = upper;
  while (sibling.depth > depth) sibling = byKey.get(sibling.parent!)!;
  if (!sibling.parent || insideDragged(sibling.parent)) return null;
  return {
    parent: sibling.parent,
    below: sibling.key,
    depth,
    line: { key: upper.key, edge: "after" },
  };
}

function rowFrame(byKey: ReadonlyMap<string, DropRow>, row: DropRow): DropRow {
  let current = row;
  while (current.parent) current = byKey.get(current.parent)!;
  return current;
}
