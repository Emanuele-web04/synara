/**
 * Resolving a desktop target — a coordinate or a label — to the point that acts
 * on it.
 *
 * The matching itself is `@synara/shared/uiTreeTargeting`, shared with the iOS
 * family: exact label before substring, ambiguity refused rather than guessed.
 * What lives here is what the desktop specifically needs — a window scope, a
 * role compared verbatim, and an `onScreen` flag the perception source already
 * computed — plus the coordinate path, which has no accessibility tree at all.
 *
 * @module computer/uiTreeTargeting
 */
import type {
  ComputerPoint,
  ComputerRect,
  ComputerScreenSize,
  ComputerSpaceErrorCode,
  ComputerTarget,
  ComputerUiNode,
} from "@synara/contracts";
import {
  flattenUiTree,
  resolveUiTreeTarget,
  uiTreeActivationPoint,
  type UiTreeTargetSpec,
} from "@synara/shared/uiTreeTargeting";
import { clampTextToLength } from "./utf8Truncation.ts";
import { retainComputerElementRef } from "./computerElementIdentity.ts";

export interface ComputerTargetCandidate {
  readonly label: string;
  readonly role: string;
  readonly windowId: string | null;
  readonly onScreen: boolean;
  readonly frame: ComputerRect;
}

export interface ComputerTargetMatch {
  readonly point: ComputerPoint;
  readonly node: ComputerUiNode;
}

export type ComputerTargetErrorCode =
  | ComputerSpaceErrorCode
  | "computer_target_invalid"
  | "computer_target_not_found"
  | "computer_target_ambiguous"
  | "computer_target_offscreen"
  /** The named window is covered at the point and the desktop could not raise it. */
  | "computer_target_occluded"
  /** The desktop declined to deliver input to the named window, and sent none. */
  | "computer_target_refused"
  /**
   * The target belongs to a denylisted surface — a password manager or OS
   * security UI — and the access was refused before it could dispatch or
   * disclose anything. There is no override in this build.
   */
  | "computer_denylist_refused";

/** How many near-misses to name; a whole desktop of labels is noise, not help. */
const MAX_REPORTED_CANDIDATES = 16;

export class ComputerTargetError extends Error {
  readonly code: ComputerTargetErrorCode;
  readonly candidates: readonly ComputerTargetCandidate[];
  readonly notFound: boolean;

  constructor(input: {
    readonly code: ComputerTargetErrorCode;
    readonly message: string;
    readonly candidates?: readonly ComputerTargetCandidate[];
    readonly notFound?: boolean;
  }) {
    const candidates = input.candidates ?? [];
    // Candidates go in the message, not only in the field beside it. This error
    // reaches the model through MCP tool results and WsRpcError, and only the
    // first of those carries the field, so a "no such label" that names the real
    // ones structurally is still a dead end everywhere else. The whole
    // refuse-rather-than-guess design depends on the caller being able to see
    // what it should have asked for.
    super(messageWithCandidates(input.message, candidates));
    this.name = "ComputerTargetError";
    this.code = input.code;
    this.candidates = candidates;
    this.notFound = input.notFound ?? input.code === "computer_target_not_found";
  }
}

export function resolveComputerPoint(
  target: ComputerTarget,
  screenSize: ComputerScreenSize,
): ComputerPoint {
  const hasX = typeof target.x === "number";
  const hasY = typeof target.y === "number";
  if (hasX !== hasY) {
    throw new ComputerTargetError({
      code: "computer_target_invalid",
      message: "Computer coordinate targets must include both x and y.",
    });
  }
  if (!hasX || !hasY) {
    throw new ComputerTargetError({
      code: "computer_target_invalid",
      message: "Computer actions require x/y coordinates or a labelled target.",
    });
  }
  const point = { x: target.x, y: target.y } as ComputerPoint;
  if (point.x < 0 || point.y < 0 || point.x >= screenSize.width || point.y >= screenSize.height) {
    throw new ComputerTargetError({
      code: "computer_target_offscreen",
      message: `Computer target (${point.x}, ${point.y}) is outside the ${screenSize.width}x${screenSize.height} screen.`,
      candidates: [],
    });
  }
  return point;
}

