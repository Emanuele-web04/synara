/**
 * AT-SPI perception for the KWin engine (and the backends built on it): tree
 * reads, the recent-tree cache internal target resolution reuses, and the
 * node check that makes reusing a tree safe at dispatch.
 *
 * Kept out of the backend so the engine's connection, input and capture code
 * does not have to know how a tree was obtained, and so the rules for when a
 * tree may be reused live in one place:
 *
 * - An agent-facing read never gets a tree older than the agent's own last
 *   input, and gets a cached one only when the helper vouches for it: the
 *   application has sent no accessibility event since it was walked.
 * - Internal target resolution (`reuseRecentTree`) may also reuse a tree this
 *   engine fused moments ago, as long as the window list is unchanged and no
 *   input was sent since. Whatever it resolves is checked against the live
 *   application right before dispatch — same role and label at the same
 *   address, fresh extents — and a control that changed is looked up again or
 *   refused, never clicked where it used to be.
 *
 * @module computer/atspiPerception
 */
import type {
  ComputerPoint,
  ComputerScreenSize,
  ComputerState,
  ComputerUiNode,
  ComputerWindow,
} from "@synara/contracts";

import { AtspiHelperUnavailableError, type AtspiTreeReader } from "./atspiClient.ts";
import {
  atspiFrameInWindow,
  atspiNodeAddress,
  atspiTreeIncomplete,
  fuseAtspiTrees,
  type AtspiWindowTree,
} from "./atspiTreeTargeting.ts";
import { ComputerBackendError } from "./ComputerBackend.ts";
import { activationPointForNode } from "./uiTreeTargeting.ts";

/** How long internal resolution may reuse a tree this engine fused itself. */
export const RECENT_TREE_TTL_MS = 3_000;
/**
 * The oldest event-validated tree the helper may answer an agent-facing read
 * with. The helper caps it again on its side.
 */
export const EVENT_VALIDATED_TREE_MAX_AGE_MS = 10_000;
/** How long a resolved tree stays eligible for the dispatch check. */
const RESOLUTION_TTL_MS = 10_000;

type Accessibility = NonNullable<ComputerState["accessibility"]>;

export interface AtspiPerceptionOptions {
  readonly reader: AtspiTreeReader;
  readonly now: () => number;
  /** The reader latched unavailable; reported once per distinct reason by the caller. */
  readonly reportUnavailable: (reason: string) => void;
  /** A read failed for another reason; perception degrades, the caller is told. */
  readonly reportFailure: (error: unknown) => void;
}

export interface AtspiPerceptionRead {
  readonly root?: ComputerUiNode;
  readonly accessibility: Accessibility;
}

interface RecentTree {
  readonly tree: AtspiWindowTree;
  readonly fingerprint: string;
  readonly at: number;
  readonly inputGeneration: number;
}

interface Resolution {
  readonly root: ComputerUiNode;
  readonly screenSize: ComputerScreenSize;
  readonly at: number;
  readonly inputGeneration: number;
}

export class AtspiPerception {
  private readonly reader: AtspiTreeReader;
  private readonly now: () => number;
  /** Connections (plugin generations) whose helper probe has been started. */
  private probed = new WeakSet<object>();
  private inputGeneration = 0;
  private lastInputAt = Number.NEGATIVE_INFINITY;
  private readonly recentTrees = new Map<string, RecentTree>();
  /** The tree the last internal resolution read, for the dispatch check. */
  private resolution: Resolution | undefined;

  constructor(private readonly options: AtspiPerceptionOptions) {
    this.reader = options.reader;
    this.now = options.now;
  }

  /**
   * Probe the helper once per connection, without making the caller wait.
   * Availability is polled constantly; probing there on every call cleared
   * the helper's unavailable latch and restart backoff each time, which is
   * what turned a broken helper into a respawn storm.
   */
  probeForConnection(connection: object): void {
    if (this.probed.has(connection)) return;
    this.probed.add(connection);
    const probe = this.reader.probe;
    if (!probe) return;
    void probe
      .call(this.reader)
      .catch(() => undefined)
      .then(() => {
        const unavailable = this.reader.unavailableReason?.();
        if (unavailable !== undefined) this.options.reportUnavailable(unavailable);
      });
  }

  /** An explicit set-up: the next connection probes again, whatever it is. */
  resetProbes(): void {
    this.probed = new WeakSet();
  }

  /** The agent sent input: every tree read before now may be out of date. */
  noteInput(): void {
    this.inputGeneration += 1;
    this.lastInputAt = this.now();
    this.recentTrees.clear();
    this.resolution = undefined;
  }

