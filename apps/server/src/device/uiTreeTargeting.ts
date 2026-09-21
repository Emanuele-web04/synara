/** single place answering "where do I tap to hit the thing called X" — agents are bad at coordinate arithmetic; the tap point is activationPoint (a merged settings row's frame centre is dead space); a scrolled-out match is refused, not tapped */
import type { DeviceUiNode, DeviceUiPoint } from "@synara/contracts";

/** at least a label; role narrows an ambiguous one */
export interface DeviceUiTarget {
  readonly label: string;
  readonly role?: string | undefined;
}

export interface DeviceUiTargetMatch {
  readonly point: DeviceUiPoint;
  readonly node: DeviceUiNode;
  /** false when the match is in the tree but scrolled out of the display */
  readonly onScreen: boolean;
}

export class DeviceUiTargetError extends Error {
  /** candidate descriptions, so the agent can retry with a real label */
  readonly candidates: readonly string[];
  /** distinguished from ambiguous/off-screen because long lists are virtualized — a row further down is genuinely absent until scrolled near; a scroll loop must keep looking, an ambiguity must not be retried */
  readonly notFound: boolean;

  constructor(message: string, candidates: readonly string[] = [], notFound = false) {
    // candidates go in the message, not just a field — every transport to the agent carries only the message
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

/** how many near-misses to name — a whole screen of labels is noise */
const MAX_REPORTED_CANDIDATES = 12;

function flatten(root: DeviceUiNode): DeviceUiNode[] {
  const out: DeviceUiNode[] = [];
  const walk = (node: DeviceUiNode): void => {
    out.push(node);
    for (const child of node.children) walk(child);
  };
  walk(root);
  return out;
}

/** every label currently rendered — tells a moving list from a stuck one */
export function visibleLabels(root: DeviceUiNode): string[] {
  return flatten(root)
    .filter((node) => node.label !== null && node.label.length > 0)
    .map((node) => node.label as string);
}

/** where a tap lands: the node's control point, else the frame centre */
export function tapPointForNode(node: DeviceUiNode): DeviceUiPoint {
  if (node.activationPoint !== null) return node.activationPoint;
  return {
    x: node.frame.x + node.frame.width / 2,
    y: node.frame.y + node.frame.height / 2,
  };
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

/** on screen when the point we'd tap is inside the root's frame */
function isOnScreen(node: DeviceUiNode, root: DeviceUiNode): boolean {
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
  return `${role} ${JSON.stringify(node.label ?? "")}${value}`;
}

/** exact matches win outright — "Developer" must not be ambiguous when "Developer Mode" also exists; falls back to substring only when nothing matches exactly; ambiguity judged among visible matches first */
export function findTarget(root: DeviceUiNode, target: DeviceUiTarget): DeviceUiTargetMatch {
  const wanted = normalize(target.label);
  if (wanted.length === 0) {
    throw new DeviceUiTargetError("A tap target needs a non-empty label.");
  }

  const labelled = flatten(root).filter((node) => node.label !== null && node.label.length > 0);
  const byRole =
    target.role === undefined
      ? labelled
      : labelled.filter((node) => matchesRole(node, target.role as string));

  const exact = byRole.filter((node) => normalize(node.label as string) === wanted);
  const matches =
    exact.length > 0
      ? exact
      : byRole.filter((node) => normalize(node.label as string).includes(wanted));

  if (matches.length === 0) {
    const roleNote = target.role === undefined ? "" : ` with role ${JSON.stringify(target.role)}`;
    throw new DeviceUiTargetError(
      `No element labelled ${JSON.stringify(target.label)}${roleNote} is in the accessibility tree. ` +
        `It may belong to a screen you have not opened yet; call device_describe_ui and use a label listed there.`,
      labelled.slice(0, MAX_REPORTED_CANDIDATES).map(describe),
      true,
    );
  }

  const visible = matches.filter((node) => isOnScreen(node, root));
  const candidates = visible.length > 0 ? visible : matches;
  if (candidates.length > 1) {
    throw new DeviceUiTargetError(
      `${candidates.length} elements match ${JSON.stringify(target.label)}. ` +
        `Pass role to narrow it, or tap explicit coordinates from device_describe_ui.`,
      candidates.slice(0, MAX_REPORTED_CANDIDATES).map(describe),
    );
  }

  const node = candidates[0] as DeviceUiNode;
  return { point: tapPointForNode(node), node, onScreen: visible.length > 0 };
}

/** not the whole screen — a row under the status bar or behind the home indicator is technically visible, practically untappable; fraction of height so it scales across devices */
const SAFE_BAND_INSET_FRACTION = 0.12;

/** one swipe covers most of a screen without overshooting */
const SCROLL_INCREMENT_FRACTION = 0.6;

/** long enough to read as a drag rather than a flick that coasts past */
export const SCROLL_SWIPE_DURATION_MS = 400;

export interface DeviceScrollStep {
  readonly fromX: number;
  readonly fromY: number;
  readonly toX: number;
  readonly toY: number;
  readonly durationMs: number;
}

/** content moves opposite to the finger — to bring up something below the fold the finger travels up, starting at the far side */
export function planScrollStep(node: DeviceUiNode, root: DeviceUiNode): DeviceScrollStep | null {
  const inset = root.frame.height * SAFE_BAND_INSET_FRACTION;
  const bandTop = root.frame.y + inset;
  const bandBottom = root.frame.y + root.frame.height - inset;
  const centre = node.frame.y + node.frame.height / 2;

  if (centre >= bandTop && centre <= bandBottom) return null;

  const increment = root.frame.height * SCROLL_INCREMENT_FRACTION;
  const midX = root.frame.x + root.frame.width / 2;
  const screenCentre = root.frame.y + root.frame.height / 2;
  // never swipe further than the gap — a target just past the band shouldn't be flung to the other side
  const distance = Math.min(increment, Math.abs(centre - screenCentre));
  const from = centre > bandBottom ? screenCentre + distance / 2 : screenCentre - distance / 2;
  const to = centre > bandBottom ? from - distance : from + distance;

  return { fromX: midX, fromY: from, toX: midX, toY: to, durationMs: SCROLL_SWIPE_DURATION_MS };
}

/** the two shapes a tap request can take, once validated */
export type DeviceTapRequest =
  | { readonly kind: "point"; readonly x: number; readonly y: number }
  | { readonly kind: "element"; readonly target: DeviceUiTarget };

/** the schema can't express "x and y together, or label" — the either/or lives here and both callers share it */
export function readTapRequest(input: {
  readonly x?: number | undefined;
  readonly y?: number | undefined;
  readonly label?: string | undefined;
  readonly role?: string | undefined;
}): DeviceTapRequest {
  const hasPoint = input.x !== undefined && input.y !== undefined;
  if (input.label !== undefined) {
    if (hasPoint) {
      throw new DeviceUiTargetError(
        "A tap takes either label (with optional role) or x and y, not both. " +
          "Pass label alone to let Synara resolve the element's own tap point.",
      );
    }
    return { kind: "element", target: { label: input.label, role: input.role } };
  }
  if (!hasPoint) {
    throw new DeviceUiTargetError(
      "A tap needs either label (with optional role) or both x and y. " +
        "Prefer label: Synara then resolves the element's own tap point from the accessibility tree.",
    );
  }
  return { kind: "point", x: input.x as number, y: input.y as number };
}