export function resolveComputerSemanticTarget(
  root: ComputerUiNode,
  target: ComputerTarget,
  allowOffscreen = false,
): ComputerTargetMatch {
  if (target.refOrdinal !== undefined && target.label !== undefined) {
    return resolveComputerOrdinalTarget(root, target, target.refOrdinal, allowOffscreen);
  }
  const match = resolveUiTreeTarget({
    pool: flattenUiTree(root, childrenOf).filter((node) => matchesWindow(node, target.windowId)),
    query: { label: target.label, role: target.role },
    spec: computerTargetSpec(target),
  });
  if (!match.onScreen && !allowOffscreen) {
    throw new ComputerTargetError({
      code: "computer_target_offscreen",
      message: `Computer target ${describeTarget(target)} is off-screen; refusing to guess a click.`,
      candidates: candidateDescriptions([match.node]),
    });
  }
  return { node: match.node, point: activationPointForNode(match.node) };
}

/**
 * A ref-resolved target: the ordinal-th control sharing the exact listed
 * identity, in tree order.
 *
 * Only exact label matches are considered — the listing already named the
 * control verbatim, so substring promotion would only buy collisions with
 * controls that share a prefix. When the ordinal slot no longer exists,
 * refuse rather than substitute another control, even if only one survives.
 * Preferring on-screen matches mirrors
 * the digest's own membership (it only lists on-screen controls), and the
 * usual off-screen refusal still applies to the picked node.
 */
function resolveComputerOrdinalTarget(
  root: ComputerUiNode,
  target: ComputerTarget,
  ordinal: number,
  allowOffscreen: boolean,
): ComputerTargetMatch {
  const spec = computerTargetSpec(target);
  const pool = flattenUiTree(root, childrenOf).filter((node) =>
    matchesWindow(node, target.windowId),
  );
  const exact = spec.exactKey(target.label!);
  const matches = pool.filter(
    (node) =>
      (target.role === undefined || spec.matchesRole(node, target.role)) &&
      spec.exactKey(spec.labelOf(node)) === exact,
  );
  const onScreen = matches.filter((node) => spec.isOnScreen(node));
  const ordered = onScreen.length > 0 ? onScreen : matches;
  let node: ComputerUiNode;
  if (ordered.length > ordinal) {
    node = ordered[ordinal]!;
  } else if (ordered.length === 0) {
    throw spec.noMatch(pool);
  } else {
    throw new ComputerTargetError({
      code: "computer_target_not_found",
      message: `Computer target ${describeTarget(target)} no longer exists at its observed duplicate position. Observe again with computer_get_state before acting.`,
      candidates: candidateDescriptions(ordered),
      notFound: true,
    });
  }
  if (!spec.isOnScreen(node) && !allowOffscreen) {
    throw new ComputerTargetError({
      code: "computer_target_offscreen",
      message: `Computer target ${describeTarget(target)} is off-screen; refusing to guess a click.`,
      candidates: candidateDescriptions([node]),
    });
  }
  return { node, point: activationPointForNode(node) };
}

const SEMANTIC_TEXT_ROLES = new Set([
  "AXTextField",
  "AXTextArea",
  "AXSearchField",
  "AXSecureTextField",
  "entry",
  "text field",
  "text-field",
  "search field",
  "text area",
  "textarea",
]);