  async read(input: {
    readonly windows: readonly ComputerWindow[];
    readonly requested: readonly ComputerWindow[];
    readonly screenSize: ComputerScreenSize;
    readonly reuseRecentTree: boolean;
  }): Promise<AtspiPerceptionRead> {
    const requestedIds = input.requested.map((window) => window.id);
    const unavailable = this.reader.unavailableReason?.();
    if (unavailable !== undefined) {
      this.options.reportUnavailable(unavailable);
      this.resolution = undefined;
      return { accessibility: { status: "unavailable", unavailableWindowIds: requestedIds } };
    }
    const now = this.now();
    const fingerprint = windowListFingerprint(input.windows);
    let trees: readonly AtspiWindowTree[] | undefined = input.reuseRecentTree
      ? this.recentFor(input.requested, fingerprint, now)
      : undefined;
    if (!trees) {
      try {
        trees = await this.reader.readTrees(input.requested, {
          maxAgeMs: Math.min(EVENT_VALIDATED_TREE_MAX_AGE_MS, now - this.lastInputAt),
        });
      } catch (error) {
        this.resolution = undefined;
        // AT-SPI is an optional perception source. KWin window state and
        // coordinate actions stay usable when an application has no tree or
        // the helper is restarting — but the caller is told, because a
        // missing control and an absent one look the same in a tree that
        // silently came back empty.
        if (error instanceof AtspiHelperUnavailableError) {
          this.options.reportUnavailable(error.message);
        } else {
          this.options.reportFailure(error);
        }
        return { accessibility: { status: "unavailable", unavailableWindowIds: requestedIds } };
      }
      this.remember(trees, fingerprint, now);
    }
    const read = trees;
    const usable = new Set(
      read.filter((tree) => tree.status !== "unavailable").map((tree) => tree.windowId),
    );
    const missing = requestedIds.filter((id) => !usable.has(id));
    const root = fuseAtspiTrees({
      windows: input.windows,
      trees: read,
      screenSize: input.screenSize,
      incomplete: missing.length > 0,
    });
    const complete = missing.length === 0 && !read.some(atspiTreeIncomplete);
    this.resolution = input.reuseRecentTree
      ? { root, screenSize: input.screenSize, at: now, inputGeneration: this.inputGeneration }
      : undefined;
    return {
      root,
      accessibility: {
        status: complete ? "complete" : "partial",
        unavailableWindowIds: missing,
      },
    };
  }

  /**
   * The point a pointer action should use, checked against the live
   * application when it is the activation point of a control the last
   * internal resolution found. Anything else — a coordinate the caller chose,
   * a tree that is too old or predates other input — passes through as is.
   * One-shot: the check belongs to the dispatch that follows the resolution.
   */
  async pointForDispatch(
    point: ComputerPoint,
    readWindows: () => Promise<readonly ComputerWindow[]>,
  ): Promise<ComputerPoint> {
    const [checked] = await this.pointsForDispatch([point], readWindows);
    return checked ?? point;
  }

  /**
   * `pointForDispatch` for an action with several points (a drag's start and
   * end), all against the same one resolution, which the first point would
   * otherwise spend.
   */
  async pointsForDispatch(
    points: readonly ComputerPoint[],
    readWindows: () => Promise<readonly ComputerWindow[]>,
  ): Promise<ComputerPoint[]> {
    const resolution = this.takeResolution();
    if (!resolution) return [...points];
    const checked: ComputerPoint[] = [];
    for (const point of points) {
      const node = controlAt(resolution.root, point);
      checked.push(
        node ? await this.validatedPoint(node, point, resolution.screenSize, readWindows) : point,
      );
    }
    return checked;
  }

  /**
   * The point for an action on a known node (set-value, perform-action, an
   * observed ref), checked the same way.
   */
  async pointForNode(
    node: ComputerUiNode,
    point: ComputerPoint,
    readWindows: () => Promise<readonly ComputerWindow[]>,
  ): Promise<ComputerPoint> {
    const resolution = this.takeResolution();
    const screenSize = resolution?.screenSize ?? { width: 0, height: 0, scale: 1 };
    return await this.validatedPoint(node, point, screenSize, readWindows);
  }

  private takeResolution(): Resolution | undefined {
    const resolution = this.resolution;
    this.resolution = undefined;
    if (!resolution) return undefined;
    if (resolution.inputGeneration !== this.inputGeneration) return undefined;
    if (this.now() - resolution.at > RESOLUTION_TTL_MS) return undefined;
    return resolution;
  }

