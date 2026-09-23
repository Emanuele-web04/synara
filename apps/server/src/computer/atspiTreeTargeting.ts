import {
  COMPUTER_TEXT_MAX_LENGTH,
  type ComputerPoint,
  type ComputerRect,
  type ComputerScreenSize,
  type ComputerUiNode,
  type ComputerWindow,
  type ComputerWindowId,
} from "@synara/contracts";

import { requireWindowBounds } from "./computerGeometry.ts";
import { clampNodeText } from "./uiTreeText.ts";

export { clampNodeText };

/**
 * The bounds `ComputerUiNode` is encoded against. An accessible name is whatever
 * the application put there — a toolkit that labels a paragraph widget with its
 * entire text, or a document title that is a full sentence per line — and
 * nothing between the toolkit and the schema caps it. Copying one through
 * verbatim fails the encode of the whole tree, which takes `computer.getState`
 * down over a single oversized label somewhere on the desktop.
 *
 * Mirrored rather than imported because the contracts package exports the text
 * bound and keeps the label one private; they are checked against each other in
 * this module's tests.
 */
const NODE_ROLE_MAX_LENGTH = 128;
const NODE_LABEL_MAX_LENGTH = 1_024;
const NODE_TEXT_MAX_LENGTH = COMPUTER_TEXT_MAX_LENGTH;

/** The small, serializable subset returned by the AT-SPI helper. */
export interface AtspiRawNode {
  readonly role: string;
  readonly label: string | null;
  readonly value: string | null;
  readonly description: string | null;
  /**
   * Extents relative to the window's own accessible (AT-SPI's WINDOW
   * coordinates). "Screen" coordinates mean nothing on Wayland — GTK and
   * Gecko report window-relative values under that name, Chromium its own
   * guess at a global position — so the helper asks for the one convention
   * every toolkit implements the same way, and fusing adds the window's
   * position from the compositor.
   */
  readonly frame: ComputerRect;
  readonly activationPoint?: ComputerPoint | null;
  /**
   * This node's index among its parent's AT-SPI children (absent on the
   * window root). The real index, not the emitted position: pruned or
   * skipped siblings would otherwise shift every later address. Paths are
   * rebuilt from these while fusing, which keeps them off the wire.
   */
  readonly i?: number;
  /** The accessible exposes the `EditableText` interface. */
  readonly editable?: boolean;
  /** The walk stopped short under this node, so `children` is incomplete. */
  readonly truncated?: boolean;
  readonly children: readonly AtspiRawNode[];
}

/** Everything the helper needs to re-resolve one node for a semantic write. */
export interface AtspiNodeAddress {
  readonly windowId: ComputerWindowId;
  readonly path: readonly number[];
}

export interface AtspiClientSize {
  readonly width: number;
  readonly height: number;
}

export interface AtspiWindowTree {
  readonly windowId: ComputerWindowId;
  readonly clientSize: AtspiClientSize;
  readonly root: AtspiRawNode;
  /**
   * `partial` when the walk was cut short anywhere (node cap, deadline, a
   * child that failed); `unavailable` when the window answered but exposes no
   * usable tree, with `reason` saying why. Absent means complete.
   */
  readonly status?: "complete" | "partial" | "unavailable";
  readonly truncated?: boolean;
  readonly reason?: string;
  /** Served from the helper's event-validated cache rather than walked. */
  readonly cached?: boolean;
}

/** Whether a tree is anything less than a complete perception of its window. */
export function atspiTreeIncomplete(tree: AtspiWindowTree): boolean {
  return tree.status === "partial" || tree.status === "unavailable" || tree.truncated === true;
}

export interface DecorationOffset {
  readonly x: number;
  readonly y: number;
}

/**
 * Derive the frame-to-client decoration offset used by the Phase 0 probe.
 *
 * Plasma's Wayland AT-SPI implementation reports widget extents relative to
 * the client surface. The observed frame has equal four-pixel side/bottom
 * borders and a 34-pixel title bar, so the horizontal difference is split
 * across both sides and the remaining vertical difference is the title bar.
 */
export function decorationOffsetForClientSize(
  frame: Pick<ComputerRect, "width" | "height">,
  client: AtspiClientSize,
): DecorationOffset {
  const horizontalDifference = Math.max(0, frame.width - client.width);
  const verticalDifference = Math.max(0, frame.height - client.height);
  const sideBorder = horizontalDifference / 2;
  return {
    x: sideBorder,
    y: Math.max(0, verticalDifference - sideBorder),
  };
}

/**
 * Fuse one helper tree with the frame bounds supplied by the KWin plugin.
 * Every descendant receives the owning window id so semantic targeting can
 * constrain matches without guessing which application owns a control.
 */
export function fuseAtspiWindowTree(input: {
  readonly window: Pick<ComputerWindow, "id" | "bounds">;
  readonly tree: AtspiWindowTree;
  readonly screenSize?: ComputerScreenSize;
}): ComputerUiNode {
  const origin = atspiWindowOrigin(input.window, input.tree.clientSize);
  const root = fuseNode(input.tree.root, [], {
    windowId: input.window.id,
    origin,
    ...(input.screenSize ? { screenSize: input.screenSize } : {}),
  });
  if (input.tree.status !== "unavailable") return root;
  // The window answered but exposes nothing to act on (Chromium without
  // renderer accessibility): keep the frame so the window is still named, say
  // why in its description, and mark it incomplete so nothing reads the
  // empty children as "no controls".
  return {
    ...root,
    description: root.description ?? clampNullableNodeText(input.tree.reason, NODE_TEXT_MAX_LENGTH),
    truncated: true,
    children: [],
  };
}