export function resolveComputerUniqueTextTarget(
  root: ComputerUiNode,
  windowId: string,
  allowOffscreen = false,
): ComputerTargetMatch {
  const candidates = flattenUiTree(root, childrenOf).filter(
    (node) =>
      node.windowId === windowId &&
      (allowOffscreen || node.onScreen) &&
      node.editable !== false &&
      (node.editable === true || SEMANTIC_TEXT_ROLES.has(node.role)),
  );
  if (candidates.length === 0) {
    throw new ComputerTargetError({
      code: "computer_target_not_found",
      message: `Window ${JSON.stringify(windowId)} has no ${allowOffscreen ? "" : "visible "}writable text control. Observe it and pass the exact label and role.`,
      candidates: candidateDescriptions(
        flattenUiTree(root, childrenOf).filter((node) => node.windowId === windowId),
      ),
      notFound: true,
    });
  }
  if (candidates.length > 1) {
    throw new ComputerTargetError({
      code: "computer_target_ambiguous",
      message: `Window ${JSON.stringify(windowId)} has more than one ${allowOffscreen ? "" : "visible "}writable text control. Pass the exact label and role.`,
      candidates: candidateDescriptions(candidates),
    });
  }
  const node = candidates[0]!;
  return { node, point: activationPointForNode(node) };
}

/**
 * A bare window id names the window itself rather than a control in it — the
 * shape "scroll this window" arrives as. The match is the window's own node:
 * the first node carrying that id in document order, which is the window's
 * root. Returns undefined when the tree does not describe the window at all,
 * so the caller can fall back to the window list's geometry.
 */
export function resolveComputerWindowTarget(
  root: ComputerUiNode,
  windowId: string,
): ComputerTargetMatch | undefined {
  const node = flattenUiTree(root, childrenOf).find((candidate) => candidate.windowId === windowId);
  if (node === undefined) return undefined;
  if (!node.onScreen) {
    throw new ComputerTargetError({
      code: "computer_target_offscreen",
      message: `Computer window ${JSON.stringify(windowId)} is off-screen; refusing to guess a scroll point.`,
      candidates: candidateDescriptions([node]),
    });
  }
  return { node, point: activationPointForNode(node) };
}

/**
 * The desktop's half of the shared resolver.
 *
 * Three of these deliberately differ from the iOS family rather than having
 * drifted: a role is compared verbatim because AT-SPI role names are a fixed
 * vocabulary rather than free text, `onScreen` is trusted because the perception
 * source computed it against the real workspace rect, and labels keep their
 * surrounding space because nothing trims a label arriving over MCP and a match
 * that ignored the difference would act on a control the caller did not name.
 */
function computerTargetSpec(target: ComputerTarget): UiTreeTargetSpec<ComputerUiNode> {
  return {
    labelOf: matchableLabel,
    matchesRole: (node, role) => node.role === role,
    matchKey: (label) => normalizeLabelSpaces(label).toLocaleLowerCase(),
    // Promotion to "this is the label, exactly" is case-sensitive here while the
    // substring test is not, which is how the desktop family has always behaved.
    exactKey: normalizeLabelSpaces,
    isOnScreen: (node) => node.onScreen,
    preferOnScreen: false,
    noMatch: (pool) =>
      new ComputerTargetError({
        code: "computer_target_not_found",
        message: `No visible computer target matched ${describeTarget(target)}.`,
        candidates: candidateDescriptions(pool),
        notFound: true,
      }),
    ambiguous: (matches) =>
      new ComputerTargetError({
        code: "computer_target_ambiguous",
        message: `Computer target ${describeTarget(target)} matched more than one control.`,
        candidates: candidateDescriptions(matches),
      }),
  };
}

export function activationPointForNode(node: ComputerUiNode): ComputerPoint {
  return uiTreeActivationPoint(node);
}

export function candidateDescriptions(
  nodes: readonly ComputerUiNode[],
): readonly ComputerTargetCandidate[] {
  return nodes.slice(0, MAX_REPORTED_CANDIDATES).map((node) => ({
    label: node.label ?? node.description ?? "(unlabelled)",
    role: node.role,
    windowId: node.windowId,
    onScreen: node.onScreen,
    frame: node.frame,
  }));
}

export function computerTargetCandidates(root: ComputerUiNode): readonly ComputerTargetCandidate[] {
  return candidateDescriptions(flattenUiTree(root, childrenOf));
}

