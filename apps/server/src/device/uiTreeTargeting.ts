/**
 * Resolving an accessibility node to the point that actually taps it.
 *
 * Agents are bad at coordinate arithmetic and worse at knowing which
 * coordinate of a node is the live one, so this module is the single place
 * that answers "where do I tap to hit the thing called X". Both the MCP
 * `device_tap` tool and any future caller go through it rather than each
 * re-deriving a centre point from a frame.
 *
 * Two rules carry most of the value:
 *
 * - The tap point is the node's `activationPoint` when it has one. UIKit
 *   merges a settings row and the control inside it into one element whose
 *   frame spans the row, so the frame centre of a switch row is dead space.
 * - A match that is scrolled out of view is refused rather than tapped. Its
 *   frame is still in the tree with off-screen coordinates, and tapping it
 *   would hit whatever happens to be at that position instead.
 *
 * The matching itself — exact label before substring, ambiguity refused rather
 * than guessed — is `@synara/shared/uiTreeTargeting`, shared with the desktop
 * family. What stays here is what UIKit specifically needs: labels compared
 * with case and surrounding space ignored, a subrole that counts as a role, and
 * "on screen" meaning the tap point falls inside the display's own frame.
 *
 * @module device/uiTreeTargeting
 */
import type { DeviceUiNode, DeviceUiPoint } from "@synara/contracts";
import {
  flattenUiTree,
  resolveUiTreeTarget,
  uiTreeActivationPoint,
  type UiTreeTargetSpec,
} from "@synara/shared/uiTreeTargeting";

/**
 * What the caller asked for: a label, an accessibility identifier, or both.
 * Role narrows an ambiguous match.
 *
 * The identifier is the handle a test should prefer when the app sets one: it
 * survives localization and copy changes, where a label does not.
 */
export interface DeviceUiTarget {
  readonly label?: string | undefined;
  readonly identifier?: string | undefined;
  readonly role?: string | undefined;
}

/** "labelled \"Sign in\"" or "with identifier #login-button", for error messages. */
export function targetPhrase(target: DeviceUiTarget): string {
  return target.identifier === undefined
    ? `labelled ${JSON.stringify(target.label ?? "")}`
    : `with identifier ${describeTarget(target)}`;
}

/** How a target reads in messages: `"Sign in"`, `#login-button`, or both. */
export function describeTarget(target: DeviceUiTarget): string {
  const parts = [
    ...(target.identifier === undefined ? [] : [`#${target.identifier}`]),
    ...(target.label === undefined ? [] : [JSON.stringify(target.label)]),
  ];
  return parts.join(" ") || "(no target)";
}

export interface DeviceUiTargetMatch {
  readonly point: DeviceUiPoint;
  readonly node: DeviceUiNode;
  /** False when the match is in the tree but scrolled out of the display. */
  readonly onScreen: boolean;
}

export class DeviceUiTargetError extends Error {
  /** Candidate descriptions, so the agent can retry with a real label. */
  readonly candidates: readonly string[];
  /**
   * True when nothing matched the label at all.
   *
   * Distinguished from an ambiguous or off-screen match because long lists are
   * virtualized: UIKit only materializes the rows near the viewport, so a row
   * further down is genuinely absent from the tree until scrolling reaches it.
   * A scroll loop must keep looking; an ambiguity must not be retried.
   */
  readonly notFound: boolean;

  constructor(message: string, candidates: readonly string[] = [], notFound = false) {
    // Candidates go in the message, not just a field: every transport between
    // here and the agent (MCP tool errors, WsRpcError) carries only the
    // message, and a "no such label" with no list of real ones is a dead end.
    const listed =
      candidates.length === 0
        ? message
        : `${message} Elements on screen: ${candidates.join("; ")}.`;
    super(listed);
    this.name = "DeviceUiTargetError";
    this.candidates = candidates;
    this.notFound = notFound;
  }
}

/** How many near-misses to name; a whole screen of labels is noise, not help. */
const MAX_REPORTED_CANDIDATES = 12;

const childrenOf = (node: DeviceUiNode): readonly DeviceUiNode[] => node.children;

/**
 * Whether a tap could ever land on this node. An element with no usable frame
 * (NaN from the guest) or no area and no activation point would aim at the
 * screen origin, which is somebody else's control.
 */
export function isTargetable(node: DeviceUiNode): boolean {
  if (node.unframed === true) return false;
  return (node.frame.width > 0 && node.frame.height > 0) || node.activationPoint !== null;
}

/** Only a node with a label of its own can be named, or usefully listed back. */
function labelledNodes(root: DeviceUiNode): readonly DeviceUiNode[] {
  return flattenUiTree(root, childrenOf).filter(
    (node) => node.label !== null && node.label.length > 0 && isTargetable(node),
  );
}

function identifiedNodes(root: DeviceUiNode, identifier: string): readonly DeviceUiNode[] {
  return flattenUiTree(root, childrenOf).filter(
    (node) => node.identifier === identifier && isTargetable(node),
  );
}

/** Every label currently rendered, used to tell a moving list from a stuck one. */
export function visibleLabels(root: DeviceUiNode): string[] {
  return labelledNodes(root).map((node) => node.label as string);
}