/**
 * Where a window's AT-SPI coordinates start, in the same space as its bounds.
 *
 * The one place window-relative accessibility extents become desktop
 * coordinates: both fused trees and a node re-read at dispatch go through it,
 * so they cannot disagree about the offset. A fused node's frame is
 * desktop-absolute, so the window's own origin is the one input this cannot
 * do without: without it every AT-SPI coordinate would be frame-relative while
 * claiming to be a desktop coordinate, which is the clamp bug the Tier 1 runs
 * already produced once.
 */
export function atspiWindowOrigin(
  window: Pick<ComputerWindow, "id" | "bounds">,
  clientSize: AtspiClientSize,
): ComputerPoint {
  const bounds = requireWindowBounds(window, "accessibility-tree targeting");
  const offset = decorationOffsetForClientSize(bounds, clientSize);
  return { x: bounds.x + offset.x, y: bounds.y + offset.y };
}

/** A window-relative AT-SPI rect placed in the window's coordinate space. */
export function atspiFrameInWindow(
  window: Pick<ComputerWindow, "id" | "bounds">,
  clientSize: AtspiClientSize,
  frame: ComputerRect,
): ComputerRect {
  const origin = atspiWindowOrigin(window, clientSize);
  return { x: origin.x + frame.x, y: origin.y + frame.y, width: frame.width, height: frame.height };
}

/** Combine multiple fused window trees into the root consumed by uiTreeTargeting. */
export function fuseAtspiTrees(input: {
  readonly windows: readonly ComputerWindow[];
  readonly trees: readonly AtspiWindowTree[];
  readonly screenSize: ComputerScreenSize;
  /**
   * Something the read asked for is missing — a window with no tree, a reply
   * cut at the helper's deadline. Marks the desktop root truncated, which is
   * what tells a waiting caller that absence was not established.
   */
  readonly incomplete?: boolean;
}): ComputerUiNode {
  const windowsById = new Map(input.windows.map((window) => [window.id, window]));
  const children: ComputerUiNode[] = [];
  let incomplete = input.incomplete === true;
  for (const tree of input.trees) {
    const window = windowsById.get(tree.windowId);
    if (!window || !window.visible || window.minimized) continue;
    if (atspiTreeIncomplete(tree)) incomplete = true;
    children.push(fuseAtspiWindowTree({ window, tree, screenSize: input.screenSize }));
  }
  return {
    role: "desktop",
    label: null,
    value: null,
    description: "AT-SPI desktop",
    frame: { x: 0, y: 0, width: input.screenSize.width, height: input.screenSize.height },
    activationPoint: null,
    onScreen: true,
    windowId: null,
    ...(incomplete ? { truncated: true } : {}),
    children,
  };
}

/**
 * The address of a node the AT-SPI helper can find again — its window and
 * child-index path — or `undefined` when the node did not come from a helper
 * tree.
 */
export function atspiNodeAddress(node: ComputerUiNode): AtspiNodeAddress | undefined {
  if (node.windowId === null || node.windowId === undefined) return undefined;
  const path = node.nodePath;
  if (!path || !path.every((index) => Number.isInteger(index) && index >= 0)) return undefined;
  return { windowId: node.windowId, path: [...path] };
}

/**
 * The address of a node a semantic text write may target, or `undefined` when
 * the perception source cannot address it: a node with no editable-text
 * interface, no child-index path, or no owning window has to be typed into.
 */
export function atspiTextWriteAddress(node: ComputerUiNode): AtspiNodeAddress | undefined {
  if (node.editable !== true) return undefined;
  return atspiNodeAddress(node);
}

function fuseNode(
  node: AtspiRawNode,
  path: readonly number[] | undefined,
  input: {
    readonly windowId: ComputerWindowId;
    readonly origin: ComputerPoint;
    readonly screenSize?: ComputerScreenSize;
  },
): ComputerUiNode {
  const frame = {
    x: input.origin.x + node.frame.x,
    y: input.origin.y + node.frame.y,
    width: node.frame.width,
    height: node.frame.height,
  } satisfies ComputerRect;
  const activationPoint = node.activationPoint
    ? {
        x: input.origin.x + node.activationPoint.x,
        y: input.origin.y + node.activationPoint.y,
      }
    : null;
  return {
    role: clampNodeText(node.role, NODE_ROLE_MAX_LENGTH),
    label: clampNullableNodeText(node.label, NODE_LABEL_MAX_LENGTH),
    value: clampNullableNodeText(node.value, NODE_TEXT_MAX_LENGTH),
    description: clampNullableNodeText(node.description, NODE_TEXT_MAX_LENGTH),
    frame,
    activationPoint,
    onScreen: isOnScreen(frame, input.screenSize),
    windowId: input.windowId,
    ...(path ? { nodePath: [...path] } : {}),
    ...(node.editable === true ? { editable: true } : {}),
    ...(node.truncated === true ? { truncated: true } : {}),
    // A child without its index cannot be addressed, and neither can
    // anything under it.
    children: node.children.map((child) =>
      fuseNode(child, path && child.i !== undefined ? [...path, child.i] : undefined, input),
    ),
  };
}

function clampNullableNodeText(text: string | null | undefined, maxLength: number): string | null {
  return text === null || text === undefined ? null : clampNodeText(text, maxLength);
}

function isOnScreen(frame: ComputerRect, screenSize: ComputerScreenSize | undefined): boolean {
  if (!screenSize) return true;
  return (
    frame.x < screenSize.width &&
    frame.y < screenSize.height &&
    frame.x + frame.width > 0 &&
    frame.y + frame.height > 0
  );
}