// ── Actionable-element digest ───────────────────────────────────────

/**
 * The roles that can be acted on semantically, across the two vocabularies the
 * desktop family speaks (AT-SPI's lowercase role names and macOS AX spellings).
 * Static text is deliberately absent: it fills the digest with lines nothing
 * can be done with.
 */
const ACTIONABLE_ROLES = new Set([
  "AXButton",
  "AXCheckBox",
  "AXRadioButton",
  "AXPopUpButton",
  "AXComboBox",
  "AXTextField",
  "AXTextArea",
  "AXSearchField",
  "AXSecureTextField",
  "AXLink",
  "AXMenuBarItem",
  "AXMenuItem",
  "AXSlider",
  "AXIncrementor",
  "AXTab",
  "AXSwitch",
  // Buttons.
  "push button",
  "button",
  "toggle button",
  // Text entry.
  "entry",
  "text field",
  "text-field",
  "search field",
  // Stateful controls.
  "check box",
  "radio button",
  "combo box",
  "list box",
  "switch",
  "slider",
  "spin button",
  // Navigation.
  "link",
  "page tab",
  "menu item",
  "check menu item",
  "radio menu item",
]);

/** Longest element list one digest may carry before it reports incompleteness. */
const ELEMENT_DIGEST_MAX_LENGTH = 60;
/** Longest label or value one element may carry. */
const ELEMENT_TEXT_MAX_LENGTH = 80;

export interface ComputerActionableElement {
  /**
   * The handle an action cites instead of re-quoting label and role. The
   * digest mints it as the listing position; the serving layer remaps it to
   * the thread's stable ref — the number bound to this element's identity —
   * before the listing is stored or shown, so wire refs survive a reorder
   * that positions would not.
   */
  readonly ref: number;
  readonly role: string;
  readonly label: string;
  /** Current contents of an editable control, truncated. Absent otherwise. */
  readonly value?: string;
  readonly windowId: string | null;
}

/**
 * What a `ref` actually resolves to — kept beside the display items because
 * their labels are truncated for the wire while targeting needs the
 * element's full identity.
 */
export interface ComputerActionableElementRef {
  /** The element's complete matchable label, never clamped. */
  readonly label: string;
  readonly role: string;
  readonly windowId: string | null;
  /**
   * Which same-identity occurrence this element is, in tree order. Two
   * controls that share window, role and label are still told apart by it —
   * the property a plain label search cannot express.
   */
  readonly ordinal: number;
}

export interface ComputerActionableElements {
  readonly items: readonly ComputerActionableElement[];
  /**
   * Resolution identity for each item, parallel to `items` — the untruncated
   * label plus the duplicate ordinal the wire `ref` is bound to. Server-side
   * only — it is not part of the payload the model reads.
   */
  readonly refIndex: readonly ComputerActionableElementRef[];
  /**
   * False when the source tree is partial or more actionable elements exist
   * than fit. Missing controls may still exist in the application.
   */
  readonly complete: boolean;
  readonly sourceIncomplete: boolean;
  /**
   * How many matching elements did not fit, so the caller can say how much it
   * is not showing rather than only that it is not showing everything.
   *
   * Knowing the number is what makes the answer actionable: "3 more" means
   * scroll or look again, while "412 more" means narrow the query, and the
   * filters exist precisely for the second case.
   */
  readonly omitted: number;
}

/** Narrows the digest before the length cap applies, never after it. */
export interface ComputerActionableElementFilter {
  /** Only controls owned by this window. */
  readonly windowId?: string | undefined;
  /** Only controls whose label contains this text, case-insensitively. */
  readonly labelContains?: string | undefined;
}