/** Where a tap on this node lands: its own control point, else the frame centre. */
function tapPointForNode(node: DeviceUiNode): DeviceUiPoint {
  return uiTreeActivationPoint(node);
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function matchesRole(node: DeviceUiNode, role: string): boolean {
  const wanted = normalize(role);
  return (
    normalize(node.role) === wanted || (node.subrole !== null && normalize(node.subrole) === wanted)
  );
}

/** A node is on screen when the point we would tap is inside the root's frame. */
export function isOnScreen(node: DeviceUiNode, root: DeviceUiNode): boolean {
  const point = tapPointForNode(node);
  return (
    point.x >= root.frame.x &&
    point.x <= root.frame.x + root.frame.width &&
    point.y >= root.frame.y &&
    point.y <= root.frame.y + root.frame.height
  );
}

function describe(node: DeviceUiNode): string {
  const role = node.subrole === null ? node.role : `${node.role}/${node.subrole}`;
  const value = node.value === null ? "" : ` value=${JSON.stringify(node.value)}`;
  const identifier = node.identifier ? ` #${node.identifier}` : "";
  return `${role} ${JSON.stringify(node.label ?? "")}${identifier}${value}`;
}

/**
 * Locate the one node a label refers to, whether or not it is on screen.
 *
 * Exact label matches win outright: a screen with both "Developer" and
 * "Developer Mode" must not be ambiguous when the caller said "Developer".
 * Only when nothing matches exactly does this fall back to substring.
 *
 * Ambiguity is judged among visible matches first. A list that repeats a
 * label down its length would otherwise be unresolvable, when in practice the
 * one on screen is the one meant.
 */
export function findTarget(root: DeviceUiNode, target: DeviceUiTarget): DeviceUiTargetMatch {
  const identifier = target.identifier?.trim();
  if (identifier !== undefined && identifier.length > 0) {
    // An identifier is exact by contract, so it picks the pool and a label, if
    // given too, only narrows it.
    const match = resolveUiTreeTarget({
      pool: identifiedNodes(root, identifier),
      query: { label: target.label, role: target.role },
      spec: deviceTargetSpec(root, target, () =>
        identifierCandidates(root).slice(0, MAX_REPORTED_CANDIDATES),
      ),
    });
    return { point: tapPointForNode(match.node), node: match.node, onScreen: match.onScreen };
  }
  if (target.label === undefined || normalize(target.label).length === 0) {
    throw new DeviceUiTargetError("A tap target needs a non-empty label or identifier.");
  }
  const match = resolveUiTreeTarget({
    pool: labelledNodes(root),
    query: { label: target.label, role: target.role },
    spec: deviceTargetSpec(root, target),
  });
  return { point: tapPointForNode(match.node), node: match.node, onScreen: match.onScreen };
}

/** Identifiers on screen, for an identifier that matched nothing. */
function identifierCandidates(root: DeviceUiNode): string[] {
  return flattenUiTree(root, childrenOf)
    .filter((node) => node.identifier && isTargetable(node) && isOnScreen(node, root))
    .map(describe);
}

function deviceTargetSpec(
  root: DeviceUiNode,
  target: DeviceUiTarget,
  candidates: (pool: readonly DeviceUiNode[]) => string[] = (pool) =>
    pool.slice(0, MAX_REPORTED_CANDIDATES).map(describe),
): UiTreeTargetSpec<DeviceUiNode> {
  return {
    labelOf: (node) => node.label ?? "",
    matchesRole,
    matchKey: normalize,
    exactKey: normalize,
    isOnScreen: (node) => isOnScreen(node, root),
    preferOnScreen: true,
    noMatch: (pool) => {
      const roleNote = target.role === undefined ? "" : ` with role ${JSON.stringify(target.role)}`;
      return new DeviceUiTargetError(
        `No element ${targetPhrase(target)}${roleNote} is in the accessibility tree. ` +
          `It may belong to a screen you have not opened yet; call device_describe_ui and use a label or identifier listed there.`,
        candidates(pool),
        true,
      );
    },
    ambiguous: (matches) =>
      new DeviceUiTargetError(
        `${matches.length} elements match ${describeTarget(target)}. ` +
          `Pass identifier or role to narrow it, or tap explicit coordinates from device_describe_ui.`,
        matches.slice(0, MAX_REPORTED_CANDIDATES).map(describe),
      ),
  };
}

/** System keyboard ancestry, rather than app-owned one-character buttons. */
export function deviceKeyboardTop(root: DeviceUiNode): number | null {
  const nodes = flattenUiTree(root, childrenOf);
  const keyboards = nodes.filter((node) => {
    if (
      node.unframed ||
      node.frame.width <= 0 ||
      node.frame.height <= 0 ||
      !Number.isFinite(node.frame.y) ||
      node.frame.y < root.frame.y ||
      node.frame.y >= root.frame.y + root.frame.height
    )
      return false;
    if (/^(?:AX)?Keyboard$/iu.test(node.role) || /^(?:AX)?Keyboard$/iu.test(node.subrole ?? "")) {
      return true;
    }
    // Xcode 27 flattens keyboard keys beside a GenericElement screen overlay.
    // Recognize its system controls, not app keypads with single-character labels.
    if (node.role !== "GenericElement" || node.frame.width < root.frame.width * 0.8) return false;
    const controls = new Set(
      nodes
        .filter((key) => key.role === "Button" && key.identifier && isOnScreen(key, node))
        .map((key) => key.identifier),
    );
    return controls.has("space") && controls.has("delete") && controls.has("Return");
  });
  const explicit = keyboards.filter(
    (node) =>
      /^(?:AX)?Keyboard$/iu.test(node.role) || /^(?:AX)?Keyboard$/iu.test(node.subrole ?? ""),
  );
  if (explicit.length > 0) return Math.min(...explicit.map((node) => node.frame.y));
  // A SwiftUI wrapper may also enclose every key. Use the tightest overlay,
  // rather than moving the keyboard boundary to the enclosing app container.
  const overlay = keyboards.reduce<DeviceUiNode | null>(
    (smallest, candidate) =>
      smallest === null ||
      candidate.frame.width * candidate.frame.height < smallest.frame.width * smallest.frame.height
        ? candidate
        : smallest,
    null,
  );
  return overlay?.frame.y ?? null;
}

/**
 * The band a target must land in to count as usable.
 *
 * Not the whole screen: a row sitting under the status bar or behind a home
 * indicator is technically visible and practically untappable, and a row at
 * the very edge tends to be half-clipped. The inset is a fraction of screen
 * height so it scales across devices.
 */
const SAFE_BAND_INSET_FRACTION = 0.12;

/** One swipe covers most of a screen, but not so much that it overshoots. */
const SCROLL_INCREMENT_FRACTION = 0.6;

/** Long enough to read as a drag rather than a flick, which would coast past. */
export const SCROLL_SWIPE_DURATION_MS = 400;

export interface DeviceScrollStep {
  readonly fromX: number;
  readonly fromY: number;
  readonly toX: number;
  readonly toY: number;
  readonly durationMs: number;
}

/**
 * The swipe that moves a target toward the safe band, or null when it is
 * already there.
 *
 * Content moves opposite to the finger: to bring up something below the fold
 * the finger travels up, so the gesture always starts at the far side of the
 * screen from where it is heading.
 */
export function planScrollStep(node: DeviceUiNode, root: DeviceUiNode): DeviceScrollStep | null {
  const inset = root.frame.height * SAFE_BAND_INSET_FRACTION;
  const bandTop = root.frame.y + inset;
  const bandBottom = Math.min(
    root.frame.y + root.frame.height - inset,
    (deviceKeyboardTop(root) ?? Infinity) - inset,
  );
  if (bandBottom <= bandTop) {
    throw new DeviceUiTargetError(
      "The software keyboard leaves no safe scrolling area; dismiss it before scrolling.",
    );
  }
  const centre = node.frame.y + node.frame.height / 2;

  if (centre >= bandTop && centre <= bandBottom) return null;

  const increment = root.frame.height * SCROLL_INCREMENT_FRACTION;
  const midX = root.frame.x + root.frame.width / 2;
  const screenCentre = (bandTop + bandBottom) / 2;
  // Never swipe further than the gap: a target just past the band should not
  // be flung to the other side of the screen and need a correcting swipe back.
  const distance = Math.min(increment, Math.abs(centre - screenCentre));
  const from = centre > bandBottom ? screenCentre + distance / 2 : screenCentre - distance / 2;
  const to = centre > bandBottom ? from - distance : from + distance;

  return { fromX: midX, fromY: from, toX: midX, toY: to, durationMs: SCROLL_SWIPE_DURATION_MS };
}

/** The two shapes a tap request can take, once validated. */
export type DeviceTapRequest =
  | { readonly kind: "point"; readonly x: number; readonly y: number }
  | { readonly kind: "element"; readonly target: DeviceUiTarget };

/**
 * Decide whether a tap names a point or an element, rejecting the shapes that
 * are neither. The schema cannot express "x and y together, or label" on its
 * own, so the either/or lives here and both callers share it.
 */
export function readTapRequest(input: {
  readonly x?: number | undefined;
  readonly y?: number | undefined;
  readonly label?: string | undefined;
  readonly identifier?: string | undefined;
  readonly role?: string | undefined;
}): DeviceTapRequest {
  const hasPoint = input.x !== undefined && input.y !== undefined;
  if (input.label !== undefined || input.identifier !== undefined) {
    if (hasPoint) {
      throw new DeviceUiTargetError(
        "A tap takes either an element (identifier or label, with optional role) or x and y, not both. " +
          "Pass the element alone to let Synara resolve its own tap point.",
      );
    }
    return {
      kind: "element",
      target: { label: input.label, identifier: input.identifier, role: input.role },
    };
  }
  if (!hasPoint) {
    throw new DeviceUiTargetError(
      "A tap needs an element (identifier or label, with optional role) or both x and y. " +
        "Prefer the element: Synara then resolves its own tap point from the accessibility tree.",
    );
  }
  return { kind: "point", x: input.x as number, y: input.y as number };
}