  private async validatedPoint(
    node: ComputerUiNode,
    point: ComputerPoint,
    screenSize: ComputerScreenSize,
    readWindows: () => Promise<readonly ComputerWindow[]>,
  ): Promise<ComputerPoint> {
    const address = atspiNodeAddress(node);
    const validate = this.reader.validateNode;
    if (!address || !validate) return point;
    const window = (await readWindows()).find((candidate) => candidate.id === address.windowId);
    if (!window?.bounds) {
      throw new ComputerBackendError(
        `The window holding ${describeControl(node)} is gone, so nothing was sent.`,
      );
    }
    const result = await validate
      .call(this.reader, { window, path: address.path, role: node.role, label: node.label })
      .catch(() => undefined);
    // No answer is no evidence either way: the resolved point stands, as it
    // did before there was a check.
    if (!result || (!result.ok && result.reason === "unavailable")) return point;
    if (result.ok && result.showing !== false) {
      const frame = atspiFrameInWindow(window, result.clientSize, result.frame);
      if (frame.width <= 0 || frame.height <= 0) return point;
      return activationPointForNode({ ...node, frame, activationPoint: null });
    }
    return await this.relocated(node, window, screenSize);
  }

  /**
   * The control moved in the tree or stopped showing: walk its window again
   * and act only if exactly one control with the same role and label is
   * there now.
   */
  private async relocated(
    node: ComputerUiNode,
    window: ComputerWindow,
    screenSize: ComputerScreenSize,
  ): Promise<ComputerPoint> {
    const trees = await this.reader.readTrees([window]).catch(() => []);
    this.recentTrees.delete(window.id);
    const root = fuseAtspiTrees({ windows: [window], trees, screenSize });
    const matches: ComputerUiNode[] = [];
    const visit = (candidate: ComputerUiNode): void => {
      if (
        candidate.windowId === window.id &&
        candidate.role === node.role &&
        candidate.label === node.label &&
        candidate.frame.width > 0 &&
        candidate.frame.height > 0
      ) {
        matches.push(candidate);
      }
      for (const child of candidate.children) visit(child);
    };
    visit(root);
    if (matches.length === 1) return activationPointForNode(matches[0]!);
    throw new ComputerBackendError(
      `${describeControl(node)} changed after it was found` +
        (matches.length > 1 ? " and now matches more than one control" : "") +
        ", so nothing was sent. Read the window again and retry.",
    );
  }

  private recentFor(
    requested: readonly ComputerWindow[],
    fingerprint: string,
    now: number,
  ): AtspiWindowTree[] | undefined {
    const trees: AtspiWindowTree[] = [];
    for (const window of requested) {
      const recent = this.recentTrees.get(window.id);
      if (
        !recent ||
        recent.fingerprint !== fingerprint ||
        recent.inputGeneration !== this.inputGeneration ||
        now - recent.at > RECENT_TREE_TTL_MS
      ) {
        return undefined;
      }
      trees.push(recent.tree);
    }
    return trees;
  }

  private remember(trees: readonly AtspiWindowTree[], fingerprint: string, now: number): void {
    for (const tree of trees) {
      if (atspiTreeIncomplete(tree)) {
        this.recentTrees.delete(tree.windowId);
        continue;
      }
      this.recentTrees.set(tree.windowId, {
        tree,
        fingerprint,
        at: now,
        inputGeneration: this.inputGeneration,
      });
    }
  }
}

/**
 * The window list as far as a tree depends on it. Focus is left out: the
 * manager focuses the target between resolving and dispatching, and a
 * control's position does not move with focus.
 */
export function windowListFingerprint(windows: readonly ComputerWindow[]): string {
  return JSON.stringify(
    windows.map((window) => [
      window.id,
      window.title,
      window.pid ?? null,
      window.bounds ?? null,
      window.visible,
      window.minimized,
    ]),
  );
}

/** The deepest addressable control whose activation point is exactly `point`. */
function controlAt(root: ComputerUiNode, point: ComputerPoint): ComputerUiNode | undefined {
  let found: ComputerUiNode | undefined;
  const visit = (node: ComputerUiNode): void => {
    if (atspiNodeAddress(node)) {
      const center = activationPointForNode(node);
      if (center.x === point.x && center.y === point.y) found = node;
    }
    for (const child of node.children) visit(child);
  };
  visit(root);
  return found;
}

function describeControl(node: ComputerUiNode): string {
  return node.label ? `The ${node.role} ${JSON.stringify(node.label)}` : `The ${node.role}`;
}