/**
 * The labeled, on-screen, actionable elements of a UI tree — what a model
 * grounds on instead of estimating pixel coordinates from a screenshot.
 *
 * Only labeled elements are listed, because targeting is by label: an
 * unlabeled control cannot be addressed semantically, and listing it would
 * push the caller back toward coordinates. Off-screen elements are excluded
 * too — semantic resolution refuses off-screen targets, so naming them would
 * invite a refused action; scrolling brings them on screen and they appear in
 * the next digest. Duplicate labels are kept: two same-labeled controls is
 * real ambiguity the caller should see rather than have silently resolved.
 */
export function actionableElements(
  root: ComputerUiNode,
  filter: ComputerActionableElementFilter = {},
): ComputerActionableElements {
  const items: ComputerActionableElement[] = [];
  const refIndex: ComputerActionableElementRef[] = [];
  // Ordinals count every collectible same-identity node, not only the ones
  // that fit the cap — a ref points into tree order, and skipped members
  // still shift the positions behind them.
  const ordinals = new Map<string, number>();
  const wanted =
    filter.labelContains === undefined
      ? undefined
      : normalizeLabelSpaces(filter.labelContains).toLocaleLowerCase();
  let omitted = 0;
  let sourceIncomplete = false;
  const walk = (node: ComputerUiNode): void => {
    if (node.truncated) sourceIncomplete = true;
    const label = matchableLabel(node);
    const collectible =
      ACTIONABLE_ROLES.has(node.role) &&
      node.onScreen &&
      node.windowId !== null &&
      label !== "" &&
      (filter.windowId === undefined || node.windowId === filter.windowId) &&
      (wanted === undefined || normalizeLabelSpaces(label).toLocaleLowerCase().includes(wanted));
    if (collectible) {
      const identity = `${node.windowId}${node.role}${normalizeLabelSpaces(label)}`;
      const ordinal = ordinals.get(identity) ?? 0;
      ordinals.set(identity, ordinal + 1);
      if (items.length < ELEMENT_DIGEST_MAX_LENGTH) {
        refIndex.push(
          retainComputerElementRef(
            { label, role: node.role, windowId: node.windowId, ordinal },
            node,
          ),
        );
        items.push({
          ref: items.length,
          role: node.role,
          label: clampTextToLength(label, ELEMENT_TEXT_MAX_LENGTH),
          // An entry's empty value is real information — "this field is blank" —
          // so presence, not truthiness, decides.
          ...(node.value !== null && node.value !== undefined
            ? { value: clampTextToLength(node.value, 40) }
            : {}),
          windowId: node.windowId,
        });
      } else {
        // The list is full and something actionable did not fit: that has to be
        // said out loud, or the caller reads a truncated digest as the truth.
        omitted += 1;
      }
    }
    // The walk continues past the cap on purpose. Abandoning it made the count
    // unknowable and the digest prefix-biased by window order — whatever the
    // desktop happened to enumerate first filled the list, and the rest of the
    // screen was not merely unlisted but uncounted.
    for (const child of node.children) walk(child);
  };
  walk(root);
  return {
    items,
    refIndex,
    complete: omitted === 0 && !sourceIncomplete,
    omitted,
    sourceIncomplete,
  };
}

/**
 * What changed between two element digests, keyed on the element's identity —
 * window, role, and label — rather than its position, so a list that reorders
 * does not read as everything leaving and arriving.
 *
 * Identity is a multiset, not a key: duplicate labels are kept on purpose (a
 * repeated "Save" is real ambiguity), so each identity maps to a list of values
 * paired by index. A pair whose value moved reports `changed`; identities or
 * values with no counterpart report `added` or `removed`.
 *
 * What it cannot see: an element that moved but kept its label, role and value
 * diffs clean, because the digest carries no frame. When layout is the
 * question the caller needs a screenshot, not a diff.
 */
export interface ComputerActionableElementsDiff {
  readonly added: readonly ComputerActionableElement[];
  readonly removed: readonly ComputerActionableElement[];
  readonly changed: readonly {
    readonly ref: number;
    readonly role: string;
    readonly label: string;
    readonly windowId: string | null;
    /** Previous value; absent when the element had none. */
    readonly was?: string;
    readonly value?: string;
  }[];
}

export function diffActionableElements(
  before: readonly ComputerActionableElement[],
  after: readonly ComputerActionableElement[],
): ComputerActionableElementsDiff {
  const identity = (item: ComputerActionableElement): string =>
    JSON.stringify([item.windowId ?? null, item.role, item.label]);
  const group = (
    items: readonly ComputerActionableElement[],
  ): Map<string, ComputerActionableElement[]> => {
    const grouped = new Map<string, ComputerActionableElement[]>();
    for (const item of items) {
      const key = identity(item);
      const bucket = grouped.get(key);
      if (bucket) bucket.push(item);
      else grouped.set(key, [item]);
    }
    return grouped;
  };
  const oldGroups = group(before);
  const newGroups = group(after);
  const added: ComputerActionableElement[] = [];
  const removed: ComputerActionableElement[] = [];
  const changed: ComputerActionableElementsDiff["changed"][number][] = [];
  for (const [key, previous] of oldGroups) {
    const current = newGroups.get(key);
    if (current === undefined) {
      removed.push(...previous);
      continue;
    }
    const overlap = Math.min(previous.length, current.length);
    for (let index = 0; index < overlap; index += 1) {
      if (previous[index]!.value !== current[index]!.value) {
        const item = current[index]!;
        changed.push({
          ref: item.ref,
          role: item.role,
          label: item.label,
          windowId: item.windowId,
          ...(previous[index]!.value !== undefined ? { was: previous[index]!.value } : {}),
          ...(item.value !== undefined ? { value: item.value } : {}),
        });
      }
    }
    removed.push(...previous.slice(overlap));
    added.push(...current.slice(overlap));
    newGroups.delete(key);
  }
  for (const current of newGroups.values()) added.push(...current);
  return { added, removed, changed };
}

export function describeTarget(target: ComputerTarget): string {
  const parts = [
    target.label ? `label=${JSON.stringify(target.label)}` : null,
    target.role ? `role=${JSON.stringify(target.role)}` : null,
    target.windowId ? `window=${JSON.stringify(target.windowId)}` : null,
    target.refOrdinal !== undefined ? `duplicate ${target.refOrdinal + 1}` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(", ") : "the supplied coordinates";
}

const childrenOf = (node: ComputerUiNode): readonly ComputerUiNode[] => node.children;

/**
 * The text a label is matched against: an unlabelled control is still
 * addressable by whatever it describes itself as.
 *
 * Deliberately falls back to the empty string rather than to the
 * `"(unlabelled)"` placeholder a candidate listing shows, so that placeholder
 * never becomes a label the caller can accidentally match on.
 */
function matchableLabel(node: ComputerUiNode): string {
  return node.label ?? node.description ?? "";
}

/**
 * Accessibility labels often use non-breaking spaces before required-field
 * markers. They look like ordinary spaces in the screenshot; asking a model
 * to reproduce the invisible distinction makes a visible field untargetable.
 * Preserve whitespace positions and counts, case and the original labels in
 * results. Equivalent labels still go through the normal ambiguity refusal.
 */
export function normalizeLabelSpaces(label: string): string {
  return label.replace(/[\u00a0\u2007\u202f]/g, " ");
}

function matchesWindow(node: ComputerUiNode, windowId: string | undefined): boolean {
  return windowId === undefined || node.windowId === windowId;
}

/** One candidate as a single line, short enough that sixteen of them still read. */
function describeCandidate(candidate: ComputerTargetCandidate): string {
  const window =
    candidate.windowId === null ? "" : ` in window ${JSON.stringify(candidate.windowId)}`;
  return `${candidate.role} ${JSON.stringify(candidate.label)}${window}`;
}

function messageWithCandidates(
  message: string,
  candidates: readonly ComputerTargetCandidate[],
): string {
  if (candidates.length === 0) return message;
  return `${message} Controls in the accessibility tree: ${candidates.map(describeCandidate).join("; ")}.`;
}
