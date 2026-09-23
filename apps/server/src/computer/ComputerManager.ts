import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { ComputerSpaceBroker, ComputerSpaceError } from "./ComputerSpaceBroker.ts";
import { ComputerControlState } from "./ComputerControlState.ts";
import { computerApprovalGate } from "./ComputerApprovalGate.ts";
import { currentComputerTask } from "./computerTaskContext.ts";
import { CursorActivity } from "./cursorActivity.ts";
import { waitForWindow } from "./waitForWindow.ts";
import { observedComputerTargetNode } from "./computerElementIdentity.ts";
import {
  ComputerId,
  ComputerPoint,
  ComputerScreenSize,
  COMPUTER_PROVISION_SUMMARY_MAX_LENGTH,
  COMPUTER_TEXT_MAX_LENGTH,
  ThreadId,
  type ComputerAccessibilityTreeResult,
  type ComputerActionResult,
  type ComputerApp,
  type ComputerControlMode,
  type ComputerAvailability,
  type ComputerBuildSignature,
  type ComputerCapabilities,
  type ComputerCursorPosition,
  type ComputerEvent,
  type ComputerGetAuditHistoryInput,
  type ComputerGetAuditHistoryResult,
  type ComputerHealth,
  type ComputerInputModifier,
  type ComputerRect,
  type ComputerScreenshot,
  type ComputerGetScreenSizeResult,
  type ComputerListAppsResult,
  type ComputerListWindowsResult,
  type ComputerProvisionResult,
  type ComputerLaunchAppResult,
  type ComputerPermission,
  type ComputerState,
  type ComputerStatusResult,
  type ComputerTarget,
  type ComputerVerifyStateResult,
  type ComputerWindow,
  type ComputerZoomResult,
  type ThreadComputerState,
} from "@synara/contracts";
import { encodeComputerFrame } from "@synara/shared/computerFrame";
import { FrameTransport, type FrameSink } from "@synara/shared/frameTransport";

import {
  DesktopOperationQueue,
  withDesktopDeliveryMode,
  assertDesktopOperationActive,
  assertDesktopOperationAdmission,
  withDesktopOperationSignal,
  desktopOperationSignal,
  desktopDeliveryMode,
  withoutDesktopCancellation,
} from "./DesktopOperationQueue.ts";
import {
  clampComputerMessage,
  COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION,
  computerBackendActionResult,
  ComputerBackendError,
  type ComputerAgentDialect,
  type ComputerBackend,
  type ComputerBackendActionResult,
  type ComputerBrowserCallResult,
  type ComputerCaptureRequest,
  type ComputerStreamFrame,
  type ComputerMenuTarget,
  type ComputerResolvedTarget,
  type ComputerTextRange,
} from "./ComputerBackend.ts";
import {
  createComputerCallContext,
  cuaActionSettleMsOverride,
  cuaConditionalSettleEnabled,
  currentComputerCall,
  markComputerCall,
  timedComputerLeg,
  withComputerCallContext,
} from "./computerCallContext.ts";
import {
  rectContainsPoint,
  topmostWindowAtPoint,
  windowsCoveringPoint,
} from "./computerGeometry.ts";
import { decodePngLuma, estimateVerticalTravel, ScrollGearingStore } from "./scrollCalibration.ts";
import { ScrollGearingFile } from "./scrollGearingFile.ts";
import {
  ComputerTargetError,
  activationPointForNode,
  computerTargetCandidates,
  resolveComputerPoint,
  resolveComputerSemanticTarget,
  resolveComputerUniqueTextTarget,
  resolveComputerWindowTarget,
} from "./uiTreeTargeting.ts";
import { ComputerAuditLog, type ComputerAuditEntry } from "./computerAuditLog.ts";
import { ComputerDenylistError, computerDenylistMatch } from "./computerDenylist.ts";
import { CuaActionError } from "./CuaComputerBackend.ts";
import {
  COMPUTER_FOREGROUND_NOT_REQUESTED_CODE,
  COMPUTER_FOREGROUND_USER_INTERACTION_CODE,
  COMPUTER_USER_INTERACTION_QUIET_MS,
  type ComputerForegroundAuthorization,
} from "./computerVisibleUse.ts";
import {
  cuaMaskedActivationEnabled,
  cuaMaskedActivationOptIn,
  maskedActivationOptedIn,
} from "./computerShield.ts";
import { describeComputerUiTree } from "./uiTreeText.ts";
import { clampTextToLength } from "./utf8Truncation.ts";

export const COMPUTER_FRAME_QUEUE_LIMIT = 8;
export const COMPUTER_FRAME_SOCKET_BUDGET_BYTES = 2 * 1024 * 1024;

/**
 * Crash backstop for the desktop lease, not the normal release path.
 *
 * Foreground input, clipboard and complete gestures share one exclusive
 * desktop lease. A backend proving exact background delivery instead owns
 * its application's keyboard/modal state, or one window for pure semantic
 * writes. Unrelated applications can progress between atomic native actions.
 * Ownership is released the moment the owner's turn ends
 * (`releaseDesktopControl`, driven by the provider
 * runtime's terminal turn and session events), because a takeover mid-turn
 * corrupts the owner: its drag is teleported, its typing is retargeted. Idle
 * expiry only covers the case where that signal never arrives — a provider
 * process that died without a terminal event — and so is deliberately long: a
 * model can think for minutes between two tool calls, and expiring under a live
 * turn is the failure this whole mechanism exists to prevent. Five minutes
 * leaves a long-running model's legitimate thinking time undisturbed.
 */
export const COMPUTER_LEASE_IDLE_MS = 300_000;

/**
 * How long the enable path waits for in-flight stops and the durable
 * preference write before giving up. The write is a local file store and a
 * stop is a bounded native round trip, so anything past this is wedged — and
 * a wedged enable must fail closed (staying disabled) rather than wedge the
 * caller or open authority on an unrecorded preference.
 */
export const COMPUTER_CONTROL_ENABLE_TIMEOUT_MS = 30_000;

/**
 * How long the desktop is given to settle before the screenshot that rides on
 * an action result is captured. Long enough for a menu to open or a keystroke
 * to paint, short enough not to throttle the action loop the screenshot exists
 * to speed up.
 */
export const COMPUTER_ACTION_SETTLE_MS = 300;

/**
 * The driver-observed settle that replaces the fixed wait when the backend
 * exposes `waitForSettle`: the AX observer debounces
 * the configured `actionSettleMs` of notification silence after a
 * mutation, bounded by `COMPUTER_ACTION_OBSERVER_SETTLE_TIMEOUT_MS` when the
 * surface keeps churning (a busy indicator, a repeating animation). A
 * settled verdict usually lands faster than the fixed budget; a busy surface
 * waits longer than it — both better than the blind sleep they replace.
 */
export const COMPUTER_ACTION_OBSERVER_SETTLE_TIMEOUT_MS = 5_000;
export const COMPUTER_ACTION_OBSERVER_SETTLE_QUIET_MS = COMPUTER_ACTION_SETTLE_MS;

/**
 * How long paste waits before restoring the user's previous clipboard. The
 * target application reads the pasteboard off the keystroke asynchronously, so
 * restoring immediately would hand it the old contents. There is no observable
 * "the app read it" event, so this is a fixed settle like the action-screenshot
 * one above — long enough for the paste to land, short enough that a user who
 * reaches for their own clipboard next is not racing us.
 */
export const COMPUTER_PASTE_RESTORE_MS = 250;

/**
 * Trailing-edge window on the republish that a backend window change triggers.
 *
 * A publish costs one availability read, one window read and one screen-size
 * read per thread, and the window read is itself what reports a change — so a
 * desktop with a ticking window title (a clock, a download percentage, a video
 * player's timer) publishes, observes its own read as a change, and publishes
 * again, once per thread, without ever settling. Coalescing turns that into at
 * most one pass per window, which is the only rate that is bounded by something
 * other than how fast D-Bus answers.
 *
 * The window list itself is not delayed by this: `computer.windows-changed` is
 * emitted immediately from the event, with no backend call at all.
 */
export const COMPUTER_WINDOWS_PUBLISH_DEBOUNCE_MS = 250;

/**
 * The first vertical scroll into a window whose gearing is unknown is split:
 * this many requested pixels go first as a probe whose travel is measured and
 * learned, and the remainder is delivered pre-corrected. Sized so that even a
 * client gearing pixels up by the largest believable ratio keeps the probe's
 * travel inside the correlator's measurable band, while staying above the
 * store's minimum learnable injection.
 */
export const SCROLL_PROBE_PX = 48;
/**
 * Requests at or below this skip the probe: they are already probe-sized, and
 * even a heavily geared client keeps their travel measurable. Anything larger
 * into an unmeasured window is split — a 90 px request at 7x already travels
 * past what a window-height capture pair can correlate.
 */
export const SCROLL_PROBE_TRIGGER_PX = SCROLL_PROBE_PX;

/**
 * How close a leg's measured travel must land to its predicted distance before
 * that measurement itself counts as the settle evidence
 * (`SYNARA_CUA_CONDITIONAL_SETTLE`): the relative slack covers animation and
 * delivery residue on long legs, the floor covers the correlator's row
 * quantization on short ones.
 */
export const SCROLL_SETTLE_ARRIVAL_TOLERANCE = 0.15;
export const SCROLL_SETTLE_ARRIVAL_MIN_PX = 4;

/**
 * How long recordError waits before republishing the threads it touched, so an
 * outage that fails ten calls in a burst costs one publish, not ten.
 */
export const COMPUTER_ERROR_REPUBLISH_DEBOUNCE_MS = 250;

/**
 * How long the running-app inventory a denylist window check resolves pids
 * through may be reused. `list_windows` carries an app name and a pid but no
 * bundle id, so a name that does not itself match the denylist is resolved
 * through `list_apps` — the same read `computer_list_apps` makes. Caching it
 * keeps every click and keystroke from paying for a process enumeration;
 * thirty seconds is short enough that a freshly-installed password manager is
 * still refused on essentially the next call.
 */
const COMPUTER_DENYLIST_APP_CACHE_MS = 30_000;

export type ComputerEventListener = (event: ComputerEvent) => void;

interface ThreadComputerRuntimeState {
  version: number;
  lastError: string | null;
  /**
   * An error reported by a caller (stream attach, device surface), not by
   * the physical read — `publishNow` owns `lastError` and would erase it.
   * The next publish carries it in the snapshot's `lastError` slot, then it
   * is consumed and cleared.
   */
  reportedError: string | null;
  inputPause?: NonNullable<ThreadComputerState["inputPause"]>;
  windows: readonly ComputerWindow[];
  screenSize: ComputerScreenSize;
  availability: ComputerAvailability;
  cursor?: ComputerPoint;
  /**
   * Whether this thread's agent activity has already asked the UI to open the
   * computer pane. Actions arrive every few seconds, so surfacing is once per
   * thread: repeating the request would emit an event per click and could yank
   * a user who deliberately closed the pane back to it.
   */
  paneSurfaced: boolean;
}

/** The single desktop's exclusive owner, and when it last drove it. */
interface DesktopLease {
  readonly threadId: string;
  readonly turnId?: string;
  lastActivityMs: number;
  releaseRequested?: boolean;
  /** The turn the deferred release was requested for — a renewed lease ignores it. */
  releaseRequestedTurnId?: string | undefined;
}

/** Semantic writes own a window; keyboard and modal state belong to its process. */
interface BackgroundControlTarget {
  readonly key: string;
  readonly pid?: number;
  readonly windowId?: string;
}

interface BackgroundLease extends DesktopLease {
  readonly target: BackgroundControlTarget;
}

export interface ComputerManagerOptions {
  readonly backend: ComputerBackend;
  readonly controlStatePath?: string;
  /**
   * Where the mutating-call audit log appends — beside the control state in
   * the server state dir. Absent means no audit file: tests and in-memory
   * embeddings get the same behavior the feature had before it existed.
   */
  readonly auditLogPath?: string;
  readonly transport?: FrameTransport<string, ComputerStreamFrame>;
  /** Injected for tests; the lease is the only clock-dependent state here. */
  readonly now?: () => number;
  readonly leaseIdleMs?: number;
  /** Injected for tests, so action-screenshot tests do not sleep for real. */
  readonly actionSettleMs?: number;
  /** Injected for tests, so window-churn tests do not wait out the real window. */
  readonly windowsPublishDebounceMs?: number;
  /** Injected for tests; decodes and correlates two PNG captures. */
  readonly measureScrollTravel?: (
    before: Uint8Array,
    after: Uint8Array,
  ) => number | undefined | Promise<number | undefined>;
}

/**
 * A resolved pointer target, plus what the window read taken while resolving it
 * showed covering the point. The covering list rides along so the raise-failure
 * path can decide whether to refuse without paying a second window read.
 */
interface ResolvedPointTarget {
  readonly point: ComputerPoint;
  readonly windowId?: string;
  readonly covering?: readonly ComputerWindow[];
  readonly semantic?: ComputerResolvedTarget;
}

/**
 * What the raise/focus step needs. The point is optional because keyboard
 * actions name a window without one, and with no point there is nothing an
 * occlusion check could be about.
 */
type PreparedTarget = Omit<ResolvedPointTarget, "point"> & {
  readonly point?: ComputerPoint;
};

/**
 * The click variants `computer_click` folds into one call: which button, and
 * how many presses. The driver exposes left x1-3 and a single right click;
 * every other combination is refused before a target is even resolved.
 */
export interface ComputerClickGesture {
  readonly count?: 1 | 2 | 3;
  readonly button?: "left" | "right" | "middle";
}

/** A capture plus which window it covers, when it covers one at all. */
export interface ComputerCapturedWindow {
  readonly screenshot: ComputerScreenshot;
  readonly windowId?: string;
}

/** The action's captured window, or confirmation that it closed. */
export type ComputerActionObservation =
  | ComputerCapturedWindow
  | { readonly targetWindowClosed: true };

/**
 * Refusal raised when another thread owns the desktop. It extends
 * `ComputerBackendError` so every existing catch site keeps classifying it,
 * and explicitly discourages immediate retries: time spent repeating the
 * same refusal cannot free the other conversation's desktop lease.
 */
export class ComputerLeaseError extends ComputerBackendError {
  readonly code = "computer_controlled_by_other_thread";

  constructor(targetOnly = false) {
    super(
      (targetOnly
        ? "This application or window is controlled by another conversation; "
        : "The shared pointer and focused keyboard are controlled by another conversation; ") +
        "no input was sent. Do not retry this blocked action or switch tools to bypass " +
        "the lease. Wait until that conversation's turn ends. Reading the desktop still " +
        "works. Background actions on independently owned applications remain available.",
      { retryable: false },
    );
    this.name = "ComputerLeaseError";
  }
}

/** Whether the window found frontmost before an activation was put back. */
export type ForegroundRestoreStatus =
  | "restored"
  | "restore-missed"
  | "already-frontmost"
  | "frontmost-unobservable";

/** Which window a foreground excursion restored, and whether that succeeded. */
export interface ForegroundRestoreInfo {
  readonly restoredWindowId: string | null;
  readonly restoreStatus: ForegroundRestoreStatus;
}

/** Thread state, targeting, action dispatch, and stream ownership for a computer. */
export class ComputerManager {
  readonly computerId: ComputerId;

  private readonly backend: ComputerBackend;
  private readonly transport: FrameTransport<string, ComputerStreamFrame>;
  private readonly listeners = new Set<ComputerEventListener>();
  /** Per-thread publish serialization; see `publish`. */
  private readonly publishChains = new Map<string, Promise<unknown>>();
  private errorRepublishTimer: ReturnType<typeof setTimeout> | undefined;
  private nextStateVersion = -1;
  private readonly screenshotBytes = new WeakMap<ComputerScreenshot, Uint8Array>();
  private readonly threads = new Map<string, ThreadComputerRuntimeState>();
  /**
   * Agent calls in flight, per thread. Deliberately not a field on the thread
   * runtime record: a thread can drive the desktop without any record existing
   * — on a visible-desktop backend no pane is ever surfaced, so nothing creates
   * one until a panel asks for that thread's state, which may be never — and
   * this count is what stops the desktop lease being taken from a thread whose
   * drag or keystroke is still running. Entries are deleted as they reach zero,
   * so nothing accumulates and a removed thread is not resurrected by a late
   * call.
   */
  private readonly agentCallsInFlight = new Map<string, number>();
  private readonly backgroundLeases = new Map<string, BackgroundLease>();
  private readonly knownAppNames = new Set<string>();
  /** Display names for the agent cursor badge, keyed by thread id. */
  private readonly threadLabels = new Map<string, string>();
  private readonly backendUnsubscribe?: () => void;
  private readonly now: () => number;
  private readonly leaseIdleMs: number;
  private readonly actionSettleMs: number;
  private readonly windowsPublishDebounceMs: number;
  private readonly measureScrollTravel: (
    before: Uint8Array,
    after: Uint8Array,
  ) => number | undefined | Promise<number | undefined>;
  /** Learned per window and kept for the manager's life; see ScrollGearingStore. */
  private readonly scrollGearing = new ScrollGearingStore();
  private readonly scrollGearingFile: ScrollGearingFile;
  /** Depth rather than a flag: a lease publish can nest inside a window one. */
  private publishAllDepth = 0;
  private windowsPublishPending = false;
  /**
   * Whether this backend answers `waitForSettle`. "unsupported" is sticky —
   * the driver and the host's tool allowlist are fixed for the backend's
   * life — but a transient failure (stale target, retired generation,
   * cancelled call) never flips it: the next action probes again rather than
   * permanently losing the observer over one bad target.
   */
  private observerSettle: "unknown" | "supported" | "unsupported" = "unknown";
  private windowsPublishTimer: ReturnType<typeof setTimeout> | undefined;
  private backendHealth: ComputerHealth;
  private lease: DesktopLease | null = null;
  /**
   * Whether anything has yet asked this backend for the desktop itself.
   *
   * Until something has, the manager must not: on KWin, the first backend call
   * connects to the compositor, installs the plugin — building it from source
   * on a machine that has never had it — and loads it into the running session.
   * That is the right price for an agent's first tool call, a pane the user
   * opened, or input they sent; it is the wrong price for rendering a chat,
   * which is what seeds thread state. So state publishes read the passive probe
   * until a real use flips this, and behave exactly as they always did after.
   */
  private backendEngaged = false;
  /**
   * When the human last drove the desktop through this server's pane-input
   * paths (`threadId === undefined` on the input methods). The foreground
   * funnels read it to refuse a raise while the user is actively interacting;
   * it is deliberately the manager's own clock, not a second activity bus.
   */
  private lastUserDesktopInputAt: number | undefined;

  /**
   * Which desktop vocabulary the tool descriptions must speak. See
   * `ComputerAgentDialect`: the shortcut form, the semantic action names, and
   * the shape of an application identifier all differ, and describing the wrong
   * family's answer teaches the model calls this desktop will always refuse.
   */
  get agentDialect(): ComputerAgentDialect {
    return this.backend.agentDialect ?? "linux";
  }

  get supportsFocusNeutralSemanticText(): boolean {
    return this.backend.focusNeutralSemanticText === true;
  }

  /** Trusted observations only: resolving visible-use intent never performs IPC. */
  observedAppNames(): readonly string[] {
    return [...this.knownAppNames];
  }

  private rememberObservedAppNames(windows: readonly ComputerWindow[]): void {
    for (const window of windows) {
      const name = window.appName?.trim();
      if (!name) continue;
      this.knownAppNames.delete(name);
      this.knownAppNames.add(name);
    }
    while (this.knownAppNames.size > 256)
      this.knownAppNames.delete(this.knownAppNames.values().next().value!);
  }

  /**
   * Read live rather than cached at construction: a backend that re-probes or
   * provisions may upgrade a capability when its missing piece appears (a
   * helper installed, a plugin built, an extension enabled), and the call is
   * synchronous and cheap by the backend contract, so freshness costs a state
   * publish nothing. A backend that changes its set announces it as
   * `capabilities-changed`, which is what republishes the thread states that
   * already read it.
   */
  private get backendCapabilities(): ComputerCapabilities {
    return this.backend.capabilities();
  }
  private readonly operations = new DesktopOperationQueue();
  readonly cursorActivity: CursorActivity;
  readonly spaceBroker: ComputerSpaceBroker;
  private activity: string | null = null;
  /**
   * The window ids the last window read saw, kept so a post-action read can be
   * diffed against it without paying for a second one.
   *
   * Maintained by `readWindows`, which every window read inside this class goes
   * through, and by the backend's own `windows-changed` events.
   */
  private lastKnownWindowIds: ReadonlySet<string> | undefined;
  /**
   * The same cache keyed the other way, so a window id can be resolved to its
   * last reported row without a second backend read. Filled on every
   * `readWindows` and `windows-changed` event.
   */
  private lastKnownWindows = new Map<string, ComputerWindow>();
  /**
   * The window ids that existed when the action now running started. The
   * baseline for "did this action open a window?", which is the question a
   * byte-identical post-action screenshot cannot answer on its own.
   */
  private preActionWindowIds: ReadonlySet<string> | undefined;
  private streamAttached = false;
  private streamDesired = false;
  private streamEpoch = 0;
  private streamTransition: Promise<void> = Promise.resolve();
  private disposed = false;
  private readonly disabledThreads = new Set<string>();
  private readonly controlState: ComputerControlState;
  private readonly auditLog: ComputerAuditLog;
  /**
   * The running-app inventory the denylist's pid resolution reuses; see
   * `COMPUTER_DENYLIST_APP_CACHE_MS` for the bound.
   */
  private deniedAppsCache:
    | { readonly at: number; readonly apps: readonly ComputerApp[] }
    | undefined;
  private readonly pendingControlWrites = new Map<string, Promise<void>>();
  private readonly suspendedThreads = new Set<string>();
  private readonly authorityRevocations = new Map<string, AbortController>();
  private readonly controlRequests = new Map<string, symbol>();
  private readonly pendingStops = new Map<string, Promise<void>>();
  private physicalState:
    | {
        availability: ComputerAvailability;
        windows?: readonly ComputerWindow[];
        screenSize?: ComputerScreenSize;
      }
    | undefined;
  private physicalRead: Promise<void> | undefined;
  private physicalFailure: string | undefined;
  private refreshPhysicalState(): Promise<void> {
    if (this.physicalRead) return this.physicalRead;
    this.physicalRead = (async () => {
      this.physicalFailure = undefined;
      if (this.backendEngaged) {
        const [availability, windows, screenSize] = await Promise.all([
          this.backend.availability(),
          this.readWindows(),
          this.backend.getScreenSize(),
        ]);
        this.physicalState = { availability, windows, screenSize };
      } else
        this.physicalState = {
          availability: await this.backend.probeAvailability(),
        };
    })()
      .catch((error) => {
        this.physicalFailure = clampComputerMessage(
          errorMessage(error),
          "Computer state is unavailable.",
        );
      })
      .finally(() => {
        this.physicalRead = undefined;
      });
    return this.physicalRead;
  }
  private readonly activeAuthorities = new Map<string, Set<AbortController>>();
  private readonly authorityTurns = new Map<string, string>();

  private controlDisabled(threadId: string): boolean {
    return this.disabledThreads.has(threadId) || this.controlState.get(threadId).disabled;
  }

  canActivateControl(threadId: string, generation = 0): boolean {
    return (
      !this.controlDisabled(threadId) &&
      !this.suspendedThreads.has(threadId) &&
      this.controlState.allows(threadId, generation)
    );
  }

  /**
   * One mutating-call record in the local audit log. Called at the seam where
   * the call's final effect is already known — the gateway, after a result or
   * a typed refusal — and never awaited by it: a full or broken log must not
   * delay or fail the action it records.
   *
   * The kill switch writes nothing, and that is enforced here rather than
   * trusted to every caller: a thread whose control is off records no
   * entries — not even the refusal that stopped it — so disabled state can
   * never produce evidence rows the feature was already refusing to act on.
   */
  recordComputerAudit(entry: Omit<ComputerAuditEntry, "ts">): void {
    if (entry.threadId !== undefined && this.controlDisabled(entry.threadId)) return;
    this.auditLog.record(entry);
  }

  getAuditHistory(input: ComputerGetAuditHistoryInput): Promise<ComputerGetAuditHistoryResult> {
    return this.auditLog.readHistory(input);
  }

  /**
   * The denylist check for the admission/consent keys, which are the raw
   * strings a tool call declared — an app name, a bundle id, an executable
   * path, or the `pid <n>` fallback consent uses when a pid could not be
   * named. Synchronous by contract: both call sites are consent bookkeeping
   * that cannot await a process enumeration, so the pid fallback resolves
   * only against the last cached inventory rather than paying for a fresh
   * one inside the serialized operation queue.
   */
  private assertDrivenAppAllowed(app: string): void {
    const direct = computerDenylistMatch({ name: app });
    if (direct) throw new ComputerDenylistError(direct.app, direct.matched);
    const pidMatch = /^pid ([1-9]\d*)$/.exec(app.trim().toLowerCase());
    if (pidMatch === null) return;
    const pid = Number(pidMatch[1]);
    const owner = this.deniedAppsCache?.apps.find((candidate) => candidate.pid === pid);
    if (owner === undefined) return;
    const resolved = computerDenylistMatch({
      name: owner.name,
      bundleId: owner.bundleId,
    });
    if (resolved) throw new ComputerDenylistError(resolved.app, resolved.matched);
  }

  /**
   * The running-app inventory a window's pid resolves through. A window row
   * carries a name and a pid but no bundle id, so a name that does not itself
   * match is checked against the app's bundle id — how `com.dashlane.*` is
   * caught when the reported appName is just "Dashlane". The list is cached
   * briefly rather than enumerated per input; a failed enumeration reuses the
   * stale copy rather than closing the check open.
   */
  private async runningAppsForDenylist(): Promise<readonly ComputerApp[]> {
    const listApps = this.backend.listApps?.bind(this.backend);
    if (listApps === undefined) return this.deniedAppsCache?.apps ?? [];
    const now = this.now();
    const cached = this.deniedAppsCache;
    if (cached !== undefined && now - cached.at < COMPUTER_DENYLIST_APP_CACHE_MS) {
      return cached.apps;
    }
    const apps = await listApps().catch(() => undefined);
    if (apps === undefined) return cached?.apps ?? [];
    this.deniedAppsCache = { at: now, apps };
    return apps;
  }

  /** How a listed window's owning app matches the denylist, or nothing. */
  private async deniedMatchForWindow(
    window: ComputerWindow,
  ): Promise<ReturnType<typeof computerDenylistMatch>> {
    const direct = computerDenylistMatch({ name: window.appName });
    if (direct) return direct;
    if (window.pid === undefined) return undefined;
    const owner = (await this.runningAppsForDenylist()).find(
      (candidate) => candidate.pid === window.pid,
    );
    if (owner === undefined) return undefined;
    return computerDenylistMatch({
      name: owner.name,
      bundleId: owner.bundleId,
    });
  }

  /** How a pid-grain target's owning app matches the denylist, or nothing. */
  private async deniedMatchForPid(
    pid: number,
    name: string | undefined,
  ): Promise<ReturnType<typeof computerDenylistMatch>> {
    const direct = computerDenylistMatch({ name });
    if (direct) return direct;
    const owner = (await this.runningAppsForDenylist()).find((candidate) => candidate.pid === pid);
    if (owner === undefined) return undefined;
    return computerDenylistMatch({
      name: owner.name,
      bundleId: owner.bundleId,
    });
  }

  /**
   * Refuse an agent's input bound for a denylisted window. The human's own
   * pane input is exempt — `threadId` undefined identifies the person at the
   * keyboard, the same exemption the lease makes — while every agent-driven
   * path resolves the window's app before a raise, a focus pin, or a dispatch
   * can touch it.
   */
  private async assertWindowInputAllowed(
    threadId: string | undefined,
    windowId: string,
  ): Promise<void> {
    if (agentThreadId(threadId) === undefined) return;
    const window = (await this.readWindows()).find((candidate) => candidate.id === windowId);
    if (window === undefined) return;
    await this.assertWindowInputAllowedWindow(threadId, window);
  }

  /**
   * The same input check for a window the caller already listed — the
   * window-grain mutation paths resolve their target before consent, so they
   * check the row they hold rather than paying for a second enumeration.
   */
  private async assertWindowInputAllowedWindow(
    threadId: string | undefined,
    window: ComputerWindow,
  ): Promise<void> {
    if (agentThreadId(threadId) === undefined) return;
    const match = await this.deniedMatchForWindow(window);
    if (match) throw new ComputerDenylistError(match.app, match.matched);
    await this.spaceBroker.assertWindowAllowed(
      { threadId: threadId!, turnId: currentComputerTask()?.turnId ?? null },
      window,
    );
  }

  private async assertSpaceAppMutationAllowed(
    threadId: string | undefined,
    pid: number,
  ): Promise<void> {
    const owner = agentThreadId(threadId);
    if (owner === undefined) return;
    await this.spaceBroker.assertAppMutationAllowed(
      { threadId: owner, turnId: currentComputerTask()?.turnId ?? null },
      pid,
    );
  }

  /**
   * Refuse a scoped read of a denylisted window — state, element tree, zoomed
   * capture, verify — for every caller, pane included. The accessibility tree
   * of a password manager carries field values, so scoping into the window is
   * refused outright; presence stays visible through `list_windows`.
   */
  private async assertWindowContentAllowed(windowId: string): Promise<void> {
    const window = (await this.readWindows()).find((candidate) => candidate.id === windowId);
    if (window === undefined) return;
    const match = await this.deniedMatchForWindow(window);
    if (match) throw new ComputerDenylistError(match.app, match.matched);
  }

  /**
   * The visible denylisted windows, when any are on screen. Unscoped content
   * reads — a workspace screenshot, a desktop-wide tree on dialects that
   * answer one — cannot exclude a visible denied surface's pixels or
   * elements, so they refuse while one is shown.
   */
  private async deniedVisibleWindows(): Promise<
    ReadonlyArray<{
      readonly window: ComputerWindow;
      readonly match: NonNullable<ReturnType<typeof computerDenylistMatch>>;
    }>
  > {
    const denied: Array<{
      readonly window: ComputerWindow;
      readonly match: NonNullable<ReturnType<typeof computerDenylistMatch>>;
    }> = [];
    for (const window of await this.readWindows()) {
      if (!window.visible || window.minimized) continue;
      const match = await this.deniedMatchForWindow(window);
      if (match) denied.push({ window, match });
    }
    return denied;
  }

  private async deniedVisibleWindow(): Promise<
    | {
        readonly window: ComputerWindow;
        readonly match: NonNullable<ReturnType<typeof computerDenylistMatch>>;
      }
    | undefined
  > {
    return (await this.deniedVisibleWindows())[0];
  }

  /** Whether a window id names a denylisted surface; for best-effort observation skips. */
  private async windowIsDenied(windowId: string): Promise<boolean> {
    const window = (await this.readWindows()).find((candidate) => candidate.id === windowId);
    return window !== undefined && (await this.deniedMatchForWindow(window)) !== undefined;
  }

  async admitControl(
    threadId: string,
    mode: ComputerControlMode,
    generation = 0,
    explicitInvocation = false,
  ): Promise<boolean> {
    // A fresh user invocation can re-arm a stopped task. An invocation queued
    // before Stop still carries the old generation and cannot revive input.
    // The guard must read the generation a pending disable will bump to —
    // the write is serialized asynchronously, so waiting out the in-flight
    // control write is what keeps a stale invocation from slipping the gap.
    if (explicitInvocation && mode === "request" && this.controlDisabled(threadId)) {
      await this.pendingControlWrites.get(threadId)?.catch(() => undefined);
    }
    if (
      explicitInvocation &&
      mode === "request" &&
      this.controlState.get(threadId).generation === generation &&
      !this.suspendedThreads.has(threadId) &&
      this.controlDisabled(threadId)
    ) {
      await this.setControlEnabled(threadId, true);
    }
    const enabled = mode !== "off" && this.canActivateControl(threadId, generation);
    // Request admission lasts through this turn's tool loop and approval waits.
    // Only an explicit chat default survives into later turns or goals.
    try {
      await this.controlState.recordChatIntent(threadId, enabled && mode === "chat", generation);
    } catch (error) {
      // Fail closed and LOUD: a persist failure means durable intent is
      // unrecorded, so the thread is disabled; without this warning the next
      // turn's silent canContinue=false looks like a stickiness bug.
      console.warn("[computer] admitControl persist failed, disabling thread", {
        threadId,
        mode,
        generation,
      });
      this.disabledThreads.add(threadId);
      throw error;
    }
    return enabled && this.canActivateControl(threadId, generation);
  }

  canContinueChatControl(threadId: string): boolean {
    const state = this.controlState.get(threadId);
    return (
      state.chatGeneration === state.generation &&
      this.canActivateControl(threadId, state.generation)
    );
  }

  async setControlEnabled(
    threadId: string,
    enabled: boolean,
  ): Promise<{ enabled: boolean; generation: number }> {
    const request = Symbol();
    this.controlRequests.set(threadId, request);
    if (enabled) {
      // The durable gate stays closed until the new preference is on disk:
      // `disabledThreads` is held through the write, and a write that hangs
      // past the timeout throws with the gate still held (fail closed), so
      // authority can never open on an unrecorded preference.
      await withControlEnableTimeout(this.pendingControlWrites.get(threadId));
      await withControlEnableTimeout(this.pendingStops.get(threadId));
      if (this.controlRequests.get(threadId) === request) {
        // Hold the in-memory gate closed until the new preference is durable.
        this.disabledThreads.add(threadId);
        const write = this.controlState.set(threadId, false);
        this.pendingControlWrites.set(threadId, write);
        await withControlEnableTimeout(write);
        if (this.controlRequests.get(threadId) === request) {
          this.disabledThreads.delete(threadId);
          if (this.authorityRevocations.get(threadId)?.signal.aborted)
            this.authorityRevocations.delete(threadId);
        }
      }
    } else {
      this.disabledThreads.add(threadId);
      const runtime = this.threads.get(threadId);
      if (runtime) runtime.paneSurfaced = false;
      // Increment immediately, before cleanup or persistence can yield. Old
      // queued requests never regain authority when this thread is re-enabled.
      const write = this.controlState.set(threadId, true);
      this.pendingControlWrites.set(threadId, write);
      // Bounded like the enable path: the disable itself already holds
      // (disabledThreads is synchronous), so a wedged stop cannot strand
      // the RPC — it can only cost the cleanup confirmation.
      const outcomes = await withControlTeardownTimeout(
        Promise.allSettled([write, this.revokeControl(threadId)]),
      );
      const failed = outcomes.find((outcome) => outcome.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    }
    if (this.controlRequests.get(threadId) === request) {
      this.controlRequests.delete(threadId);
      this.pendingControlWrites.delete(threadId);
    }
    // A thread mid-removal has no pane to update — publishing here would
    // resurrect a runtime record the removal is trying to delete.
    if (!this.suspendedThreads.has(threadId)) {
      this.threadRuntime(threadId);
      this.publishCached(threadId);
    }
    return {
      enabled: !this.controlDisabled(threadId) && !this.suspendedThreads.has(threadId),
      generation: this.controlState.get(threadId).generation,
    };
  }

  private revokeControl(threadId: string): Promise<void> {
    // Settle pending approval prompts synchronously: a mid-turn Off must not
    // leave a prompt hanging until the gate's five-minute timeout.
    computerApprovalGate.cancelThread(threadId);
    const revokeReason = new ComputerBackendError(
      "Computer control was revoked for this conversation; no new input may be dispatched.",
      { controlRevoked: true },
    );
    this.authorityRevocations.get(threadId)?.abort(revokeReason);
    // Live ops get the same reason, not a bare AbortError: a call cancelled
    // by an Off must classify as control-revoked, not a retryable abort.
    for (const controller of this.activeAuthorities.get(threadId) ?? [])
      controller.abort(revokeReason);
    const pending = this.pendingStops.get(threadId);
    if (pending) return pending;
    const stop = (async () => {
      if (
        this.lease?.threadId === threadId ||
        [...this.backgroundLeases.values()].some((lease) => lease.threadId === threadId) ||
        (this.activeAuthorities.get(threadId)?.size ?? 0) > 0
      )
        await this.backend.stopInput?.({
          threadId,
          ...(this.authorityTurns.get(threadId)
            ? { turnId: this.authorityTurns.get(threadId)! }
            : {}),
        });
      await this.releaseDesktopControl(threadId);
    })().finally(() => {
      this.pendingStops.delete(threadId);
    });
    this.pendingStops.set(threadId, stop);
    return stop;
  }

  /**
   * The refusal every admitted input path shares for a thread whose control
   * was switched off or suspended: it hears it before the lease, the window
   * gate, or any dispatch. `undefined` is pane input, which belongs to no
   * thread and is exempt — the human's own kill switch does not lock the
   * human out.
   */
  private assertControlAuthority(owner: string | undefined): void {
    if (owner === undefined) return;
    if (!this.controlDisabled(owner) && !this.suspendedThreads.has(owner)) return;
    throw new ComputerBackendError(
      "Computer control was revoked for this conversation; no input was dispatched.",
      { controlRevoked: true },
    );
  }

  /**
   * The pause refusal both control wrappers make before the lease or the
   * backend can engage: a thread the host paused is refused before it can
   * claim the desktop or dispatch anything.
   */
  private assertInputNotPaused(owner: string | undefined): void {
    const pausedState = owner ? this.threads.get(owner) : undefined;
    if (pausedState?.inputPause) {
      throw new ComputerBackendError(pausedState.inputPause.message, {
        inputPause: pausedState.inputPause,
      });
    }
  }

  /**
   * The never-raise gate every foreground excursion passes before it can move
   * a window in front of the user.
   *
   * Two refusals, both `not-dispatched` so the delivery taxonomy stays honest:
   * the user's own task text never asked to see the app or window
   * (`foreground_not_requested`), or the user was interacting with the desktop
   * moments ago (`foreground_user_interaction`). Absent authorization is a
   * refusal, not a default: the Helium incident is exactly the case where no
   * layer should be able to infer consent to raise from the approval mode.
   *
   * Pane input is exempt: a human driving their own desktop through the pane
   * is the user, not an agent, and the gate exists to protect them from us.
   *
   * The interaction window reads the same clock and queue as the rest of the
   * manager — the timestamp is stamped by the pane-input paths, and both pane
   * input and agent work serialize on the desktop queue, so the window only
   * covers rapid interleaving, never a concurrent dispatch.
   *
   * The gate runs inside the queued action (dispatch time), which is what
   * makes the stamp meaningful for an agent call that waited behind the pane
   * input the user had just sent.
   */
  private assertForegroundAllowed(
    threadId: string | undefined,
    authorization: ComputerForegroundAuthorization | undefined,
  ): void {
    if (agentThreadId(threadId) === undefined) return;
    if (authorization?.userRequestedVisibleUse !== true) {
      throw new CuaActionError(
        "The user's task did not ask for this app or window to be shown. Stay in the background: " +
          "keep observing and acting through background input, or ask the user to confirm " +
          "they want to watch — their reply that asks to see the screen authorizes the raise.",
        "not-dispatched",
        COMPUTER_FOREGROUND_NOT_REQUESTED_CODE,
      );
    }
    const lastInput = this.lastUserDesktopInputAt;
    if (lastInput !== undefined && this.now() - lastInput < COMPUTER_USER_INTERACTION_QUIET_MS) {
      throw new CuaActionError(
        "The user was interacting with the desktop moments ago; bringing a window forward " +
          "now would take their focus. Wait for the desktop to be quiet, then retry if the " +
          "task still needs foreground delivery.",
        "not-dispatched",
        COMPUTER_FOREGROUND_USER_INTERACTION_CODE,
      );
    }
  }

  /**
   * Record an input pause a dispatch reported: the state publishes so panels
   * show the gate, but only a still-authorized thread's own record is
   * written — a revoked or disposed thread has nothing to update.
   */
  private recordInputPause(owner: string | undefined, error: unknown): void {
    if (
      owner &&
      !this.disposed &&
      !this.suspendedThreads.has(owner) &&
      !this.controlDisabled(owner) &&
      error instanceof ComputerBackendError &&
      error.inputPause
    ) {
      this.threadRuntime(owner).inputPause = error.inputPause;
      this.publishCached(owner);
    }
  }

  /**
   * The manager side of the physical Escape interrupt, relayed from the
   * desktop's monitor route (or invoked directly by tests).
   *
   * Momentary by contract: the press aborts every in-flight operation signal
   * and every admission broadcast, so calls that were live fail with the
   * stop's own `controlRevoked` classification (the model must not retry
   * them) and work queued behind them fails at its wait instead of
   * dispatching after the press. The OS-level held-input release is the
   * backend's `stopInput`. Nothing latches: once the stop has been delivered
   * the next admitted action dispatches normally, so there is no re-arm API
   * and no stopped state that outlives this call.
   */
  async emergencyStopInput(): Promise<void> {
    if (this.disposed) return;
    // Announced before the abort so a client hears the interrupt even if the
    // backend stop wedges; the closing event is delivered with the stop.
    this.emit({ type: "computer.input-stopped", stopped: true });
    const stopReason = new ComputerBackendError(
      "Computer input was stopped with the Escape key; no new input may be dispatched.",
      { controlRevoked: true },
    );
    // Abort every admission broadcast and every live operation signal: calls
    // queued behind the operation queue fail at their wait instead of
    // dispatching after the press, and in-flight native calls get the same
    // cancellation an ordinary stop delivers.
    for (const authority of this.authorityRevocations.values()) {
      authority.abort(stopReason);
    }
    for (const live of this.activeAuthorities.values()) {
      // The same reason, not a bare AbortError: a tool call cancelled by the
      // press must report the stop, not a generic abort the model might retry.
      for (const controller of live) controller.abort(stopReason);
    }
    try {
      await this.backend.stopInput?.();
    } finally {
      // Momentary: input reopens with the stop's own delivery. No latch and
      // no epoch survive this point — the next admitted action succeeds
      // without any re-arm.
      this.emit({ type: "computer.input-stopped", stopped: false });
    }
  }

  constructor(options: ComputerManagerOptions) {
    this.backend = options.backend;
    this.spaceBroker = new ComputerSpaceBroker({
      assertActive: assertDesktopOperationActive,
      readSnapshot: async () => {
        if (!this.backend.listSpaces)
          throw new ComputerSpaceError(
            "computer_spaces_unavailable",
            "This backend does not expose managed Space inventory. Drive an exact existing window in place instead.",
          );
        this.engageBackend();
        const inventory = await this.backend.listSpaces();
        const windows = await this.readWindows();
        return { inventory, windows };
      },
    });
    this.controlState = new ComputerControlState(options.controlStatePath);
    // Beside the control state file: same directory, same local-only lifetime.
    this.auditLog = new ComputerAuditLog(options.auditLogPath);
    // Beside the control state: same directory, same atomicity expectations.
    this.scrollGearingFile = new ScrollGearingFile(
      options.controlStatePath === undefined
        ? undefined
        : join(dirname(options.controlStatePath), "computer-scroll-gearing.json"),
    );
    this.cursorActivity = new CursorActivity((text) => {
      this.activity = text;
      for (const threadId of this.threads.keys()) this.publishCached(threadId);
      return this.backend.setCursorActivity?.(text);
    });
    this.computerId = options.backend.computerId;
    this.now = options.now ?? Date.now;
    this.leaseIdleMs = options.leaseIdleMs ?? COMPUTER_LEASE_IDLE_MS;
    this.actionSettleMs =
      options.actionSettleMs ?? cuaActionSettleMsOverride() ?? COMPUTER_ACTION_SETTLE_MS;
    this.windowsPublishDebounceMs =
      options.windowsPublishDebounceMs ?? COMPUTER_WINDOWS_PUBLISH_DEBOUNCE_MS;
    this.measureScrollTravel = options.measureScrollTravel ?? measureScrollTravelFromPng;
    this.backendHealth = options.backend.health();
    this.transport =
      options.transport ??
      new FrameTransport<string, ComputerStreamFrame>({
        independentStills: true,
        encode: (computerId, frame) =>
          encodeComputerFrame({
            header: {
              computerId,
              sequence: frame.sequence,
              timestampMs: frame.timestampMs,
              keyframe: frame.keyframe,
              codecConfig: frame.codecConfig,
            },
            payload: frame.data,
          }),
        queueLimit: COMPUTER_FRAME_QUEUE_LIMIT,
        socketBudgetBytes: COMPUTER_FRAME_SOCKET_BUDGET_BYTES,
        subscriberIdPrefix: "computer-frame-subscriber",
      });
    if (options.backend.onEvent) {
      this.backendUnsubscribe = options.backend.onEvent((event) => {
        if (event.type === "windows-changed") {
          this.lastKnownWindowIds = windowIdSet(event.windows);
          this.lastKnownWindows = new Map(event.windows.map((window) => [window.id, window]));
          this.rememberObservedAppNames(event.windows);
          for (const state of this.threads.values()) state.windows = event.windows;
          this.emit({
            type: "computer.windows-changed",
            windows: event.windows,
          });
          this.scheduleWindowsPublish();
        } else if (event.type === "health-changed") {
          this.backendHealth = event.health;
          this.republishAllThreads();
        } else if (event.type === "capabilities-changed") {
          this.republishAllThreads();
        } else if (event.type === "desktop-interrupted") {
          // Locked-use resume policy: consent granted before a lock/sleep/
          // session interruption does not carry across it. The host already
          // refuses input until a fresh model observation lands; revoking
          // the standing grants here adds the re-auth half — the next
          // mutating call republishes its prompt instead of riding the
          // pre-interruption "Allow Computer for this task" answer.
          computerApprovalGate.revokeTaskGrants();
        }
      });
    }
  }

  onEvent(listener: ComputerEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Marks the desktop as wanted, and repaints every panel once it is.
   *
   * Called by every path that is about to use the backend for a real reason —
   * an agent tool call, a pane attach, pane input — and by nothing else. The
   * republish is what keeps the pane honest: before this point its snapshot
   * carries no windows and a placeholder screen size, and the frames that are
   * about to arrive are letterboxed against exactly that size. It runs detached
   * because the caller is on its way to the compositor and must not wait for a
   * window enumeration to finish first.
   */
  private engageBackend(): void {
    if (this.backendEngaged || this.disposed) return;
    this.backendEngaged = true;
    void this.publishAllThreads().catch(() => undefined);
  }

  async availability(): Promise<ComputerAvailability> {
    this.engageBackend();
    return await this.backend.availability();
  }

  /**
   * OS privacy grants the backend lacks *now*, not as of some earlier probe.
   *
   * Empty on backends with no permission model and before anything has looked.
   * This is how a grant that only *degrades* the desktop — Screen Recording,
   * which leaves it driveable but unseeable — still reaches the user, since
   * nothing fails and availability stays `available`.
   *
   * A probe that fails answers "nothing missing" rather than throwing: the
   * caller is a tool call that has its own result to return, and a backend that
   * cannot be asked is a health problem reported through health, not a grant the
   * user is being told to go and give.
   */
  async missingPermissions(): Promise<readonly ComputerPermission[]> {
    try {
      return (await this.backend.missingPermissions?.()) ?? [];
    } catch {
      return [];
    }
  }

  /**
   * How the backend's build is code-signed, when it knows. Free to read, and
   * only meaningful next to a missing grant: on an ad-hoc build the grant may be
   * pinned to a cdhash a rebuild replaced, which is why System Settings can show
   * the switch on while the backend reports it missing.
   */
  buildSignature(): ComputerBuildSignature | undefined {
    return this.backend.buildSignature?.();
  }

  /**
   * Thread-independent status for surfaces outside any conversation, such as
   * the settings screen. A probe failure becomes `backend-unavailable` rather
   * than an error: the caller is asking whether the desktop works, and "the
   * probe itself failed" is an answer to that question, not a failure to
   * answer it.
   */
  async getStatus(): Promise<ComputerStatusResult> {
    // Asked by the settings screen. Once something real has engaged the
    // backend it gets the establishing read, because the screen exists to
    // report what the desktop really is — but merely opening settings must
    // not be the thing that installs and loads compositor code on a machine
    // where nothing has ever used the feature, so before first engagement it
    // answers from the side-effect-free probe.
    let availability: ComputerAvailability;
    try {
      availability = this.backendEngaged
        ? await this.backend.availability({ refresh: true })
        : await this.backend.probeAvailability();
    } catch (error) {
      availability = {
        kind: "backend-unavailable",
        message: clampComputerMessage(errorMessage(error), "The computer backend failed."),
      };
    }
    return {
      computerId: this.computerId,
      availability: this.correctedAvailability(availability),
      health: this.backendHealth,
      capabilities: this.backendCapabilities,
      provisionable: this.backend.provision !== undefined,
    };
  }

  /**
   * Set this desktop up, then answer with what it looks like now.
   *
   * Engages the backend first: the user pressing "Set up" is exactly the real
   * reason `engageBackend` exists to wait for, and the establishing reads that
   * follow have to see an engaged backend or they will answer from the passive
   * probe the button was pressed to get past.
   */
  async provision(): Promise<ComputerProvisionResult> {
    this.engageBackend();
    if (!this.backend.provision) {
      throw new Error("This desktop backend has nothing to install.");
    }
    // Composed from output nothing here controls — a compiler's diagnostics, a
    // package manager's transcript — so it is clamped before it can either fail
    // the encode of a provision that actually succeeded or push a build log
    // into the settings card.
    const summary = clampTextToLength(
      await this.backend.provision(),
      COMPUTER_PROVISION_SUMMARY_MAX_LENGTH,
    );
    return { summary, status: await this.getStatus() };
  }

  /**
   * Every window read this class makes, with the resulting id set remembered.
   *
   * The memory is what lets the post-action observer answer "did this action
   * open a window?" without paying for a read it would otherwise not need: the
   * baseline is whatever the last read already saw.
   */
  private async readWindows(): Promise<readonly ComputerWindow[]> {
    const windows = await this.backend.listWindows();
    this.lastKnownWindowIds = windowIdSet(windows);
    this.lastKnownWindows = new Map(windows.map((window) => [window.id, window]));
    this.rememberObservedAppNames(windows);
    return windows;
  }

  async listWindows(): Promise<ComputerListWindowsResult> {
    this.engageBackend();
    const [availability, windows] = await Promise.all([
      this.backend.availability(),
      this.readWindows(),
    ]);
    return { computerId: this.computerId, windows, availability };
  }

  /**
   * One perception read, with the accessibility tree and its prose rendering
   * asked for separately.
   *
   * They were one flag, and every caller that wanted the tree — which is every
   * agent-facing perception read, because the elements list is built from it —
   * also paid to render the whole desktop to text and then discarded it. The
   * walk is the expensive part and is still opt-in; the rendering is cheap but
   * not free, and now happens only for the callers that display it. It lives
   * here rather than in each backend so both display servers benefit from one
   * fix and answer with identically formatted text.
   */
  async getState(
    options: {
      readonly includeScreenshot?: boolean;
      /** Render `root` to accessibility text. Implies `includeTree`. */
      readonly includeText?: boolean;
      /** Walk the accessibility tree. Defaults to whatever `includeText` asked for. */
      readonly includeTree?: boolean;
      readonly windowId?: string;
    } = {},
  ): Promise<ComputerState> {
    this.engageBackend();
    // A scoped read of a denied window refuses outright — its accessibility
    // tree carries field values. An unscoped read refuses only what it would
    // actually contain: a workspace screenshot photographs a visible denied
    // window on every dialect, while a desktop-wide element tree only exists
    // on dialects whose backend walks one (macOS answers unscoped reads with
    // window metadata alone, which is presence — allowed).
    if (options.windowId !== undefined) {
      await this.assertWindowContentAllowed(options.windowId);
    } else if (
      options.includeScreenshot === true ||
      ((options.includeTree === true || options.includeText === true) &&
        this.agentDialect !== "macos")
    ) {
      const denied = await this.deniedVisibleWindow();
      if (denied) throw new ComputerDenylistError(denied.match.app, denied.match.matched);
    }
    // Availability rides alongside, as it already does on the window-list and
    // screen-size reads. Without it the primary perception tool was the one
    // result that could not say "the OS is withholding a grant", so the setup
    // card never fired for the call an agent makes first.
    const [state, availability] = await Promise.all([
      this.backend.getState({
        ...(options.includeScreenshot !== undefined
          ? { includeScreenshot: options.includeScreenshot }
          : {}),
        includeTree: options.includeTree ?? options.includeText === true,
        ...(options.windowId ? { windowId: options.windowId } : {}),
      }),
      this.backend.availability(),
    ]);
    // A fresh, scoped observation is the recovery boundary. Merely capturing
    // pixels or waiting does not establish that input is possible again.
    if (options.windowId) await this.refreshInputPause(options.windowId, state.windows);
    const inputPause =
      (this.lease ? this.threads.get(this.lease.threadId)?.inputPause : undefined) ??
      (options.windowId
        ? [...this.threads.values()].find(
            (thread) => thread.inputPause?.windowId === options.windowId,
          )?.inputPause
        : undefined);
    const withAvailability = {
      ...state,
      availability: this.correctedAvailability(availability),
      ...(inputPause ? { inputPause } : {}),
    };
    if (options.includeText !== true || !withAvailability.root) return withAvailability;
    return {
      ...withAvailability,
      text: describeComputerUiTree(withAvailability.root),
    };
  }

  /** Zoomed capture of one window or desktop region, with its pixel mapping. */
  async captureScreenshot(request: ComputerCaptureRequest): Promise<ComputerScreenshot> {
    this.engageBackend();
    if (request.kind === "window") {
      await this.assertWindowContentAllowed(request.windowId);
    } else {
      // A region photographs whatever its rect covers: it is refused only
      // where a visible denied window's bounds actually intersect it.
      const denied = (await this.deniedVisibleWindows()).find(
        (entry) =>
          entry.window.bounds !== undefined && rectsOverlap(entry.window.bounds, request.region),
      );
      if (denied) throw new ComputerDenylistError(denied.match.app, denied.match.matched);
    }
    return await this.backend.captureScreenshot(request);
  }

  /**
   * The explicit agent-facing settle wait (`computer_wait` with
   * `settle:true`): validate the exact window, then let the driver's AX
   * observer debounce its surface until quiet — or, when this backend cannot
   * answer `waitForSettle`, fall back to the fixed post-action pause and say
   * so. The wait never sends input, never raises the window, and a refused or
   * failed observer reports through `mode` rather than being retried.
   */
  async waitForSettle(
    windowId: string,
    timeoutMs: number,
  ): Promise<{
    readonly settled: boolean;
    readonly waitedMs: number;
    readonly eventsSeen?: number;
    readonly mode: "observer" | "fixed";
  }> {
    this.engageBackend();
    return this.withComputerCall(async () => {
      markComputerCall("computer_wait_settle");
      const window = (await this.readWindows()).find((entry) => entry.id === windowId);
      if (!window) throw windowNotFoundError(windowId);
      const timeout = Math.max(
        0,
        Math.min(COMPUTER_ACTION_OBSERVER_SETTLE_TIMEOUT_MS * 6, Math.floor(timeoutMs)),
      );
      if (this.observerSettle !== "unsupported" && this.backend.waitForSettle !== undefined) {
        try {
          const outcome = await this.backend.waitForSettle({
            windowId,
            timeoutMs: timeout,
            quietMs: this.actionSettleMs,
          });
          this.observerSettle = "supported";
          currentComputerCall()?.timing?.count(
            outcome.settled ? "settle_observer_settled" : "settle_observer_timeout",
          );
          return { ...outcome, mode: "observer" as const };
        } catch (error) {
          if (settlePermanentlyUnsupported(error)) this.observerSettle = "unsupported";
          else throw error;
          // A permanent refusal falls through to the fixed wait; a transient
          // one propagates — the caller asked for observed settle, and a
          // guessed quiet window would lie about what was verified.
        }
      }
      const waitedMs = Math.min(timeout, Math.max(0, this.actionSettleMs));
      await new Promise<void>((resolve) => {
        setTimeout(resolve, waitedMs);
      });
      return { settled: true, waitedMs, mode: "fixed" as const };
    });
  }

  /**
   * Zoomed capture of the window that holds input focus, falling back to the
   * whole workspace when no visible window with known bounds has it. This is
   * what a perception request with no explicit target means: "show me where
   * input is going", at window resolution rather than as a workspace-wide
   * downscale that loses small text.
   */
  async captureFocusedWindow(
    maxDimension?: number,
    options: { readonly agentFocusOnly?: boolean } = {},
  ): Promise<ComputerCapturedWindow> {
    this.engageBackend();
    const limit = maxDimension === undefined ? {} : { maxDimension };
    const window = await this.focusedCapturableWindow(options.agentFocusOnly === true);
    if (window) {
      const denied = await this.deniedMatchForWindow(window);
      if (denied) throw new ComputerDenylistError(denied.app, denied.matched);
      return {
        screenshot: await this.backend.captureScreenshot({
          kind: "window",
          windowId: window.id,
          ...limit,
        }),
        windowId: window.id,
      };
    }
    // The whole-workspace fallback photographs every visible window, so a
    // denied one on screen refuses the capture entirely.
    const deniedVisible = await this.deniedVisibleWindow();
    if (deniedVisible)
      throw new ComputerDenylistError(deniedVisible.match.app, deniedVisible.match.matched);
    const screenSize = await this.backend.getScreenSize();
    return {
      screenshot: await this.backend.captureScreenshot({
        kind: "region",
        region: {
          x: 0,
          y: 0,
          width: screenSize.width,
          height: screenSize.height,
        },
        ...limit,
      }),
    };
  }

  /**
   * Best-effort perception for an action that already happened: wait for the
   * UI to settle, then capture the window the action affected — the caller's
   * hint when it named one, otherwise the window under the action's own point,
   * otherwise the agent's own focus target. Failures return no screenshot
   * instead of throwing, because the action itself succeeded and a capture
   * problem must not turn that success into an error.
   *
   * A hinted window that has vanished is reported as `targetWindowClosed`,
   * never replaced by another window. The E2E run that forced this rule ended
   * with the close-Firefox click's "fallback" screenshot handing the agent
   * the human's own browser — the focused window is the human's whenever the
   * agent's target is gone — which both leaked their screen and convinced the
   * agent its click had landed there. For the same reason the untargeted path
   * never observes the compositor-active (human's) window as such. The
   * action-point step honors the same rule from the other direction: the
   * compositor routes an unscoped pointer action to the topmost window at its
   * coordinates, so that window is the one the action touched — photographing
   * it is reporting the action's own outcome, not drifting to someone's focus.
   * Without it, every untargeted scroll came back as a workspace-wide
   * downscale too small to read, and the agent scroll-hunted blind (the Codex
   * OSS form run, 2026-08-22).
   */
  async captureActionScreenshot(
    windowIdHint?: string,
    actionPoint?: ComputerPoint,
    threadId?: string,
    settle = true,
  ): Promise<ComputerActionObservation | undefined> {
    return this.withComputerCall(async () => {
      // A name only when the call did not already take one: an observed
      // action keeps its own name on the shared timing line.
      markComputerCall("computer_observe");
      if (!this.backendCapabilities.capture) return undefined;
      this.engageBackend();
      if (settle && this.actionSettleMs > 0) {
        if (this.actionEffectAlreadyProven()) {
          currentComputerCall()?.timing?.count("settle_skipped");
        } else {
          await timedComputerLeg("settle", () => this.settleAfterAction(windowIdHint));
        }
      }
      return timedComputerLeg("observe", () =>
        this.captureActionObservation(windowIdHint, actionPoint, threadId),
      );
    });
  }

  /**
   * The `SYNARA_CUA_CONDITIONAL_SETTLE=1` waiver, consulted only when a
   * settle would otherwise run. True requires positive effect proof — the
   * action's `verified` effect or its `confirmed` delivery read-back — and
   * stays false for `dispatched-unknown`, `unconfirmed`, `unverifiable`, or
   * no verdict at all: those are exactly the surfaces the fixed wait exists
   * for. The proof is consumed either way, so it can never waive a later
   * call's settle.
   */
  private actionEffectAlreadyProven(): boolean {
    if (!cuaConditionalSettleEnabled()) return false;
    const proof = currentComputerCall()?.takeActionProof();
    return proof?.effect === "verified" || proof?.verified === "confirmed";
  }

  /**
   * One post-action wait. The driver's AX observer is preferred whenever the
   * call knows the target window and the backend offers `waitForSettle`: a
   * quiet surface resolves early and a churning one outlasts the fixed
   * budget. A driver or host that does not know the tool is remembered as
   * "unsupported" so later actions skip straight to the fixed wait; every
   * other failure — stale window, retired generation, cancelled call — only
   * falls back for this action, and none of it can ever be grounds to replay
   * the action itself.
   */
  private async settleAfterAction(windowId: string | undefined): Promise<void> {
    if (
      windowId !== undefined &&
      this.observerSettle !== "unsupported" &&
      this.backend.waitForSettle !== undefined
    ) {
      try {
        const outcome = await this.backend.waitForSettle({
          windowId,
          timeoutMs: COMPUTER_ACTION_OBSERVER_SETTLE_TIMEOUT_MS,
          quietMs: this.actionSettleMs,
        });
        this.observerSettle = "supported";
        currentComputerCall()?.timing?.count(
          outcome.settled ? "settle_observer_settled" : "settle_observer_timeout",
        );
        return;
      } catch (error) {
        if (settlePermanentlyUnsupported(error)) this.observerSettle = "unsupported";
        currentComputerCall()?.timing?.count("settle_observer_unavailable");
        // Fall through to the fixed wait — the action still needs its pause.
      }
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, this.actionSettleMs);
    });
  }

  private async captureActionObservation(
    windowIdHint: string | undefined,
    actionPoint: ComputerPoint | undefined,
    threadId: string | undefined,
  ): Promise<ComputerActionObservation | undefined> {
    if (windowIdHint !== undefined) {
      // An action's own observation must not become a way to photograph a
      // denied surface: the action already ran, so the miss reports no
      // screenshot rather than refusing the call.
      if (await this.windowIsDenied(windowIdHint)) return undefined;
      try {
        return await this.observeActionCapture(
          {
            screenshot: await this.backend.captureScreenshot({
              kind: "window",
              windowId: windowIdHint,
              maxDimension: COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION,
            }),
            windowId: windowIdHint,
          },
          threadId,
        );
      } catch {
        try {
          const stillListed = (await this.readWindows()).some(
            (window) => window.id === windowIdHint,
          );
          if (!stillListed) return { targetWindowClosed: true };
        } catch {
          // The listing failed too; report nothing rather than guessing.
        }
        return undefined;
      }
    }
    if (actionPoint) {
      const pointWindowId = await this.windowIdAtActionPoint(actionPoint);
      if (pointWindowId !== undefined) {
        if (await this.windowIsDenied(pointWindowId)) return undefined;
        try {
          return await this.observeActionCapture(
            {
              screenshot: await this.backend.captureScreenshot({
                kind: "window",
                windowId: pointWindowId,
                maxDimension: COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION,
              }),
              windowId: pointWindowId,
            },
            threadId,
          );
        } catch {
          // The window vanished between the listing and the capture. It was
          // never named by the caller, so fall through to the focus path
          // rather than reporting a close the caller did not ask about.
        }
      }
    }
    try {
      return await this.observeActionCapture(
        await this.captureFocusedWindow(COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION, {
          agentFocusOnly: true,
        }),
        threadId,
      );
    } catch {
      return undefined;
    }
  }

  /**
   * The observation, with one more question asked before an unchanged frame is
   * reported: did this action open a window the capture could not have shown?
   *
   * The observer photographs exactly one window — the one the action named, or
   * the one under its coordinates — so a click that opens a dialog, a menu, or
   * a new browser window photographs the *old* window, which very often did not
   * change a pixel. The result was `screenshotUnchanged` plus a note telling the
   * agent its action had not landed, at the precise moment the action had landed
   * hardest. Diffing the window list against what existed before the action
   * answers it truthfully: a window that was not there before is the outcome,
   * so photograph that instead.
   *
   * Checked against the pre-action window set before the gateway decides
   * whether to reuse a delivered frame. This is best effort — the action already
   * happened, and a perception failure must never turn its success into an
   * error.
   */
  private async observeActionCapture(
    capture: ComputerCapturedWindow,
    _threadId?: string,
  ): Promise<ComputerActionObservation> {
    const observation = capture;
    const appeared = await this.windowOpenedByAction(capture.windowId);
    if (appeared === undefined) return observation;
    // A denied window the action opened — a password prompt, a security
    // dialog — is never photographed either; the original capture stands.
    if ((await this.deniedMatchForWindow(appeared)) !== undefined) return observation;
    try {
      return {
        screenshot: await this.backend.captureScreenshot({
          kind: "window",
          windowId: appeared.id,
          maxDimension: COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION,
        }),
        windowId: appeared.id,
      };
    } catch {
      return observation;
    }
  }

  /**
   * A capturable window that did not exist when the running action started, or
   * nothing — including when there is no baseline to compare against, because a
   * guess here would photograph a window the action had no hand in.
   *
   * The topmost such window wins: a click that spawns a dialog over its own
   * parent produces the dialog on top, and that is the one the agent needs to
   * see.
   */
  private async windowOpenedByAction(
    excludeWindowId: string | undefined,
  ): Promise<ComputerWindow | undefined> {
    const baseline = this.preActionWindowIds;
    if (baseline === undefined) return undefined;
    let windows: readonly ComputerWindow[];
    try {
      windows = await this.readWindows();
    } catch {
      return undefined;
    }
    const owner = windows.find((window) => window.id === excludeWindowId);
    // A new notification/menu in the person's application is not an outcome
    // of our action. Never replace the target's image with an unrelated app.
    if (!owner) return undefined;
    return windows
      .filter(
        (window) =>
          !baseline.has(window.id) &&
          window.id !== excludeWindowId &&
          (owner.pid !== undefined
            ? window.pid === owner.pid
            : owner.appName !== undefined && window.appName === owner.appName) &&
          window.bounds !== undefined &&
          window.visible &&
          !window.minimized,
      )
      .toSorted(
        (first, second) =>
          (first.stackingIndex ?? Number.MAX_SAFE_INTEGER) -
          (second.stackingIndex ?? Number.MAX_SAFE_INTEGER),
      )[0];
  }

  /**
   * The window an unscoped pointer action at `point` was delivered to, by the
   * same topmost-at-point rule the compositor routes it with — the server's
   * frame-rect approximation of that rule, which the occlusion refusals
   * already rely on. Unresolvable stacking returns nothing rather than a
   * guess; a listing failure does too, because this only feeds perception.
   */
  private async windowIdAtActionPoint(point: ComputerPoint): Promise<string | undefined> {
    try {
      return topmostWindowAtPoint(await this.readWindows(), point)?.id;
    } catch {
      return undefined;
    }
  }

  /**
   * The window an untargeted capture should cover: the agent seat's focus
   * target first, then the window the compositor reports active, then the
   * topmost visible one. Windows without bounds cannot be captured — a
   * backend without `windowBounds` has no geometry — so they are skipped
   * rather than attempted.
   * `agentFocusOnly` stops after the first step: action observation must not
   * drift to the human's active window when the agent's focus is nowhere.
   */
  private async focusedCapturableWindow(
    agentFocusOnly = false,
  ): Promise<ComputerWindow | undefined> {
    const candidates = (await this.readWindows()).filter(
      (window) => window.bounds !== undefined && window.visible && !window.minimized,
    );
    const agentFocused = candidates.find((window) => window.focused);
    if (agentFocused !== undefined || agentFocusOnly) return agentFocused;
    return (
      candidates.find((window) => window.active === true) ??
      candidates.toSorted(
        (first, second) =>
          (first.stackingIndex ?? Number.MAX_SAFE_INTEGER) -
          (second.stackingIndex ?? Number.MAX_SAFE_INTEGER),
      )[0]
    );
  }

  async getScreenSize(): Promise<ComputerGetScreenSizeResult> {
    this.engageBackend();
    const [availability, screenSize] = await Promise.all([
      this.backend.availability(),
      this.backend.getScreenSize(),
    ]);
    return { computerId: this.computerId, screenSize, availability };
  }

  /**
   * A verified background backend reserves the launched app; other backends
   * keep the desktop lease because their launch may use shared input state.
   *
   * A background launch must still create a usable window. Hiding an app is
   * a separate, explicit option; it is not the default for background work.
   * Readiness is checked separately from LaunchServices accepting the request.
   */
  async launchApp(
    threadId: string | undefined,
    app: string,
    args: readonly string[] = [],
    waitForWindowMs = 0,
    options?: { readonly hidden?: boolean },
  ): Promise<ComputerLaunchAppResult> {
    return this.withBackgroundAppControl(threadId, app, async () => {
      markComputerCall("computer_launch_app");
      assertDesktopOperationActive();
      this.assertDrivenAppAllowed(app);
      this.spaceBroker.assertNativeLaunchAllowed(agentThreadId(threadId));
      const result = await timedComputerLeg("dispatch", () =>
        this.backend.launchApp(app, args, options),
      );
      const owner = agentThreadId(threadId);
      if (
        result.focusChangedDuringLaunch === true &&
        owner &&
        desktopDeliveryMode() !== "foreground"
      ) {
        const state = this.threadRuntime(owner);
        state.inputPause = {
          ...(result.window ? { windowId: result.window.id } : {}),
          ...(result.pid !== undefined ? { pid: result.pid } : {}),
          message:
            "The app changed desktop focus while launching. The launch already happened; do not replay it. Observe the app's exact window before continuing background input.",
        };
        this.publishCached(owner);
      }
      this.emitAction(threadId, "computer_launch_app");
      if (!result.window && result.windowStatus !== "no_usable_window" && waitForWindowMs > 0) {
        const readiness = await waitForWindow(
          () => this.readWindows(),
          app,
          waitForWindowMs,
          desktopOperationSignal(),
          {
            ...(result.pid !== undefined ? { pid: result.pid } : {}),
            ...(this.backend.checkInputReady
              ? { checkInputReady: (windowId: string) => this.backend.checkInputReady!(windowId) }
              : {}),
          },
        ).catch(() => {
          assertDesktopOperationActive();
          return {
            window: null,
            windowStatus: "no_usable_window" as const,
            windowReason: "input_unavailable" as const,
          };
        });
        return { ...result, ...readiness };
      }
      return {
        ...result,
        windowStatus: result.windowStatus ?? (result.window ? "ready" : "not_checked"),
      };
    });
  }

  async listApps(): Promise<ComputerListAppsResult> {
    this.engageBackend();
    const listApps = this.backend.listApps?.bind(this.backend);
    if (!listApps) throw new ComputerBackendError("This backend cannot enumerate applications.");
    const [availability, apps] = await Promise.all([this.backend.availability(), listApps()]);
    return { computerId: this.computerId, apps, availability };
  }

  /**
   * The admission half every window-grain mutation shares once the exact
   * window row is in hand: owning-app consent backstop, then the denylist
   * input check — in that order, before any dispatch.
   * `target.appName ?? windowId` is the consent key a nameless window falls
   * back to, matching the pre-queue resolution the tool layer makes.
   */
  private async admitWindowTarget(
    threadId: string | undefined,
    target: ComputerWindow,
  ): Promise<void> {
    this.assertDrivenAppAllowed(target.appName ?? target.id);
    await this.assertWindowInputAllowedWindow(threadId, target);
  }

  /**
   * The exact-window resolution the window-grain mutations run identically:
   * a fresh listing proves the id still names a live window, then the shared
   * admission gate runs. The raise/focus excursion resolves the same row but
   * keeps its own listing — it diffs the frontmost entry for the restore.
   */
  private async resolveWindowTarget(
    threadId: string | undefined,
    windowId: string,
  ): Promise<ComputerWindow> {
    const windows = await timedComputerLeg("resolve", () => this.readWindows());
    const target = windows.find((candidate) => candidate.id === windowId);
    if (!target) throw windowNotFoundError(windowId);
    await this.admitWindowTarget(threadId, target);
    return target;
  }

  async setWindowFrame(
    threadId: string | undefined,
    windowId: string,
    frame: ComputerRect,
  ): Promise<ComputerActionResult> {
    return this.withBackgroundProcessControl(threadId, windowId, async () => {
      const setter = this.backend.setWindowFrame?.bind(this.backend);
      if (!setter) throw new ComputerBackendError("This backend cannot move or resize windows.");
      const target = await this.resolveWindowTarget(threadId, windowId);
      if (target.pid !== undefined) await this.assertSpaceAppMutationAllowed(threadId, target.pid);
      const result = await timedComputerLeg("dispatch", () => setter(windowId, frame));
      return this.actionResult(threadId, "computer_set_window_frame", undefined, result, windowId);
    });
  }

  /**
   * Invoke a menu-bar path on the app the target names: one exact window
   * (validated against a fresh listing, with the owning app's consent and
   * denylist gates exactly as before), or the application-level menu bar of
   * a running app/pid, which also works for an app without windows. Native
   * menu execution may activate the app, so both routes require the same
   * visible-use authorization and restoration as other foreground actions.
   * An app name resolves to a
   * live pid through the same process list the visibility tool consults; an
   * unresolvable name refuses with the list_apps pointer. A named pid rides
   * through, and the driver's own refusal names an unknown process.
   */
  async invokeMenu(
    threadId: string | undefined,
    target: ComputerMenuTarget,
    path: readonly string[],
    authorization?: ComputerForegroundAuthorization,
  ): Promise<ComputerActionResult> {
    return this.withForegroundRestore(
      threadId,
      () =>
        withDesktopDeliveryMode("foreground", async () => {
          const invoke = this.backend.invokeMenu?.bind(this.backend);
          if (!invoke) throw new ComputerBackendError("This backend cannot invoke menu items.");
          if ("windowId" in target) {
            const window = await this.resolveWindowTarget(threadId, target.windowId);
            if (window.pid !== undefined)
              await this.assertSpaceAppMutationAllowed(threadId, window.pid);
            const result = await timedComputerLeg("dispatch", () =>
              invoke({ windowId: target.windowId }, path),
            );
            return this.actionResult(
              threadId,
              "computer_invoke_menu",
              undefined,
              result,
              target.windowId,
            );
          }
          // Application-level: the denylist keys on the app this target
          // provably names, the same split set_app_visibility makes.
          const resolved = await timedComputerLeg("resolve", () =>
            this.resolveMenuAppTarget(target),
          );
          const consentKey = "app" in target ? target.app : (resolved.name ?? `pid ${target.pid}`);
          this.assertDrivenAppAllowed(consentKey);
          if (agentThreadId(threadId) !== undefined) {
            const denied = await this.deniedMatchForPid(resolved.pid, resolved.name);
            if (denied) throw new ComputerDenylistError(denied.app, denied.matched);
          }
          await this.assertSpaceAppMutationAllowed(threadId, resolved.pid);
          const result = await timedComputerLeg("dispatch", () =>
            invoke({ pid: resolved.pid }, path),
          );
          return this.actionResult(threadId, "computer_invoke_menu", undefined, result);
        }),
      authorization,
    );
  }

  /**
   * The live process an application-level menu target names. An `app` is
   * resolved through the same running-app inventory the consent path
   * consults — exact name or bundle id, case-insensitive — and refuses when
   * nothing matches; a `pid` is passed through with whatever name the
   * inventory has for it, because an unknown pid is the driver's refusal to
   * make, matching set_app_visibility.
   */
  private async resolveMenuAppTarget(
    target: Exclude<ComputerMenuTarget, { readonly windowId: string }>,
  ): Promise<{ readonly pid: number; readonly name?: string }> {
    const listApps = this.backend.listApps?.bind(this.backend);
    if (listApps === undefined) {
      throw new ComputerBackendError(
        "This backend cannot enumerate applications, so a menu target has to name an exact window.",
      );
    }
    if ("pid" in target) {
      // The tool layer already refuses a malformed pid; this is the direct
      // caller's backstop, matching setAppVisibility's own validation gap.
      if (!Number.isSafeInteger(target.pid) || target.pid <= 0) {
        throw new ComputerTargetError({
          code: "computer_target_invalid",
          message: `"pid" must be a positive integer; got ${JSON.stringify(target.pid)}.`,
        });
      }
      const owner = (await listApps()).find((app) => app.pid === target.pid && app.running);
      return { pid: target.pid, ...(owner !== undefined ? { name: owner.name } : {}) };
    }
    const spelling = target.app.trim();
    const owner = (await listApps()).find(
      (app) =>
        app.running &&
        (app.name.trim().toLowerCase() === spelling.toLowerCase() ||
          (app.bundleId !== undefined && app.bundleId.toLowerCase() === spelling.toLowerCase())),
    );
    if (owner === undefined) throw menuAppNotFoundError(spelling);
    return { pid: owner.pid, name: owner.name };
  }

  /**
   * Minimize or restore the exact window without activating it — the
   * window-grain explicit visibility control. Same lease, window-existence
   * proof, and owning-app consent as a frame move: nothing here activates or
   * switches Spaces.
   */
  async setWindowMinimized(
    threadId: string | undefined,
    windowId: string,
    minimized: boolean,
  ): Promise<ComputerActionResult> {
    return this.withBackgroundProcessControl(threadId, windowId, async () => {
      const setter = this.backend.setWindowMinimized?.bind(this.backend);
      if (!setter)
        throw new ComputerBackendError("This backend cannot minimize or restore windows.");
      const target = await this.resolveWindowTarget(threadId, windowId);
      if (target.pid !== undefined) await this.assertSpaceAppMutationAllowed(threadId, target.pid);
      const result = await timedComputerLeg("dispatch", () => setter(windowId, minimized));
      return this.actionResult(
        threadId,
        "computer_set_window_minimized",
        undefined,
        result,
        windowId,
      );
    });
  }

  /**
   * Hide or unhide a running app by pid — the app-grain explicit visibility
   * control, for when the user asks to get an app out of the way or bring it
   * back. The pid is the target, so consent keys on what the pid resolves to:
   * the app's name from the process list when it can be resolved, else a
   * stable pid key — the same split the window-level tools make between an app
   * name and the window id fallback.
   */
  async setAppVisibility(
    threadId: string | undefined,
    pid: number,
    hidden: boolean,
  ): Promise<ComputerActionResult & { readonly note?: string }> {
    return this.withDesktopControl(threadId, async () => {
      const setter = this.backend.setAppVisibility?.bind(this.backend);
      if (!setter)
        throw new ComputerBackendError("This backend cannot hide or unhide applications.");
      const named = await timedComputerLeg("resolve", async () => {
        const listApps = this.backend.listApps?.bind(this.backend);
        if (!listApps) return undefined;
        const apps = await listApps().catch(() => undefined);
        return apps?.find((app) => app.pid === pid && app.running)?.name;
      });
      this.assertDrivenAppAllowed(named ?? `pid ${pid}`);
      if (agentThreadId(threadId) !== undefined) {
        const denied = await this.deniedMatchForPid(pid, named);
        if (denied) throw new ComputerDenylistError(denied.app, denied.matched);
      }
      await this.assertSpaceAppMutationAllowed(threadId, pid);
      const result = await timedComputerLeg("dispatch", () => setter(pid, hidden));
      const base = this.actionResult(threadId, "computer_set_app_visibility", undefined, result);
      // An unhide on an app with no windows shows nothing, and a bare
      // "confirmed" would read as "there it is". The last window listing —
      // maintained by every readWindows and by the backend's
      // windows-changed events — is the cheap evidence: when one exists and
      // holds no window for this pid, say so with the ways forward instead
      // of leaving the model to stare at an unchanged screen. No new read is
      // taken here; an absent listing is not evidence, so it earns no note.
      if (hidden || this.lastKnownWindowIds === undefined) return base;
      if ([...this.lastKnownWindows.values()].some((window) => window.pid === pid)) return base;
      return {
        ...base,
        note:
          "This app has no window in the last desktop listing, so the unhide had nothing to show. " +
          "Create a window with the app-level computer_invoke_menu (name the app or pid, e.g. " +
          '["File", "New Window"]), or bind the driver-owned headless browser with ' +
          "computer_browser_prepare and computer_browser_state.",
      };
    });
  }

  /**
   * The gate every window-scoped read passes identically: the exact id must
   * still name a live window, and a denylisted surface refuses before any of
   * its content is read — state, tree, zoom or cursor alike.
   */
  private async assertScopedWindowReadable(windowId: string): Promise<void> {
    const windows = await this.readWindows();
    if (!windows.some((candidate) => candidate.id === windowId))
      throw windowNotFoundError(windowId);
    await this.assertWindowContentAllowed(windowId);
  }

  async verifyState(
    windowId: string,
    expect: readonly Record<string, unknown>[],
  ): Promise<ComputerVerifyStateResult> {
    this.engageBackend();
    const verify = this.backend.verifyState?.bind(this.backend);
    if (!verify) throw new ComputerBackendError("This backend cannot verify window state.");
    await this.assertScopedWindowReadable(windowId);
    return verify(windowId, expect);
  }

  async zoomWindow(windowId: string, region: ComputerRect): Promise<ComputerZoomResult> {
    this.engageBackend();
    const zoom = this.backend.zoomWindow?.bind(this.backend);
    if (!zoom) throw new ComputerBackendError("This backend cannot capture zoomed regions.");
    await this.assertScopedWindowReadable(windowId);
    return zoom(windowId, region);
  }

  async killApp(threadId: string | undefined, windowId: string): Promise<ComputerActionResult> {
    return this.withBackgroundProcessControl(threadId, windowId, async () => {
      const kill = this.backend.killApp?.bind(this.backend);
      if (!kill) throw new ComputerBackendError("This backend cannot terminate applications.");
      // The pid gate runs ahead of admission, as it always has: a window
      // without one reports not-found rather than prompting consent first.
      const windows = await timedComputerLeg("resolve", () => this.readWindows());
      const target = windows.find((candidate) => candidate.id === windowId);
      if (!target?.pid) throw windowNotFoundError(windowId);
      await this.admitWindowTarget(threadId, target);
      await this.assertSpaceAppMutationAllowed(threadId, target.pid);
      const result = await timedComputerLeg("dispatch", () => kill(target.pid!));
      return this.actionResult(threadId, "computer_kill_app", undefined, result, windowId);
    });
  }

  /**
   * The driver's fast desktop inventory — running apps and on-screen
   * windows — read-only end to end. `windowId` scopes the snapshot to the app
   * that owns that exact window, so it is validated against a fresh window
   * read the same way a targeted perception call is.
   */
  async getAccessibilityTree(windowId?: string): Promise<ComputerAccessibilityTreeResult> {
    this.engageBackend();
    const read = this.backend.getAccessibilityTree?.bind(this.backend);
    if (!read) throw new ComputerBackendError("This backend cannot read the desktop inventory.");
    if (windowId !== undefined) await this.assertScopedWindowReadable(windowId);
    const [availability, snapshot] = await Promise.all([
      this.backend.availability(),
      read(windowId),
    ]);
    return {
      computerId: this.computerId,
      ...snapshot,
      ...(windowId !== undefined ? { windowId } : {}),
      availability,
    };
  }

  /**
   * Where the human's pointer sits, in desktop points — a pure read that
   * never takes the control lease or touches the pointer. `windowId`, when
   * given, is a scoping read the same way `getAccessibilityTree`'s is: the
   * window must still exist, and the answer reports whether the point lies
   * inside its bounds.
   */
  async getCursorPosition(windowId?: string): Promise<ComputerCursorPosition> {
    this.engageBackend();
    const read = this.backend.getCursorPosition?.bind(this.backend);
    if (!read) throw new ComputerBackendError("This backend cannot read the cursor position.");
    if (windowId !== undefined) await this.assertScopedWindowReadable(windowId);
    const [availability, point] = await Promise.all([this.backend.availability(), read(windowId)]);
    return { computerId: this.computerId, ...point, availability };
  }

  async getThreadState(threadId: string): Promise<ThreadComputerState> {
    // Registering a record is what seeds the panel — but a suspended thread
    // is mid-removal, and recreating its record would resurrect it.
    const state = this.suspendedThreads.has(threadId)
      ? (this.threads.get(threadId) ?? this.newThreadRuntime())
      : this.threadRuntime(threadId);
    await this.refreshPhysicalState();
    return (await this.publish(threadId)) ?? this.threadSnapshot(threadId, state);
  }

  /** A human clicks the live pane in desktop coordinates. Resolve its current
   * topmost window once, then keep that identity through capture and injection. */
  async withUserPointTarget<A>(
    point: ComputerPoint,
    action: (target: ComputerTarget) => Promise<A>,
  ): Promise<A> {
    assertDesktopOperationAdmission();
    return this.operations.run(async () => {
      if (this.agentDialect !== "macos") return action(point);
      this.engageBackend();
      const window = topmostWindowAtPoint(await this.readWindows(), point);
      if (!window)
        throw new ComputerTargetError({
          code: "computer_target_not_found",
          message: "No exact window is available at this point.",
        });
      const image = await this.backend.captureScreenshot({
        kind: "window",
        windowId: window.id,
      });
      return action({
        ...point,
        windowId: window.id,
        observedWindowBounds: image.region,
      } as ComputerTarget);
    });
  }

  async click(
    threadId: string | undefined,
    target: ComputerTarget,
    modifiers?: readonly ComputerInputModifier[],
    gesture?: ComputerClickGesture,
  ): Promise<ComputerActionResult> {
    return await this.pointerClick(threadId, target, modifiers, gesture);
  }

  async doubleClick(
    threadId: string | undefined,
    target: ComputerTarget,
    modifiers?: readonly ComputerInputModifier[],
  ): Promise<ComputerActionResult> {
    return await this.click(threadId, target, modifiers, { count: 2 });
  }

  async tripleClick(
    threadId: string | undefined,
    target: ComputerTarget,
    modifiers?: readonly ComputerInputModifier[],
  ): Promise<ComputerActionResult> {
    return await this.click(threadId, target, modifiers, { count: 3 });
  }

  async rightClick(
    threadId: string | undefined,
    target: ComputerTarget,
    modifiers?: readonly ComputerInputModifier[],
  ): Promise<ComputerActionResult> {
    return await this.click(threadId, target, modifiers, { button: "right" });
  }

  /**
   * Every click gesture runs one path — they differ only in which backend
   * method carries them, and the gesture picks that up front. The audit and
   * timing label is `computer_click` for all of them: the tool surface folds
   * the old per-gesture actions into it.
   */
  private async pointerClick(
    threadId: string | undefined,
    target: ComputerTarget,
    modifiers: readonly ComputerInputModifier[] | undefined,
    gesture: ComputerClickGesture | undefined,
  ): Promise<ComputerActionResult> {
    return this.withBackgroundProcessControl(threadId, target.windowId, async () => {
      markComputerCall("computer_click");
      const inject = this.clickInjector(gesture);
      const resolved = await timedComputerLeg("resolve", () =>
        this.resolvePointTarget(target, threadId),
      );
      await timedComputerLeg("resolve", () => this.prepareResolvedTarget(resolved, threadId));
      const semantic = resolved.semantic;
      if (
        (gesture?.button ?? "left") === "left" &&
        (gesture?.count ?? 1) === 1 &&
        !modifiers?.length &&
        semantic !== undefined &&
        // The token fast path runs whenever the backend advertises AXPress for
        // the target. (Formerly also gated on menu-bar/menu-bar-extra; that
        // menu-bar-only gate is dropped — a live token is the gate.)
        this.backend.supportsAction?.(semantic, "AXPress")
      ) {
        assertDesktopOperationActive();
        // Select one actuator before dispatch. An uncertain AX press must never
        // fall through to a coordinate click (toggles could run twice).
        const nativeAction = this.backend.agentDialect === "macos" ? "AXPress" : "press";
        const result = await timedComputerLeg("dispatch", () =>
          this.backend.performAction(semantic, nativeAction),
        );
        return this.actionResult(
          threadId,
          "computer_click",
          resolved.point,
          result,
          resolved.windowId,
        );
      }
      this.assertTargetCanUseCoordinates(target);
      const result = await this.injectScoped("computer_click", resolved, () =>
        inject(resolved.point, resolved.windowId, modifiers),
      );
      return this.actionResult(
        threadId,
        "computer_click",
        resolved.point,
        result,
        resolved.windowId,
      );
    });
  }

  /**
   * The backend call behind one click gesture, refused up front when the
   * driver exposes no such path: a left click repeats up to three times and
   * a right click exists only once — every other combination is a refusal
   * before any target resolution, never an approximation. The triple click
   * is also optional on the backend itself, and its absence is a real
   * refusal rather than a degradation: three separate clicks are three
   * carets, not a line selection, so approximating it would answer a request
   * the application never received.
   */
  private clickInjector(
    gesture: ComputerClickGesture | undefined,
  ): (
    point: ComputerPoint,
    windowId: string | undefined,
    modifiers: readonly ComputerInputModifier[] | undefined,
  ) => Promise<ComputerBackendActionResult | void> {
    const button = gesture?.button ?? "left";
    const count = gesture?.count ?? 1;
    if (button === "left") {
      if (count === 1) {
        return (point, windowId, modifiers) => this.backend.click(point, windowId, modifiers);
      }
      if (count === 2) {
        return (point, windowId, modifiers) => this.backend.doubleClick(point, windowId, modifiers);
      }
      const tripleClick = this.backend.tripleClick?.bind(this.backend);
      if (!tripleClick) throw tripleClickUnsupportedError();
      return (point, windowId, modifiers) => tripleClick(point, windowId, modifiers);
    }
    if (button === "right" && count === 1) {
      return (point, windowId, modifiers) => this.backend.rightClick(point, windowId, modifiers);
    }
    throw clickGestureUnsupportedError(button, count);
  }

  /**
   * Bring the target into view and aim the agent's keyboard at it.
   *
   * Never-raise default: without the task's explicit visible-use
   * authorization this refuses before any raise is dispatched. See
   * {@link assertForegroundAllowed}.
   */
  async activateWindow(
    threadId: string | undefined,
    windowId: string,
    authorization?: ComputerForegroundAuthorization,
  ): Promise<ComputerActionResult> {
    return this.withDesktopControl(
      threadId,
      async () => {
        markComputerCall("computer_activate_window");
        const raise = this.backend.raiseWindow?.bind(this.backend);
        if (!raise || !this.backendCapabilities.raise) {
          throw activationUnsupportedError();
        }
        const target = await this.resolveWindowTarget(threadId, windowId);
        if (target.pid !== undefined)
          await this.assertSpaceAppMutationAllowed(threadId, target.pid);
        await timedComputerLeg("dispatch", async () => {
          await raise(windowId);
          // Aiming after the raise, never before: a raise that refuses must not leave
          // the keyboard pointed at a window this call just declined to move.
          assertDesktopOperationActive();
          await this.backend.focusWindow?.(windowId);
        });
        return this.actionResult(
          threadId,
          "computer_activate_window",
          undefined,
          undefined,
          windowId,
        );
      },
      () => this.assertForegroundAllowed(threadId, authorization),
    );
  }

  /**
   * Bring `windowId` forward for one approved use, then put the desktop back
   * the way it was. Called only from the computer_activate_window tool entry,
   * whose approval covers the whole excursion — including the restore, which
   * never prompts a second time.
   *
   * The steps: record the frontmost window id from the existing topmost-first
   * window listing (no new native surface; a listing of only hidden windows
   * records null with a note) → raise and aim via the existing activate path →
   * run the approved input, if one was given → restore the recorded window via
   * the same raise path → re-observe the target with a fresh listing.
   *
   * A restore that fails is still a successful activation, never a silent one:
   * the result carries a note naming the window that was not put back, and the
   * computer.action event carries the same window plus the restore status.
   */
  async foregroundWithRestore(
    threadId: string | undefined,
    windowId: string,
    input?: () => Promise<unknown>,
    authorization?: ComputerForegroundAuthorization,
  ): Promise<ComputerActionResult & { readonly note?: string }> {
    currentComputerCall()?.timing?.count("foreground_excursion");
    return this.withDesktopControl(
      threadId,
      async () => {
        markComputerCall("computer_activate_window");
        const raise = this.backend.raiseWindow?.bind(this.backend);
        if (!raise || !this.backendCapabilities.raise) {
          throw activationUnsupportedError();
        }
        const windows = await timedComputerLeg("resolve", () => this.readWindows());
        const target = windows.find((candidate) => candidate.id === windowId);
        if (!target) {
          throw windowNotFoundError(windowId);
        }
        const previousId =
          windows.find((candidate) => candidate.visible && !candidate.minimized)?.id ?? null;
        this.assertDrivenAppAllowed(target.appName ?? windowId);
        await this.assertWindowInputAllowedWindow(threadId, target);
        if (target.pid !== undefined)
          await this.assertSpaceAppMutationAllowed(threadId, target.pid);
        // The masked-activation shield arms after admission and before the
        // raise: an opt-in that cannot shield refuses here rather than
        // degrading to an unmasked excursion.
        const shieldId = await this.engageActivationShield(threadId, target);
        try {
          await timedComputerLeg("dispatch", async () => {
            await raise(windowId);
            // Aiming after the raise, never before: a raise that refuses must not leave
            // the keyboard pointed at a window this call just declined to move.
            assertDesktopOperationActive();
            await this.backend.focusWindow?.(windowId);
          });
          if (input) {
            try {
              assertDesktopOperationActive();
              await input();
            } catch (error) {
              // Input that failed after the raise must not leave the desktop
              // rearranged: restore best-effort, then report the input failure.
              if (previousId !== null && previousId !== windowId) {
                await raise(previousId).catch(() => undefined);
                await this.backend.focusWindow?.(previousId)?.catch(() => undefined);
              }
              throw error;
            }
          }
          let restore: ForegroundRestoreInfo;
          let note: string | undefined;
          if (previousId === null) {
            restore = {
              restoredWindowId: null,
              restoreStatus: "frontmost-unobservable",
            };
            note = "No frontmost window was observable before activation, so nothing was restored.";
          } else if (previousId === windowId) {
            restore = {
              restoredWindowId: null,
              restoreStatus: "already-frontmost",
            };
          } else {
            try {
              assertDesktopOperationActive();
              await raise(previousId);
              await this.backend.focusWindow?.(previousId);
              restore = {
                restoredWindowId: previousId,
                restoreStatus: "restored",
              };
            } catch {
              restore = {
                restoredWindowId: previousId,
                restoreStatus: "restore-missed",
              };
              note =
                `Activated window ${JSON.stringify(windowId)} but could not restore the previously ` +
                `frontmost window ${JSON.stringify(previousId)} to the foreground; the desktop was ` +
                `left with ${JSON.stringify(windowId)} raised.`;
            }
          }
          // A fresh listing so the next read sees the desktop as it was left. Best
          // effort: the activation already succeeded, and a stale listing must not
          // fail it.
          try {
            await this.readWindows();
          } catch {
            // Keep the successful result.
          }
          const merged = computerBackendActionResult(this.computerId, "computer_activate_window", {
            windowId,
          });
          this.emitForegroundRestoreAction(threadId, merged, restore, note, shieldId !== undefined);
          return note !== undefined ? { ...merged, note } : merged;
        } finally {
          // The shield is the last piece of the excursion to come down: the
          // restore has already landed, so dropping the mask reveals the
          // desktop the way it was left rather than mid-raise.
          if (shieldId !== undefined) await this.releaseActivationShield(shieldId);
        }
      },
      () => this.assertForegroundAllowed(threadId, authorization),
    );
  }

  /**
   * Run `action` (already approved for foreground delivery) and put the
   * desktop back the way it was. Every foreground call is a focus excursion
   * from the human's point of view — not just computer_activate_window: a
   * foreground type or click that leaves the agent's target raised has stolen
   * the user's window for the rest of the session. The restore is covered by
   * the same approval as the call it wraps and never prompts a second time.
   *
   * The frontmost window is recorded from the existing topmost-first listing,
   * and the raise is skipped when nothing changed (a foreground call whose
   * target was already frontmost costs two listings and nothing else).
   * Best-effort like the activate path: a missed restore never fails the call
   * that already succeeded — it warns, and the caller's own action event
   * still reports the foreground delivery.
   */
  async withForegroundRestore<T>(
    threadId: string | undefined,
    action: () => Promise<T>,
    authorization?: ComputerForegroundAuthorization,
  ): Promise<T> {
    currentComputerCall()?.timing?.count("foreground_excursion");
    return this.withDesktopControl(
      threadId,
      async () => {
        const before = await timedComputerLeg("resolve", () => this.readWindows());
        const previousId =
          before.find((candidate) => candidate.visible && !candidate.minimized)?.id ?? null;
        let outcome:
          | { readonly ok: true; readonly value: T }
          | { readonly ok: false; readonly error: unknown };
        try {
          outcome = { ok: true, value: await action() };
        } catch (error) {
          outcome = { ok: false, error };
        }
        if (previousId !== null) {
          const raise = this.backend.raiseWindow?.bind(this.backend);
          if (raise && this.backendCapabilities.raise) {
            let frontmost: string | null | undefined;
            try {
              const after = await timedComputerLeg("resolve", () => this.readWindows());
              frontmost =
                after.find((candidate) => candidate.visible && !candidate.minimized)?.id ?? null;
            } catch {
              frontmost = undefined;
            }
            if (frontmost === undefined) {
              // The post-call read failed, so whether the excursion left the
              // target raised is unknown — the restore cannot run blind, and
              // a possibly stolen frontmost must not pass without a trace.
              console.warn("[computer] foreground call left focus unverified", {
                previousWindowId: previousId,
              });
            } else if (frontmost !== null && frontmost !== previousId) {
              try {
                assertDesktopOperationActive();
                await raise(previousId);
                await this.backend.focusWindow?.(previousId);
              } catch (error) {
                console.warn("[computer] foreground call left focus unrestored", {
                  restoredWindowId: previousId,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            }
          }
        }
        if (!outcome.ok) throw outcome.error;
        return outcome.value;
      },
      () => {
        this.assertForegroundAllowed(threadId, authorization);
        this.spaceBroker.assertForegroundAllowed(agentThreadId(threadId));
      },
    );
  }

  /**
   * The computer.action event for a foreground excursion: emitAction's payload
   * plus which window was put back and whether that succeeded. Kept separate
   * from emitAction so the existing action path is untouched; the two new
   * fields ride as extras (with the note in the schema's message) because the
   * contract's event shape does not name them yet. `masked` records whether
   * the excursion ran under the activation shield — the disclosure trail for
   * a delivery the operator could not watch directly.
   */
  private emitForegroundRestoreAction(
    threadId: string | undefined,
    result: ComputerActionResult,
    restore: ForegroundRestoreInfo,
    note: string | undefined,
    masked: boolean,
  ): void {
    const attributed = agentThreadId(threadId);
    if (attributed) this.surfacePaneForAgent(attributed);
    this.emit({
      type: "computer.action",
      ...(result.windowId ? { windowId: result.windowId } : {}),
      ...(result.delivery ? { delivery: result.delivery } : {}),
      action: "computer_activate_window",
      ok: true,
      ...(attributed ? { threadId: ThreadId.makeUnsafe(attributed) } : {}),
      ...(restore.restoredWindowId !== null ? { restoredWindowId: restore.restoredWindowId } : {}),
      restoreStatus: restore.restoreStatus,
      ...(masked ? { masked: true } : {}),
      ...(note !== undefined
        ? {
            message: clampComputerMessage(note, "The foreground window could not be restored."),
          }
        : {}),
    } as ComputerEvent);
  }

  /**
   * The masked-activation decision for one resolved target. Engages the
   * Synara-owned shield only when the canary flag is armed, the backend
   * speaks the macOS dialect, and the target's owning app is on the
   * `SYNARA_CUA_MASKED_APPS` opt-in list — all three, always. Anything less
   * returns `undefined` and the call takes the ordinary visible path.
   *
   * When the opt-in does name the app, the shield becomes mandatory: a
   * backend that cannot show it (missing surface, refused engage, lost
   * reply) fails the activation rather than degrading to an unmasked raise.
   * The shield id is minted here — not by the backend — so a lost engage
   * reply still leaves this side holding the release handle.
   */
  private async engageActivationShield(
    threadId: string | undefined,
    target: ComputerWindow,
  ): Promise<string | undefined> {
    if (!cuaMaskedActivationEnabled()) return undefined;
    if (this.agentDialect !== "macos") return undefined;
    const optIn = cuaMaskedActivationOptIn();
    if (optIn.size === 0) return undefined;
    const owner =
      target.pid !== undefined
        ? (await this.runningAppsForDenylist()).find((candidate) => candidate.pid === target.pid)
        : undefined;
    if (!maskedActivationOptedIn(optIn, owner?.bundleId)) return undefined;
    const engage = this.backend.engageShield?.bind(this.backend);
    if (!engage || !target.bounds) {
      throw new ComputerBackendError(
        "Masked activation is armed for this app but the activation shield is unavailable; the window was not raised.",
      );
    }
    const appName = target.title?.trim() || target.appName || "this window";
    const label = `Synara is activating ${appName}`;
    const shieldId = `shield-${randomUUID().slice(0, 8)}`;
    try {
      return await timedComputerLeg("shield", () =>
        engage({ shieldId, windowId: target.id, frame: target.bounds!, label }),
      );
    } catch (error) {
      // The reply may be the only thing lost — the shield could still be up.
      // The minted id makes that reachable: release it before refusing.
      await this.releaseActivationShield(shieldId);
      if (error instanceof ComputerBackendError) throw error;
      throw new ComputerBackendError(
        `The activation shield could not be shown, so the window was not raised: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Drop one shield, best-effort and cancellation-immune: releasing is how
   * the excursion ends, so it must still land while the operation that
   * engaged it is being torn down.
   */
  private async releaseActivationShield(shieldId: string): Promise<void> {
    const release = this.backend.releaseShield?.bind(this.backend);
    if (!release) return;
    try {
      await withoutDesktopCancellation(() => release(shieldId));
    } catch (error) {
      console.warn("[computer] activation shield release failed", {
        shieldId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async moveCursor(
    threadId: string | undefined,
    target: ComputerTarget,
  ): Promise<ComputerActionResult> {
    this.assertTargetCanUseCoordinates(target);
    return this.withBackgroundProcessControl(threadId, target.windowId, async () => {
      const resolved = await timedComputerLeg("resolve", () =>
        this.resolvePointTarget(target, threadId),
      );
      await timedComputerLeg("resolve", () => this.revealTarget(resolved));
      const result = await this.injectScoped("computer_move_cursor", resolved, () =>
        this.backend.moveCursor(resolved.point, resolved.windowId),
      );
      return this.actionResult(
        threadId,
        "computer_move_cursor",
        resolved.point,
        result,
        resolved.windowId,
      );
    });
  }

  async drag(
    threadId: string | undefined,
    from: ComputerTarget,
    to: ComputerTarget,
    durationMs = 250,
  ): Promise<ComputerActionResult> {
    this.assertTargetCanUseCoordinates(from);
    this.assertTargetCanUseCoordinates(to);
    return this.withDesktopControl(threadId, async () => {
      const [resolvedFrom, resolvedTo] = await timedComputerLeg("resolve", () =>
        Promise.all([
          this.resolvePointTarget(from, threadId),
          this.resolvePointTarget(to, threadId),
        ]),
      );
      // The drag is grabbed by the window it starts in, so that window is the one
      // raised and focused; the destination only scopes it when the origin names
      // no window at all.
      const grabbed = resolvedFrom.windowId ? resolvedFrom : resolvedTo;
      await timedComputerLeg("resolve", () => this.prepareResolvedTarget(grabbed, threadId));
      const result = await this.injectScoped("computer_drag", grabbed, () =>
        this.backend.drag(resolvedFrom.point, resolvedTo.point, durationMs, resolvedFrom.windowId),
      );
      return this.actionResult(
        threadId,
        "computer_drag",
        resolvedTo.point,
        result,
        resolvedTo.windowId ?? resolvedFrom.windowId,
      );
    });
  }

  /**
   * The raw gesture: the deltas given are the deltas injected.
   *
   * This is the pane's path, carrying a human's own wheel events. Their gesture
   * must never be re-geared — they are watching the result and closing the loop
   * themselves, and a correction applied under their hand would fight them.
   * Agent scrolls go through `scrollCalibrated` instead.
   */
  async scroll(
    threadId: string | undefined,
    target: ComputerTarget | null,
    deltaX: number,
    deltaY: number,
  ): Promise<ComputerActionResult> {
    return this.withBackgroundProcessControl(threadId, target?.windowId, async () => {
      const resolved = await timedComputerLeg("resolve", () =>
        this.prepareScrollTarget(target, threadId),
      );
      const result = await this.injectScroll(resolved, deltaX, deltaY, undefined);
      return this.actionResult(
        threadId,
        "computer_scroll",
        resolved?.point,
        result,
        resolved?.windowId,
      );
    });
  }

  /**
   * Scroll, then check what the window did with it — the agent's path.
   *
   * A scroll request is in logical pixels, but no Wayland client is obliged to
   * treat it that way: Qt honors the pixel deltas exactly while GTK-hosted
   * browsers convert them to their own scroll units and travel several times as
   * far. Nothing reports that conversion, so the distance is measured from
   * before/after captures of the affected window, returned to the caller as
   * `scroll.traveledY`, and remembered per window so the next request to it is
   * pre-divided by what was learned.
   *
   * Measurement is best-effort throughout: a capture that fails, a window that
   * cannot be identified, or a correlation that will not commit leaves the
   * scroll delivered and simply unmeasured. The after-capture doubles as the
   * caller's observation, so the closed loop costs no extra screenshot.
   *
   * A large request into a window nobody has measured is split: a small probe
   * goes first, its travel is measured and learned, and the remainder — the
   * request minus what the probe already covered — is delivered pre-divided by
   * the fresh gearing. Without the split, the first scroll into a 7x browser
   * travels so far that the before and after captures share no content, the
   * correlation refuses, and nothing is ever learned — the run that exposed
   * this scrolled to the page bottom, clicked coordinates from a layout that
   * no longer existed, and typed into nothing (2026-08-22, run 23556dc6). The
   * probe is sized so that even a heavily geared client keeps its travel
   * inside the measurable band.
   */
  async scrollCalibrated(
    threadId: string | undefined,
    target: ComputerTarget | null,
    deltaX: number,
    deltaY: number,
    options: {
      readonly observe: boolean;
      /** Held down for every injected leg of this scroll, released after each. */
      readonly modifiers?: readonly ComputerInputModifier[];
    },
  ): Promise<{
    readonly result: ComputerActionResult;
    readonly observation?: ComputerActionObservation;
  }> {
    return this.withBackgroundProcessControl(threadId, target?.windowId, async () => {
      // An untargeted scroll routes to whatever sits under the agent's cursor
      // once the pinned focus is cleared — but preparing the target clears that
      // focus, and it was the only fallback naming the observed window. Read the
      // candidates that will not survive the clear first: the cursor position
      // this thread last drove to, and the focus about to be dropped.
      const attributed = agentThreadId(threadId);
      const cursorPoint =
        target !== null ? undefined : attributed ? this.threads.get(attributed)?.cursor : undefined;
      const preClearFocusId = target !== null ? undefined : await this.agentFocusWindowId();
      const resolved = await timedComputerLeg("resolve", () =>
        this.prepareScrollTarget(target, threadId),
      );
      // The window the gesture lands in, by the ladder `captureActionScreenshot`
      // already climbs: the one targeting named, else the one the compositor
      // routes an unscoped pointer action to, else the agent's own focus target.
      // A scroll that lands somewhere else measures no travel and so teaches this
      // window nothing, which is the right outcome for a guess.
      const observedWindowId =
        resolved?.windowId ??
        (resolved?.point ? await this.windowIdAtActionPoint(resolved.point) : undefined) ??
        (cursorPoint ? await this.windowIdAtActionPoint(cursorPoint) : undefined) ??
        preClearFocusId ??
        (await this.agentFocusWindowId());
      const before = !options.observe
        ? undefined
        : await this.captureForMeasurement(observedWindowId);

      // Gearing keys are route-scoped: an AX scroll-bar press and a wheel
      // gesture move the same window different distances for one request, so
      // the two never share a learned ratio. The app key is the durable
      // fallback — a window nobody has measured inherits what its app already
      // taught an earlier window.
      const observedWindow =
        observedWindowId === undefined
          ? undefined
          : (await this.readWindows()).find((window) => window.id === observedWindowId);
      const appKey =
        observedWindow?.appName ??
        (observedWindow?.pid !== undefined ? `pid:${observedWindow.pid}` : undefined);
      const windowKey = (route: string) =>
        observedWindowId === undefined ? undefined : `${observedWindowId}|${route}`;
      const durableKey = (route: string) =>
        appKey === undefined ? undefined : `${appKey}|${route}`;
      // The AX rung only runs for an unmodified vertical scroll at an element
      // target; every other request is a wheel gesture.
      const plannedRoute = (legDeltaX: number) =>
        resolved?.semantic !== undefined && legDeltaX === 0 && !options.modifiers?.length
          ? "ax"
          : "wheel";
      // The backend reports which rung actually ran; trust it over the plan.
      const legRoute = (leg: ComputerBackendActionResult | void, planned: string) =>
        leg?.deliveryPath?.startsWith("cua-ax") === true
          ? "ax"
          : leg?.deliveryPath !== undefined
            ? "wheel"
            : planned;
      const measured = (route: string) =>
        this.scrollGearing.has(windowKey(route)) ||
        this.scrollGearingFile.get(durableKey(route)) !== undefined;
      const plan = (route: string, requested: number) =>
        this.scrollGearing.plan(
          windowKey(route),
          requested,
          this.scrollGearingFile.get(durableKey(route)),
        );

      let injectedX = 0;
      let injectedY = 0;
      let after: ComputerCapturedWindow | undefined;
      let traveledY: number | undefined;
      let result: ComputerBackendActionResult | void;
      const routes: string[] = [];
      let reportedGearing: number | undefined;

      if (
        before !== undefined &&
        observedWindowId !== undefined &&
        !measured(plannedRoute(0)) &&
        Math.abs(deltaY) > SCROLL_PROBE_TRIGGER_PX
      ) {
        const probe = Math.sign(deltaY) * SCROLL_PROBE_PX;
        const probeResult = await this.injectScroll(resolved, 0, probe, options.modifiers);
        result = probeResult;
        // The backend's own account of what went in — macOS quantizes the leg
        // to whole notches — is what the correlation learned from, not the
        // pre-quantization request.
        const probeInjected = probeResult?.scrollDelta?.deltaY ?? probe;
        injectedY += probeInjected;
        const probeRoute = legRoute(probeResult, plannedRoute(0));
        routes.push(probeRoute);
        const probeLeg = await this.settleAndMeasure(
          observedWindowId,
          before,
          probeInjected,
          windowKey(probeRoute),
          durableKey(probeRoute),
        );
        after = probeLeg.capture;
        // What the probe already delivered comes off the ask. An unmeasured or
        // wrong-way measurement deducts only the probe's own request, which is
        // the strongest claim it can still make.
        const covered =
          probeLeg.traveled !== undefined && Math.sign(probeLeg.traveled) === Math.sign(deltaY)
            ? probeLeg.traveled
            : probeInjected;
        const remainder = Math.abs(covered) >= Math.abs(deltaY) ? 0 : deltaY - covered;
        // One gearing per window drives both axes: a toolkit's unit conversion is
        // a property of how it reads scroll events, not of which axis they carry,
        // and only the vertical travel is measurable from a row correlation.
        const legX = plan(plannedRoute(deltaX), deltaX);
        const legY = plan(plannedRoute(deltaX), remainder);
        if (legX !== 0 || legY !== 0) {
          const remainderResult = await this.injectScroll(resolved, legX, legY, options.modifiers);
          result = remainderResult;
          injectedX += remainderResult?.scrollDelta?.deltaX ?? legX;
          injectedY += remainderResult?.scrollDelta?.deltaY ?? legY;
          const remainderRoute = legRoute(remainderResult, plannedRoute(deltaX));
          routes.push(remainderRoute);
          if (after) {
            const remainderLeg = await this.settleAndMeasure(
              observedWindowId,
              after,
              remainderResult?.scrollDelta?.deltaY ?? legY,
              windowKey(remainderRoute),
              durableKey(remainderRoute),
            );
            after = remainderLeg.capture ?? after;
            traveledY =
              probeLeg.traveled !== undefined && remainderLeg.traveled !== undefined
                ? probeLeg.traveled + remainderLeg.traveled
                : undefined;
          }
        } else {
          traveledY = probeLeg.traveled;
        }
      } else {
        const route = plannedRoute(deltaX);
        injectedX = plan(route, deltaX);
        injectedY = plan(route, deltaY);
        result = await this.injectScroll(resolved, injectedX, injectedY, options.modifiers);
        injectedX = result?.scrollDelta?.deltaX ?? injectedX;
        injectedY = result?.scrollDelta?.deltaY ?? injectedY;
        const actualRoute = legRoute(result, route);
        routes.push(actualRoute);
        if (before) {
          const leg = await this.settleAndMeasure(
            observedWindowId,
            before,
            injectedY,
            windowKey(actualRoute),
            durableKey(actualRoute),
          );
          after = leg.capture;
          traveledY = leg.traveled;
        }
      }
      // Report the effective gearing whenever a window was observed: its own
      // learned ratio, else the app's durable fallback, else pixel-true 1 —
      // the same shape callers always saw, now honest on macOS too.
      const reportRoute = routes[routes.length - 1];
      if (observedWindowId !== undefined && reportRoute !== undefined) {
        const key = windowKey(reportRoute);
        reportedGearing = this.scrollGearing.has(key)
          ? this.scrollGearing.gearing(key)
          : (this.scrollGearingFile.get(durableKey(reportRoute)) ?? 1);
      }

      const base = this.actionResult(
        threadId,
        "computer_scroll",
        resolved?.point,
        result,
        resolved?.windowId,
      );
      return {
        result: {
          ...base,
          scroll: {
            requested: { deltaX, deltaY },
            injected: { deltaX: round2(injectedX), deltaY: round2(injectedY) },
            ...(traveledY === undefined ? {} : { traveledY: round2(traveledY) }),
            ...(reportedGearing === undefined ? {} : { gearing: round2(reportedGearing) }),
            ...(routes.length === 0 ? {} : { routes }),
          },
        },
        ...(after ? { observation: after } : {}),
      };
    });
  }

  private async prepareScrollTarget(
    target: ComputerTarget | null,
    threadId: string | undefined,
  ): Promise<ResolvedPointTarget | null> {
    const resolved = target ? await this.resolveScrollPointTarget(target, threadId) : null;
    await this.prepareResolvedTarget(resolved ?? undefined, threadId);
    return resolved;
  }

  /**
   * Scroll accepts one control-less target the semantic resolver refuses: a
   * bare window id, meaning "scroll this window". It resolves to the window's
   * own point — its node in the accessibility tree when it has one, else the
   * centre of its reported bounds — rather than entering label matching,
   * where a query naming no control matches everything in scope.
   */
  private async resolveScrollPointTarget(
    target: ComputerTarget,
    threadId: string | undefined,
  ): Promise<ResolvedPointTarget> {
    const windowId = target.windowId;
    if (
      windowId === undefined ||
      target.x !== undefined ||
      target.y !== undefined ||
      hasLabelFields(target)
    ) {
      return this.resolvePointTarget(target, threadId);
    }
    await this.assertWindowInputAllowed(threadId, windowId);
    const state = await this.backend.getState({ includeTree: false });
    const match = state.root ? resolveComputerWindowTarget(state.root, windowId) : undefined;
    const windows = match ? undefined : await this.readWindows();
    const window =
      windows?.find((candidate) => candidate.id === windowId) ??
      this.lastKnownWindows.get(windowId);
    if (match) {
      return { point: match.point, windowId };
    }
    if (!window) throw windowNotFoundError(windowId);
    const bounds = window.bounds;
    if (!bounds) {
      throw new ComputerTargetError({
        code: "computer_target_offscreen",
        message:
          `This desktop reports no geometry for window ${JSON.stringify(windowId)}, so a scroll ` +
          "point inside it cannot be chosen. Scroll at x/y coordinates instead.",
      });
    }
    const point = {
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2,
    };
    return { point, windowId };
  }

  private async injectScroll(
    resolved: ResolvedPointTarget | null,
    deltaX: number,
    deltaY: number,
    modifiers: readonly ComputerInputModifier[] | undefined,
  ): Promise<ComputerBackendActionResult | void> {
    return this.injectScoped("computer_scroll", resolved ?? {}, () =>
      this.backend.scroll(
        resolved?.point ?? null,
        deltaX,
        deltaY,
        resolved?.windowId,
        modifiers,
        resolved?.semantic,
      ),
    );
  }

  /**
   * One injected leg's perception: settle, recapture, measure against `from`,
   * and teach the store what the window did with the injection. A capture or
   * correlation that fails leaves the leg unmeasured, never undelivered.
   *
   * `SYNARA_CUA_CONDITIONAL_SETTLE` extends to legs whose route already
   * carries a learned gearing, because a learned ratio is a prediction of how
   * far this injection should move the content. The leg is captured before
   * the wait, and a measurement landing on that prediction is itself the
   * settle evidence — the content provably arrived, so the fixed sleep is
   * waived and counted. Everything else keeps the settle and measures on a
   * settled frame: no capture, a refused correlation, zero travel (the end of
   * a page), a suppressed wrong-way reading, travel off the prediction (still
   * animating, or a gearing that drifted), and every leg on a route with
   * nothing learned — a leg with no predicted distance has no arrival to
   * prove, which is the probe's whole job. An off-prediction early reading is
   * dropped, never learned, and the settled capture still measures against
   * `from`, never against the early frame, whose displacement would only
   * count the animation's tail.
   */
  private async settleAndMeasure(
    windowId: string | undefined,
    from: ComputerCapturedWindow,
    injectedY: number,
    windowKey?: string,
    appKey?: string,
  ): Promise<{
    readonly capture?: ComputerCapturedWindow;
    readonly traveled?: number;
  }> {
    if (this.actionSettleMs > 0 && injectedY !== 0 && cuaConditionalSettleEnabled()) {
      const predictedGearing = this.scrollGearing.has(windowKey)
        ? this.scrollGearing.gearing(windowKey)
        : this.scrollGearingFile.get(appKey);
      if (predictedGearing !== undefined) {
        const expectedY = injectedY * predictedGearing;
        const early = await this.captureForMeasurement(windowId);
        if (early) {
          const traveled = await this.measureLegTravel(
            from.screenshot,
            early.screenshot,
            injectedY,
          );
          if (
            traveled !== undefined &&
            Math.abs(traveled - expectedY) <=
              Math.max(
                SCROLL_SETTLE_ARRIVAL_MIN_PX,
                Math.abs(expectedY) * SCROLL_SETTLE_ARRIVAL_TOLERANCE,
              )
          ) {
            this.learnLegTravel(windowKey ?? windowId, appKey, injectedY, traveled);
            currentComputerCall()?.timing?.count("settle_skipped");
            return { capture: early, traveled };
          }
        }
      }
    }
    if (this.actionSettleMs > 0) {
      await timedComputerLeg("settle", () => this.settleAfterAction(windowId));
    }
    const capture = await this.captureForMeasurement(windowId);
    if (!capture) return {};
    const traveled = await this.measureLegTravel(from.screenshot, capture.screenshot, injectedY);
    this.learnLegTravel(windowKey ?? windowId, appKey, injectedY, traveled);
    return { capture, ...(traveled === undefined ? {} : { traveled }) };
  }

  /**
   * The travel one capture pair supports, in logical pixels, or nothing the
   * caller cannot trust. A travel opposing the injection is the correlator
   * locking onto the wrong feature — repetitive content aliases — not a page
   * that scrolled backwards. The store would refuse the sample anyway;
   * suppressing it here keeps the caller's traveledY from asserting a
   * direction nothing moved in.
   */
  private async measureLegTravel(
    from: ComputerScreenshot,
    to: ComputerScreenshot,
    injectedY: number,
  ): Promise<number | undefined> {
    const measured = await this.measureTravel(from, to);
    return measured !== undefined &&
      measured !== 0 &&
      injectedY !== 0 &&
      Math.sign(measured) !== Math.sign(injectedY)
      ? undefined
      : measured;
  }

  /**
   * Folds one accepted measurement into the gearing stores; the durable app
   * fallback only records samples the hot store took.
   */
  private learnLegTravel(
    key: string | undefined,
    appKey: string | undefined,
    injectedY: number,
    traveled: number | undefined,
  ): void {
    if (traveled === undefined || injectedY === 0) return;
    if (this.scrollGearing.learn(key, injectedY, traveled)) {
      this.scrollGearingFile.learn(appKey, injectedY, traveled);
    }
  }

  /** The agent seat's focus target, when it has one; never the human's. */
  private async agentFocusWindowId(): Promise<string | undefined> {
    try {
      return (await this.focusedCapturableWindow(true))?.id;
    } catch {
      return undefined;
    }
  }

  /**
   * A capture taken to be measured against another one, and then handed to the
   * caller as the action's observation. Measurement does not register a
   * delivered frame: the before-capture is never shown to anyone, so recording
   * it as the last thing the caller saw would suppress an image never sent.
   *
   * With no window to name — no target, no window under the point, no agent
   * focus — it widens to the same workspace capture the observation path would
   * take, which is still comparable to itself even though nothing can be
   * learned from a region that is not one window.
   */
  private async captureForMeasurement(
    windowId: string | undefined,
  ): Promise<ComputerCapturedWindow | undefined> {
    if (!this.backendCapabilities.capture) return undefined;
    this.engageBackend();
    try {
      return await timedComputerLeg("observe", async () => {
        if (windowId === undefined) {
          return await this.captureFocusedWindow(COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION, {
            agentFocusOnly: true,
          });
        }
        return {
          screenshot: await this.backend.captureScreenshot({
            kind: "window",
            windowId,
            maxDimension: COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION,
          }),
          windowId,
        };
      });
    } catch {
      return undefined;
    }
  }

  /**
   * Vertical travel in logical pixels, or nothing when the two captures cannot
   * be compared. Byte equality answers first and for free: pixels that did not
   * change did not move, which is what the end of a page looks like.
   */
  private measurementBytes(screenshot: ComputerScreenshot): Uint8Array {
    let bytes = this.screenshotBytes.get(screenshot);
    if (!bytes) {
      bytes = Buffer.from(screenshot.bytesBase64, "base64");
      this.screenshotBytes.set(screenshot, bytes);
    }
    return bytes;
  }

  private async measureTravel(
    before: ComputerScreenshot,
    after: ComputerScreenshot,
  ): Promise<number | undefined> {
    if (before.bytesBase64 === after.bytesBase64) return 0;
    // Without a scale on both captures there is no conversion from capture
    // pixels to the logical pixels the request was made in, and two different
    // scales are two different pictures of the window.
    const scale = before.scale;
    if (scale === undefined || scale !== after.scale || scale <= 0) return undefined;
    const traveled = await this.measureScrollTravel(
      this.measurementBytes(before),
      this.measurementBytes(after),
    );
    return traveled === undefined ? undefined : traveled / scale;
  }

  async typeText(
    threadId: string | undefined,
    text: string,
    windowId?: string,
  ): Promise<ComputerActionResult> {
    if (this.supportsFocusNeutralSemanticText && windowId) {
      try {
        return await this.typeTextAt(threadId, text, { windowId });
      } catch (error) {
        // Resolution failed before anything was sent. A rich editor is often
        // absent from a truncated tree (Notes behind 240 list rows) or sits
        // beside other fields; the agent then spelled the text out through
        // computer_press_key, one round trip per character, over this very
        // transport. Send the whole string through it once instead: the same
        // exact-window keyboard admission applies, and it lands in the field
        // the app has focused, exactly as those key presses did.
        if (!(error instanceof ComputerTargetError) || !error.unresolvedTextControl) throw error;
      }
      return this.withBackgroundProcessControl(threadId, windowId, async () => {
        const result = await this.runKeyboardDispatch(threadId, windowId, () =>
          this.backend.typeText(text, windowId),
        );
        return this.actionResult(threadId, "computer_type_text", undefined, result, windowId);
      });
    }
    return this.withDesktopControl(threadId, async () => {
      const result = await this.runKeyboardDispatch(threadId, windowId, () =>
        this.backend.typeText(text, windowId),
      );
      return this.actionResult(threadId, "computer_type_text", undefined, result, windowId);
    });
  }

  async typeTextAt(
    threadId: string | undefined,
    text: string,
    target: ComputerTarget,
  ): Promise<ComputerActionResult> {
    if (!this.supportsFocusNeutralSemanticText) {
      throw new ComputerBackendError(
        "This computer backend cannot guarantee focus-neutral semantic text input.",
      );
    }
    if (!target.windowId) {
      throw new ComputerBackendError("Focus-neutral text input requires an exact target window.");
    }
    const windowId = target.windowId;
    return this.withBackgroundWindowControl(threadId, windowId, async () => {
      const resolved = await timedComputerLeg("resolve", () =>
        this.resolveSemanticTarget(target, true),
      );
      assertDesktopOperationActive();
      const result = await timedComputerLeg("dispatch", () =>
        this.backend.typeText(text, windowId, resolved),
      );
      return this.actionResult(threadId, "computer_type_text", resolved.point, result, windowId);
    });
  }

  async pressKey(
    threadId: string | undefined,
    key: string,
    windowId?: string,
    target?: ComputerTarget,
  ): Promise<ComputerActionResult> {
    const exactWindow = this.keyboardTargetWindow(windowId, target);
    return this.withBackgroundProcessControl(threadId, exactWindow, async () => {
      const resolved = target
        ? await this.resolveSemanticTarget(
            { ...target, ...(exactWindow ? { windowId: exactWindow } : {}) },
            true,
          )
        : undefined;
      const result = await this.runKeyboardDispatch(threadId, exactWindow, () =>
        this.backend.pressKey(key, exactWindow, resolved),
      );
      return this.actionResult(
        threadId,
        "computer_press_key",
        resolved?.point,
        result,
        exactWindow,
      );
    });
  }

  async hotkey(
    threadId: string | undefined,
    keys: readonly string[],
    windowId?: string,
    target?: ComputerTarget,
  ): Promise<ComputerActionResult> {
    const exactWindow = this.keyboardTargetWindow(windowId, target);
    return this.withBackgroundProcessControl(threadId, exactWindow, async () => {
      const resolved = target
        ? await this.resolveSemanticTarget(
            { ...target, ...(exactWindow ? { windowId: exactWindow } : {}) },
            true,
          )
        : undefined;
      const result = await this.runKeyboardDispatch(threadId, exactWindow, () =>
        this.backend.hotkey(keys, exactWindow, resolved),
      );
      // The tool surface folds chords into computer_press_key.
      return this.actionResult(
        threadId,
        "computer_press_key",
        resolved?.point,
        result,
        exactWindow,
      );
    });
  }

  private keyboardTargetWindow(
    windowId: string | undefined,
    target: ComputerTarget | undefined,
  ): string | undefined {
    if (windowId !== undefined && target?.windowId !== undefined && target.windowId !== windowId) {
      throw new ComputerTargetError({
        code: "computer_target_invalid",
        message: "The keyboard window and element target name different windows; nothing was sent.",
      });
    }
    return windowId ?? target?.windowId;
  }

  /**
   * The clipboard is the system one the human shares, and it is optional on the
   * backend, so a backend without it refuses the call instead of the tool
   * layer discovering a missing method at dispatch time.
   *
   * Reading it takes the lease even though it mutates nothing: the clipboard is
   * one shared slot that the owning thread is mid-way through using, and a read
   * from a second thread is either racing that write or reading its private
   * payload. Uniformity also keeps the rule the model must learn simple —
   * perception of the screen is free, everything clipboard is not.
   */
  async readClipboard(threadId: string | undefined): Promise<ComputerActionResult> {
    return this.withDesktopControl(threadId, async () => {
      const read = this.backend.readClipboard?.bind(this.backend);
      if (!read) throw clipboardUnsupportedError();
      const value = await timedComputerLeg("dispatch", read);
      // `ComputerActionResult.value` is contract-bounded well below the backend's
      // byte cap, and an oversized read must not slip out through the unvalidated
      // MCP result path.
      if (value.length > COMPUTER_TEXT_MAX_LENGTH) {
        throw new ComputerBackendError(
          `The desktop clipboard holds ${value.length} characters of text, more than the ${COMPUTER_TEXT_MAX_LENGTH} this tool returns.`,
        );
      }
      return this.actionResult(threadId, "computer_read_clipboard", undefined, {
        value,
      });
    });
  }

  async writeClipboard(threadId: string | undefined, text: string): Promise<ComputerActionResult> {
    return this.withDesktopControl(threadId, async () => {
      const write = this.backend.writeClipboard?.bind(this.backend);
      if (!write) throw clipboardUnsupportedError();
      await timedComputerLeg("dispatch", () => write(text));
      // The text is not echoed back on `value`: the caller already has it, and it
      // may be far larger than the contract bound on that field.
      return this.actionResult(threadId, "computer_write_clipboard", undefined, undefined);
    });
  }

  /**
   * Bulk text entry through the shared clipboard: save what the user had,
   * write the payload, send the paste shortcut, then put their contents back.
   * One keystroke pastes what hundreds would type, which is why it exists —
   * but it still goes through the keyboard-target path, so it lands exactly
   * where computer_type_text would and nowhere else.
   *
   * `clipboardRestored` reports whether the previous contents went back. A
   * clipboard holding an image or other non-text content cannot be saved or
   * restored and is replaced; a failed restore is reported rather than
   * silently leaving the pasted text behind.
   */
  async paste(
    threadId: string | undefined,
    text: string,
    windowId?: string,
  ): Promise<ComputerActionResult & { readonly clipboardRestored: boolean }> {
    return this.withDesktopControl(threadId, async () => {
      const read = this.backend.readClipboard?.bind(this.backend);
      const write = this.backend.writeClipboard?.bind(this.backend);
      if (!read || !write) throw clipboardUnsupportedError();
      const previous = await timedComputerLeg("dispatch", () => read().catch(() => undefined));
      await timedComputerLeg("dispatch", () => write(text));
      let restored = false;
      let result: ComputerBackendActionResult | void;
      try {
        result = await this.runKeyboardDispatch(threadId, windowId, () =>
          this.backend.hotkey(
            this.agentDialect === "macos" ? ["meta", "v"] : ["ctrl", "v"],
            windowId,
          ),
        );
      } finally {
        // The restore runs whether or not the shortcut dispatched: the payload
        // is already on the clipboard either way, and leaving it there leaks
        // the agent's text into the next paste the human makes.
        if (previous !== undefined) {
          await timedComputerLeg(
            "settle",
            () =>
              new Promise<void>((resolve) => {
                setTimeout(resolve, COMPUTER_PASTE_RESTORE_MS);
              }),
          );
          restored = await write(previous).then(
            () => true,
            () => false,
          );
        }
      }
      return {
        ...this.actionResult(threadId, "computer_paste", undefined, result, windowId),
        // True only when what the user copied is back in place: a clipboard
        // with no text had nothing to restore, and a failed restore reports
        // false rather than claim their contents are safe.
        clipboardRestored: restored,
      };
    });
  }

  async setValue(
    threadId: string | undefined,
    target: ComputerTarget,
    value: string,
  ): Promise<ComputerActionResult> {
    return this.withSemanticControl(threadId, target.windowId, async () => {
      // Preferred over click-then-type when the target carries a live element
      // token: one atomic write instead of focus plus keystrokes.
      const resolved = await this.prepareSemanticDispatch(target, threadId);
      const result = await timedComputerLeg("dispatch", () =>
        this.backend.setValue(resolved, value),
      );
      return this.actionResult(
        threadId,
        "computer_set_value",
        resolved.point,
        result,
        resolved.node.windowId ?? undefined,
      );
    });
  }

  async performAction(
    threadId: string | undefined,
    target: ComputerTarget,
    action: string,
  ): Promise<ComputerActionResult> {
    return this.withBackgroundProcessControl(threadId, target.windowId, async () => {
      const resolved = await this.prepareSemanticDispatch(target, threadId);
      const result = await timedComputerLeg("dispatch", () =>
        this.backend.performAction(resolved, action),
      );
      return this.actionResult(
        threadId,
        "computer_perform_action",
        resolved.point,
        result,
        resolved.node.windowId ?? undefined,
      );
    });
  }

  /**
   * Exact-range text selection through the accessibility layer — the
   * `computer_select_text` path. The target is resolved from fresh state so
   * the backend dispatches on a live element token, never on a stale
   * caller-supplied one; the backend's native read-back alone decides
   * `verified`. A `window_id`-only target may resolve to the window's sole
   * writable text control, the same rule `typeTextAt` applies — an ambiguous
   * or read-only match is refused rather than guessed.
   */
  async selectText(
    threadId: string | undefined,
    target: ComputerTarget,
    range: ComputerTextRange,
  ): Promise<ComputerActionResult> {
    return this.withSemanticControl(threadId, target.windowId, async () => {
      const resolved = await this.prepareSemanticDispatch(target, threadId, true);
      const result = await timedComputerLeg("dispatch", () =>
        this.backend.selectText(resolved, range),
      );
      return this.actionResult(
        threadId,
        "computer_select_text",
        resolved.point,
        result,
        resolved.node.windowId ?? undefined,
      );
    });
  }

  /**
   * Runs one agent tool call with this thread counted as driving the desktop.
   *
   * The count is kept whether or not this thread has a runtime record, because
   * the lease's in-flight guard reads it: while it was a field on the record,
   * every thread on a visible-desktop backend counted as idle from the first
   * call to the last, and the desktop could be taken from a thread in the
   * middle of a drag. Publishing the badge still requires a record, since a
   * thread nobody is watching has no panel to update.
   */
  async withAgentActivity<A>(
    threadId: string,
    action: () => Promise<A>,
    signal?: AbortSignal,
    turnId?: string,
    operationKey?: string,
  ): Promise<A> {
    assertDesktopOperationAdmission();
    let authority = this.authorityRevocations.get(threadId);
    if (authority?.signal.aborted) {
      // A revoked broadcast must not poison later calls: mint fresh so a
      // re-armed thread is not stillborn on the previous revocation.
      authority = undefined;
      this.authorityRevocations.delete(threadId);
    }
    if (!authority) {
      authority = new AbortController();
      this.authorityRevocations.set(threadId, authority);
    }
    const admissionSignal = signal ? AbortSignal.any([signal, authority.signal]) : authority.signal;
    const execute = async (): Promise<A> => {
      // The raw id, not the pane-normalized one: a whitespace thread still
      // gets its revoked-or-suspended check, the same gate the input
      // wrappers apply to their resolved owner.
      this.assertControlAuthority(threadId);
      const controller = new AbortController();
      let live = this.activeAuthorities.get(threadId);
      if (!live) {
        live = new Set();
        this.activeAuthorities.set(threadId, live);
      }
      live.add(controller);
      const owner = agentThreadId(threadId);
      if (owner === undefined) {
        try {
          return await withDesktopOperationSignal(controller.signal, action);
        } finally {
          live.delete(controller);
          if (live.size === 0) this.activeAuthorities.delete(threadId);
        }
      }
      if (turnId) this.authorityTurns.set(owner, turnId);
      const depth = (this.agentCallsInFlight.get(owner) ?? 0) + 1;
      this.agentCallsInFlight.set(owner, depth);
      if (depth === 1) this.publishCached(owner);
      try {
        return await withDesktopOperationSignal(controller.signal, action);
      } finally {
        live.delete(controller);
        if (live.size === 0) this.activeAuthorities.delete(threadId);
        const remaining = Math.max(0, (this.agentCallsInFlight.get(owner) ?? 1) - 1);
        if (remaining === 0) {
          this.agentCallsInFlight.delete(owner);
          this.releaseBackgroundControl(owner, undefined, true);
          if (
            this.lease?.threadId !== owner &&
            ![...this.backgroundLeases.values()].some((lease) => lease.threadId === owner)
          ) {
            this.authorityTurns.delete(owner);
          }
          if (this.lease?.threadId === owner && this.lease.releaseRequested) {
            const requestedTurnId = this.lease.releaseRequestedTurnId;
            // The deferred release is only valid while the lease still names
            // the turn it was requested for — and an anonymous request only
            // while the lease is still anonymous. A renewed lease drops it
            // rather than letting a dead turn's intent kill live work.
            const stillMatches =
              requestedTurnId === undefined
                ? this.lease.turnId === undefined
                : this.lease.turnId === requestedTurnId;
            if (stillMatches) {
              await withoutDesktopCancellation(() =>
                this.releaseDesktopControl(owner, requestedTurnId),
              );
            } else {
              delete this.lease.releaseRequested;
              delete this.lease.releaseRequestedTurnId;
              this.publishCached(owner);
            }
          } else {
            this.publishCached(owner);
          }
        } else {
          this.agentCallsInFlight.set(owner, remaining);
        }
      }
    };
    // Entered around the queue handoff so a call's total covers its wait for
    // the desktop, not just the work after it wins.
    return this.withComputerCall(() =>
      operationKey
        ? this.operations.runScoped(operationKey, execute, admissionSignal)
        : this.operations.run(execute, admissionSignal),
    );
  }

  /**
   * Whether the backend exposes the driver's CDP browser surface. Absent
   * means "no browser route": the gateway must not advertise the tools at
   * all, which is also the honest answer a desktop-only backend gives.
   */
  get supportsBrowser(): boolean {
    return this.backend.browser !== undefined;
  }

  /**
   * Dispatch one driver browser call for a thread. Browser work shares the
   * turn's authority revocation and caller signal with desktop work, but not
   * the desktop lease, the desktop coordinate space, the frame tap, or the
   * post-unlock observation gate: targets are opaque session-scoped
   * capabilities minted by the driver, and every result — including a
   * deliberate `status:"refused"` reply — is driver-produced. Calls for one
   * thread serialize on a browser lane keyed to the thread so lifecycle
   * transitions (prepare, navigate, end) cannot interleave mid-flight.
   */
  async browserCall(
    threadId: string,
    turnId: string | undefined,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    beforeDispatch?: () => Promise<void>,
  ): Promise<ComputerBrowserCallResult> {
    const browser = this.backend.browser;
    if (!browser)
      throw new ComputerBackendError("This computer backend does not provide browser automation.", {
        retryable: false,
      });
    return this.withAgentActivity(
      threadId,
      async () => {
        const operationSignal = desktopOperationSignal();
        if (!operationSignal)
          throw new ComputerBackendError(
            "Computer browser call ran outside an operation context.",
            { retryable: false },
          );
        operationSignal.throwIfAborted();
        // Authorization can change while the thread's browser lane is busy.
        // Recheck after admission, then fence the native call against a stop
        // that arrives while this asynchronous check is still running.
        if (beforeDispatch) await beforeDispatch();
        operationSignal.throwIfAborted();
        if (name === "browser_prepare" && args.windowed === true)
          this.spaceBroker.assertForegroundAllowed(threadId);
        const invoke = () =>
          browser.call({
            name,
            args,
            task: { threadId, ...(turnId ? { turnId } : {}) },
            mutation: name !== "get_browser_state",
            signal: operationSignal,
          });
        // Only the gateway's successful visible-use recheck can stamp a
        // visible launch as authorized. Model arguments alone cannot do so.
        return beforeDispatch && name === "browser_prepare" && args.windowed === true
          ? withDesktopDeliveryMode("foreground", invoke)
          : invoke();
      },
      signal,
      turnId,
      `browser:${threadId}`,
    );
  }

  /**
   * Runs `run` inside a per-call context, creating one only when no enclosing
   * call already did. Tool calls arrive wrapped by `withAgentActivity`;
   * direct manager calls — pane input, tests — get one here so their legs
   * still measure. The context also carries a delivered action's effect proof
   * to the post-action observer, scoped to the call so no later call can
   * inherit it. With neither flag set it is a passthrough.
   */
  private withComputerCall<A>(run: () => Promise<A>): Promise<A> {
    if (currentComputerCall() !== undefined) return run();
    const context = createComputerCallContext();
    if (context === undefined) return run();
    return withComputerCallContext(context, async () => {
      try {
        return await run();
      } catch (error) {
        context.timing?.markFailed();
        throw error;
      } finally {
        context.timing?.finish();
      }
    });
  }

  private canUseBackgroundTarget(): boolean {
    return (
      this.backend.exactTargetBackgroundInput === true && desktopDeliveryMode() !== "foreground"
    );
  }

  private withSemanticControl<A>(
    threadId: string | undefined,
    windowId: string | undefined,
    action: () => Promise<A>,
  ): Promise<A> {
    return windowId && this.canUseBackgroundTarget()
      ? this.withBackgroundWindowControl(threadId, windowId, action)
      : this.withDesktopControl(threadId, action);
  }

  /** Keep a complete native gesture atomic without reserving unrelated apps for a whole turn. */
  private withBackgroundProcessControl<A>(
    threadId: string | undefined,
    windowId: string | undefined,
    action: () => Promise<A>,
  ): Promise<A> {
    if (!windowId || !this.canUseBackgroundTarget())
      return this.withDesktopControl(threadId, action);
    return this.withBackgroundResourceControl(
      threadId,
      async () => {
        const window = await this.resolveWindowTarget(threadId, windowId);
        if (window.pid === undefined || window.pid <= 0) {
          throw new ComputerBackendError(
            "Background input needs a verified application process for the exact window.",
          );
        }
        return { key: `process:${window.pid}`, pid: window.pid };
      },
      action,
    );
  }

  private withBackgroundAppControl(
    threadId: string | undefined,
    app: string,
    action: () => Promise<ComputerLaunchAppResult>,
  ): Promise<ComputerLaunchAppResult> {
    if (!this.canUseBackgroundTarget()) return this.withDesktopControl(threadId, action);
    return this.withBackgroundResourceControl(
      threadId,
      async () => {
        this.assertDrivenAppAllowed(app);
        const apps = await this.backend.listApps?.();
        const spelling = app.trim().toLowerCase();
        const matches =
          apps?.filter((candidate) =>
            [candidate.name, candidate.bundleId, candidate.launchPath].some(
              (name) => name?.toLowerCase() === spelling,
            ),
          ) ?? [];
        // Never guess which process LaunchServices will choose among several
        // running instances of the same app.
        const running = matches.filter((candidate) => candidate.running && candidate.pid > 0);
        if (running.length > 1) {
          throw new ComputerBackendError(
            "Several running applications match this launch. Use an exact existing window instead.",
          );
        }
        const target = running[0] ?? matches[0];
        return target?.running
          ? { key: `process:${target.pid}`, pid: target.pid }
          : {
              key: `application:${(target?.bundleId ?? target?.launchPath ?? target?.name ?? spelling).toLowerCase()}`,
            };
      },
      async (target) => {
        const result = await action();
        // A cold launch now has a process identity. Keep its app reservation
        // attached to that pid, so another task cannot take its first window
        // while the launching task is observing it.
        const held = this.backgroundLeases.get(target.key);
        const pid = result.pid ?? result.window?.pid;
        if (held && held.threadId === agentThreadId(threadId) && pid !== undefined && pid > 0) {
          this.backgroundLeases.set(target.key, { ...held, target: { ...target, pid } });
        }
        return result;
      },
    );
  }

  private withBackgroundResourceControl<A>(
    threadId: string | undefined,
    resolve: () => Promise<BackgroundControlTarget>,
    action: (target: BackgroundControlTarget) => Promise<A>,
  ): Promise<A> {
    assertDesktopOperationAdmission();
    const owner = agentThreadId(threadId);
    if (owner === undefined) this.lastUserDesktopInputAt = this.now();
    // Process-scoped native input and its observation remain one exclusive
    // queue transaction. Only logical ownership is narrower than the desktop.
    return this.operations.run(async () => {
      this.assertControlAuthority(owner);
      this.assertInputNotPaused(owner);
      const target = await resolve();
      assertDesktopOperationActive();
      this.claimBackgroundControl(owner, target);
      this.engageBackend();
      try {
        return await this.withComputerCall(() => action(target));
      } catch (error) {
        this.recordInputPause(owner, error);
        throw error;
      }
    });
  }

  private claimBackgroundControl(owner: string | undefined, target: BackgroundControlTarget): void {
    if (owner === undefined) return;
    const now = this.now();
    if (this.lease && this.lease.threadId !== owner && !this.isLeaseStale(this.lease, now)) {
      throw new ComputerLeaseError();
    }
    if (this.lease && this.isLeaseStale(this.lease, now)) {
      this.authorityTurns.delete(this.lease.threadId);
      this.lease = null;
    }
    for (const [key, lease] of this.backgroundLeases) {
      if (this.isLeaseStale(lease, now)) {
        this.backgroundLeases.delete(key);
        this.clearEvictedBackgroundOwner(lease.threadId);
        continue;
      }
      const sameProcess = target.pid !== undefined && target.pid === lease.target.pid;
      const conflict =
        target.key === key || (sameProcess && (!target.windowId || !lease.target.windowId));
      if (conflict && lease.threadId !== owner) throw new ComputerLeaseError(true);
    }
    const claiming = currentComputerTask();
    const turnId =
      (claiming?.threadId === owner ? claiming.turnId : undefined) ??
      this.authorityTurns.get(owner);
    const held = this.backgroundLeases.get(target.key);
    this.backgroundLeases.set(target.key, {
      threadId: owner,
      target,
      ...(turnId ? { turnId } : {}),
      lastActivityMs: now,
      ...(held?.threadId === owner && held.turnId === turnId && held.releaseRequested
        ? { releaseRequested: true, releaseRequestedTurnId: held.releaseRequestedTurnId }
        : {}),
    });
    if (held?.threadId !== owner) this.publishOwnershipCached();
  }

  private publishOwnershipCached(): void {
    for (const threadId of this.threads.keys()) this.publishCached(threadId);
  }

  private clearEvictedBackgroundOwner(owner: string): void {
    if (
      this.lease?.threadId === owner ||
      [...this.backgroundLeases.values()].some((lease) => lease.threadId === owner)
    )
      return;
    this.authorityTurns.delete(owner);
    const state = this.threads.get(owner);
    if (state) state.paneSurfaced = false;
    this.publishOwnershipCached();
  }

  private releaseBackgroundControl(owner: string, turnId?: string, onlyRequested = false): void {
    let changed = false;
    for (const [key, lease] of this.backgroundLeases) {
      if (lease.threadId !== owner || (turnId && lease.turnId && lease.turnId !== turnId)) continue;
      if (
        onlyRequested &&
        (!lease.releaseRequested || lease.releaseRequestedTurnId !== lease.turnId)
      )
        continue;
      if ((this.agentCallsInFlight.get(owner) ?? 0) > 0) {
        lease.releaseRequested = true;
        lease.releaseRequestedTurnId = turnId ?? lease.turnId;
      } else {
        this.backgroundLeases.delete(key);
        changed = true;
      }
    }
    if (
      this.lease?.threadId !== owner &&
      ![...this.backgroundLeases.values()].some((lease) => lease.threadId === owner)
    ) {
      const state = this.threads.get(owner);
      if (state) state.paneSurfaced = false;
    }
    if (changed) this.publishOwnershipCached();
  }

  private withBackgroundWindowControl<A>(
    threadId: string | undefined,
    windowId: string,
    action: () => Promise<A>,
  ): Promise<A> {
    if (desktopDeliveryMode() === "foreground") return this.withDesktopControl(threadId, action);
    assertDesktopOperationAdmission();
    const owner = agentThreadId(threadId);
    // Pane input (no owning thread) is the human driving their own desktop:
    // stamp it so a foreground excursion cannot raise a window into the middle
    // of their interaction.
    if (owner === undefined) this.lastUserDesktopInputAt = this.now();
    return this.operations.runScoped(windowId, async () => {
      this.assertControlAuthority(owner);
      this.assertInputNotPaused(owner);
      const target = await this.resolveWindowTarget(threadId, windowId);
      assertDesktopOperationActive();
      this.claimBackgroundControl(owner, {
        key: `window:${windowId}`,
        windowId,
        ...(target.pid !== undefined ? { pid: target.pid } : {}),
      });
      this.engageBackend();
      try {
        return await this.withComputerCall(action);
      } catch (error) {
        this.recordInputPause(owner, error);
        throw error;
      }
    });
  }

  /**
   * Take or renew the exclusive desktop lease for a mutating agent action, or
   * refuse the action because another conversation holds it.
   *
   * Ownership is implicit: the first thread to drive the desktop owns it, and
   * keeps owning it until its turn ends. There is no explicit acquire tool
   * because there is nothing sensible for a model to do with one — it would
   * either forget to release, or treat a refusal to acquire as a different
   * failure from a refusal to act.
   *
   * An undefined (or blank) thread is the human driving through the computer
   * pane, which the same rule as `emitAction` identifies. The human is not a
   * competing agent: they are the person the desktop belongs to, so pane input
   * neither takes the lease nor is ever refused by it.
   */
  private withDesktopControl<A>(
    threadId: string | undefined,
    action: () => Promise<A>,
    beforeClaim?: () => void,
  ): Promise<A> {
    assertDesktopOperationAdmission();
    const owner = agentThreadId(threadId);
    // Pane input (no owning thread) is the human driving their own desktop:
    // stamp it so a foreground excursion cannot raise a window into the middle
    // of their interaction. Stamped before the queue so a queued agent call
    // sees the interaction that preceded it.
    if (owner === undefined) this.lastUserDesktopInputAt = this.now();
    if (
      owner &&
      this.lease &&
      this.lease.threadId !== owner &&
      !this.isLeaseStale(this.lease, this.now())
    ) {
      return Promise.reject(new ComputerLeaseError());
    }
    return this.operations.run(async () => {
      this.assertControlAuthority(owner);
      // Readiness first: a paused thread is refused before it can take the
      // lease, clear focus, or announce itself — all of which claimDesktopControl
      // would otherwise do ahead of a refusal that sends nothing.
      this.assertInputNotPaused(owner);
      // Admission belongs before the lease claim: even clearFocusWindow and
      // cursor setup may cold-start a native process. A refused foreground
      // call must not start it, take the lease, or publish a driving session.
      // Run inside the queue so recent human input is checked at dispatch.
      beforeClaim?.();
      await this.claimDesktopControl(threadId);
      assertDesktopOperationActive();
      try {
        return await this.withComputerCall(action);
      } catch (error) {
        this.recordInputPause(owner, error);
        throw error;
      }
    });
  }

  private async refreshInputPause(
    windowId: string,
    windows: readonly ComputerWindow[],
  ): Promise<void> {
    if (!this.backend.checkInputReady) return;
    const observingThread = currentComputerTask()?.threadId;
    const observedWindow = windows.find((window) => window.id === windowId);
    const paused = [...this.threads.entries()].filter(
      ([threadId, state]) =>
        (observingThread === undefined || observingThread === threadId) &&
        state.inputPause &&
        (!state.inputPause.windowId ||
          state.inputPause.windowId === windowId ||
          (state.inputPause.pid !== undefined &&
            observedWindow?.pid === state.inputPause.pid &&
            observedWindow.visible &&
            !observedWindow.minimized &&
            observedWindow.onCurrentSpace !== false) ||
          (state.inputPause.pid === undefined &&
            !windows.some((window) => window.id === state.inputPause?.windowId))),
    );
    if (paused.length === 0) return;
    const snapshots = paused.map(([threadId, state]) => ({
      threadId,
      state,
      pause: state.inputPause,
      // The generation this pause was observed under. A disable/re-enable
      // between the snapshot and the clear must not launder an old pause away.
      generation: this.controlState.get(threadId).generation,
    }));
    try {
      await this.backend.checkInputReady(windowId);
    } catch {
      return; // Read-only perception remains available while input is paused.
    }
    assertDesktopOperationActive();
    for (const { threadId, state, pause, generation } of snapshots) {
      if (this.threads.get(threadId) !== state || state.inputPause !== pause) continue;
      // The window is ready, but only a still-authorized thread may resume on
      // that news: a thread revoked (or re-armed to a new generation) while
      // the readiness probe was in flight keeps its pause.
      if (!this.canActivateControl(threadId, generation)) continue;
      delete state.inputPause;
      state.lastError = null;
      this.publishCached(threadId);
    }
  }

  private async claimDesktopControl(threadId: string | undefined): Promise<void> {
    // Before the early return, not after it: pane input belongs to no thread and
    // takes no lease, but it is still the human asking this backend to drive
    // their desktop, which is exactly what engagement means.
    this.engageBackend();
    const owner = agentThreadId(threadId);
    if (owner === undefined) return;
    // The window list as it stood before this action, so the observer can tell
    // "nothing happened" apart from "a window opened that the capture could not
    // see". Free after the first action: every publish and every targeting read
    // refreshes the cache, and only a process that has never listed windows pays
    // for a read here.
    this.preActionWindowIds =
      this.lastKnownWindowIds ?? (await this.readWindows().then(windowIdSet, () => undefined));
    const now = this.now();
    for (const [key, lease] of this.backgroundLeases) {
      if (this.isLeaseStale(lease, now)) {
        this.backgroundLeases.delete(key);
        this.clearEvictedBackgroundOwner(lease.threadId);
      } else if (lease.threadId !== owner) throw new ComputerLeaseError();
    }
    const held = this.lease;
    const heldStale = held !== null && this.isLeaseStale(held, now);
    if (held && held.threadId !== owner && !heldStale) {
      throw new ComputerLeaseError();
    }
    // A dead lease's turn stamp is dead with it: an anonymous re-claim must
    // not inherit it, and an evicted owner's entry can never be useful again.
    if (heldStale) {
      this.authorityTurns.delete(held.threadId);
      // The evicted owner's surfaced surface died with its control period.
      // Clearing here because its release returns early on the lease-owner
      // check in releaseDesktopControl, never reaching the reset there.
      const evicted = this.threads.get(held.threadId);
      if (evicted) evicted.paneSurfaced = false;
    }
    const changed = held?.threadId !== owner;
    assertDesktopOperationActive();
    if (changed) {
      await this.backend.clearFocusWindow?.();
      assertDesktopOperationActive();
    }
    // Stamp the claiming caller's own turn when it carries one; the map only
    // fills the gap for turnId-less callers sharing the owning turn's window.
    const claimingTask = currentComputerTask();
    const stampedTurnId =
      (claimingTask && agentThreadId(claimingTask.threadId) === owner
        ? claimingTask.turnId
        : undefined) ?? this.authorityTurns.get(owner);
    this.lease = {
      threadId: owner,
      ...(stampedTurnId ? { turnId: stampedTurnId } : {}),
      lastActivityMs: now,
      ...(!changed && held?.releaseRequested
        ? {
            releaseRequested: true,
            releaseRequestedTurnId: held.releaseRequestedTurnId,
          }
        : {}),
    };
    if (heldStale) {
      this.recordLeaseLifecycle("stale-reclaimed", held, {
        idleMs: now - held.lastActivityMs,
        nextThreadId: owner,
      });
    }
    if (changed || heldStale || held?.turnId !== this.lease.turnId) {
      this.recordLeaseLifecycle("acquired", this.lease);
    }
    if (changed) {
      await this.announceDrivingAgent(owner);
      // Both panels change: the new owner stops being blocked, and every other
      // thread starts being.
      await this.publishAllThreads();
    }
  }

  /** Lifecycle evidence contains identities and timing, never input or titles. */
  private recordLeaseLifecycle(
    event: "acquired" | "release-requested" | "released" | "stale-reclaimed",
    lease: DesktopLease,
    detail?: { readonly idleMs: number; readonly nextThreadId: string },
  ): void {
    console.info("[computer] desktop lease", {
      ts: new Date(this.now()).toISOString(),
      event,
      threadId: lease.threadId,
      ...(lease.turnId ? { turnId: lease.turnId } : {}),
      ...detail,
    });
  }

  /**
   * Names the thread driving the desktop so a backend that draws an agent
   * cursor can label it. Best effort: a missing or failed label is a cosmetic
   * loss, and must never turn into a refused action.
   */
  private async announceDrivingAgent(threadId: string | null): Promise<void> {
    this.cursorActivity.setOwner(threadId);
    if (!this.backend.setDrivingAgent) return;
    const label = threadId === null ? null : (this.threadLabels.get(threadId) ?? null);
    await this.backend.setDrivingAgent(label).catch(() => undefined);
  }

  /**
   * The display name for a thread's agent cursor badge. Pushed in by the tool
   * layer, which is the only place that knows a thread's title, rather than
   * queried from here — the manager is built without any orchestration
   * dependency and reading a title on every action would put a database read
   * inside the lease claim.
   */
  setThreadLabel(threadId: string, label: string | null): void {
    const owner = agentThreadId(threadId);
    if (owner === undefined) return;
    const trimmed = label?.trim();
    if (trimmed) {
      if (this.threadLabels.get(owner) === trimmed) return;
      this.threadLabels.delete(owner);
      this.threadLabels.set(owner, trimmed);
      for (const id of this.threadLabels.keys()) {
        if (this.threadLabels.size <= 256) break;
        if (id === owner || id === this.lease?.threadId || this.agentCallsInFlight.has(id))
          continue;
        this.threadLabels.delete(id);
      }
    } else {
      if (!this.threadLabels.delete(owner)) return;
    }
    // Only when this thread is the one on screen; every other thread's label is
    // just recorded for whenever it takes the desktop.
    if (this.lease?.threadId === owner) void this.announceDrivingAgent(owner);
  }

  /**
   * Release the desktop the moment the owning thread stops being able to drive
   * it — its turn reached a terminal state, or its provider session exited.
   * This is the lease's primary release path; idle expiry only covers a runtime
   * that died without reporting either.
   *
   * A terminal event names its turn so a late completion cannot release a lease
   * already renewed by a newer turn. Session teardown may release the whole
   * thread by omitting the turn id.
   */
  async releaseDesktopControl(threadId: string, turnId?: string): Promise<void> {
    const owner = agentThreadId(threadId);
    if (owner === undefined) return;
    this.spaceBroker.release(owner, turnId);
    this.releaseBackgroundControl(owner, turnId);
    // A normal thread-level completion must keep its queued preview/cursor
    // cleanup on the observed turn, just like the lease release below. Real
    // control revocation/removal is thread-wide and also closes older tasks.
    const cleanupTurnId =
      turnId ??
      (!this.controlDisabled(owner) &&
      !this.suspendedThreads.has(owner) &&
      this.lease?.threadId === owner
        ? this.lease.turnId
        : this.authorityTurns.get(owner));
    // Preview teardown must not block lifecycle ingestion or an in-flight
    // operation's finalizer. In particular, awaiting it on the deferred path
    // would prevent the operation from draining and leave the lease held.
    void Promise.resolve()
      .then(() => this.backend.endTask?.(owner, cleanupTurnId))
      .catch((error: unknown) => {
        void this.recordThreadError(owner, `Preview cleanup failed: ${errorMessage(error)}`).catch(
          () => undefined,
        );
      });
    if (this.lease?.threadId !== owner) {
      if (
        (this.agentCallsInFlight.get(owner) ?? 0) === 0 &&
        ![...this.backgroundLeases.values()].some((lease) => lease.threadId === owner) &&
        (!turnId || this.authorityTurns.get(owner) === turnId)
      )
        this.authorityTurns.delete(owner);
      this.publishCached(owner);
      return;
    }
    if (turnId && this.lease.turnId && this.lease.turnId !== turnId) return;
    if ((this.agentCallsInFlight.get(owner) ?? 0) > 0) {
      if (!this.lease.releaseRequested) {
        this.recordLeaseLifecycle("release-requested", this.lease);
      }
      this.lease.releaseRequested = true;
      // A thread-level release names no turn: stamp whoever holds the lease
      // at request time so a newer turn's renewal is not torn down by a
      // stale deferred release.
      this.lease.releaseRequestedTurnId = turnId ?? this.lease.turnId;
      return;
    }
    const releasedTurnId = this.lease.turnId;
    await this.operations.run(async () => {
      if (this.lease?.threadId !== owner) return;
      // The queue can admit a newer turn before this release gets its slot.
      // Even a thread-level teardown belongs to the turn observed above.
      if (this.lease.turnId !== releasedTurnId) return;
      await this.backend.clearFocusWindow?.();
      this.recordLeaseLifecycle("released", this.lease);
      this.lease = null;
      // The released turn is no longer this thread's authority: a later
      // turnId-less caller must claim anonymously, not inherit a stale
      // stamp a duplicate release could still match.
      this.authorityTurns.delete(owner);
      const runtime = this.threads.get(owner);
      if (runtime) runtime.paneSurfaced = false;
      await this.announceDrivingAgent(null);
    });
    await this.publishAllThreads();
  }

  /**
   * Stale only once nothing is in flight: a call that is still running holds
   * the pointer or the keyboard right now, and elapsed time since it started
   * says nothing about whether it has finished.
   */
  private isLeaseStale(lease: DesktopLease, now: number): boolean {
    if (now - lease.lastActivityMs < this.leaseIdleMs) return false;
    return (this.agentCallsInFlight.get(lease.threadId) ?? 0) === 0;
  }

  async recordThreadError(threadId: string, message: string): Promise<void> {
    const state = this.threads.get(threadId);
    if (!state) return;
    state.reportedError = clampComputerMessage(
      message,
      "The computer backend reported an error without a message.",
    );
    await this.publish(threadId).catch(() => undefined);
  }

  subscribeFrames(sink: FrameSink): () => void {
    // A pane attach is a user asking to watch the desktop, which is a real use:
    // the stream cannot exist without a connected backend anyway.
    this.engageBackend();
    const unsubscribe = this.transport.subscribe(this.computerId, sink);
    this.streamDesired = true;
    this.streamEpoch += 1;
    void this.reconcileStream().catch((error) => this.recordError(error));
    return () => {
      unsubscribe();
      if (this.transport.streamSubscriberCount(this.computerId) === 0) {
        this.streamDesired = false;
        this.streamEpoch += 1;
        void this.reconcileStream().catch((error) => this.recordError(error));
      }
    };
  }

  async requestKeyframe(): Promise<void> {
    if (!this.streamAttached || this.transport.streamSubscriberCount(this.computerId) === 0) return;
    const epoch = this.streamEpoch;
    await this.enqueueStreamTransition(async () => {
      if (!this.isStreamWanted(epoch) || !this.streamAttached) return;
      if (this.backend.requestKeyframe) {
        await this.backend.requestKeyframe();
        if (!this.isStreamWanted(epoch)) return;
        return;
      }
      await this.backend.detachStream();
      this.streamAttached = false;
      if (!this.isStreamWanted(epoch)) {
        this.transport.reset(this.computerId);
        return;
      }
      this.transport.reset(this.computerId);
      await this.backend.attachStream((frame) => this.handleFrame(frame));
      if (!this.isStreamWanted(epoch)) {
        this.streamAttached = false;
        this.transport.reset(this.computerId);
        await this.backend.detachStream();
        return;
      }
      this.streamAttached = true;
    });
  }

  async flushStreamTransitions(): Promise<void> {
    await this.streamTransition;
  }

  async handleThreadRemoved(threadId: string): Promise<void> {
    this.spaceBroker.release(threadId);
    // Cancel first, synchronously, before the suspend below can yield: removal
    // revokes authority, and a prompt admitted a millisecond earlier must
    // settle now rather than at the gate's timeout.
    computerApprovalGate.cancelThread(threadId);
    this.suspendedThreads.add(threadId);
    // A rejected stop (e.g. preview cleanup failing inside the release) must
    // not skip removal — a removed thread that keeps its lease can reappear
    // as the desktop's owner until the idle backstop fires.
    // Bounded: a wedged in-flight op must not stall removal forever — the
    // suspend and the deletions are already held, only the drain is lost.
    await withControlTeardownTimeout(this.revokeControl(threadId)).catch(() => undefined);
    this.publishChains.delete(threadId);
    this.threads.delete(threadId);
    this.threadLabels.delete(threadId);
    this.authorityTurns.delete(threadId);
    this.authorityRevocations.delete(threadId);
    this.activeAuthorities.delete(threadId);
    // Deleted after the thread state, so the resulting publish cannot recreate
    // it: a removed thread must not reappear as a lease holder. A rejected
    // or wedged release must not stall removal either — the idle backstop
    // owns the lease.
    await withControlTeardownTimeout(this.releaseDesktopControl(threadId)).catch(() => undefined);
    // Browser sessions are thread-scoped, not lease-scoped: a browser-only
    // thread may never have held the desktop lease, so teardown cannot ride
    // the release. Failure is tolerated — the driver's transport-EOF reaper
    // is the backstop for anything the explicit end could not reach — and a
    // wedge is bounded like the rest of teardown.
    await withControlTeardownTimeout(
      this.backend.browser?.endThread?.(threadId) ?? Promise.resolve(),
    ).catch(() => undefined);
  }

  async handleThreadRestored(threadId: string): Promise<void> {
    // A pending stop's rejection (e.g. preview cleanup that failed during the
    // release) must not keep a restored thread suspended forever — the
    // suspension exists to block input while teardown runs, and a rejected
    // teardown is still a settled teardown.
    await this.pendingStops.get(threadId)?.catch(() => undefined);
    this.suspendedThreads.delete(threadId);
    this.authorityRevocations.delete(threadId);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.spaceBroker.dispose();
    this.cursorActivity.dispose();
    // Teardown cannot depend on the host still answering: an unreachable
    // endpoint means the input path it owned is already gone, so the wait is
    // bounded like every other teardown leg.
    await withControlTeardownTimeout(this.backend.stopInput?.() ?? Promise.resolve()).catch(
      () => undefined,
    );
    // close() aborts live work synchronously before its drain awaits, so a
    // wedged operation can only cost the drain — never the abort or the
    // teardown that follows.
    await withControlTeardownTimeout(this.operations.close()).catch(() => undefined);
    if (this.windowsPublishTimer !== undefined) clearTimeout(this.windowsPublishTimer);
    this.windowsPublishTimer = undefined;
    this.windowsPublishPending = false;
    if (this.errorRepublishTimer !== undefined) clearTimeout(this.errorRepublishTimer);
    this.errorRepublishTimer = undefined;
    this.streamDesired = false;
    this.streamEpoch += 1;
    await this.enqueueStreamTransition(async () => {
      if (this.streamAttached) {
        this.streamAttached = false;
        this.transport.reset(this.computerId);
        await this.backend.detachStream();
      }
    }).catch(() => undefined);
    this.backendUnsubscribe?.();
    await this.backend.dispose();
    this.listeners.clear();
    await this.auditLog.flush();
  }

  private async reconcileStream(): Promise<void> {
    await this.enqueueStreamTransition(async () => {
      if (this.disposed || !this.streamDesired) {
        if (!this.streamAttached) return;
        this.streamAttached = false;
        this.transport.reset(this.computerId);
        await this.backend.detachStream();
        return;
      }
      if (this.streamAttached) return;
      const epoch = this.streamEpoch;
      await this.backend.attachStream((frame) => this.handleFrame(frame));
      if (!this.isStreamWanted(epoch)) {
        await this.backend.detachStream();
        this.transport.reset(this.computerId);
        return;
      }
      this.streamAttached = true;
    });
  }

  private enqueueStreamTransition(action: () => Promise<void>): Promise<void> {
    const next = this.streamTransition.then(action);
    this.streamTransition = next.catch(() => undefined);
    return next;
  }

  /**
   * Frames travel on the binary transport and nowhere else. A parallel
   * `computer.frame` notice on the JSON event channel used to be emitted here
   * too; its only consumer read the header and did nothing with it, so every
   * still frame paid for a serialized event that told no one anything.
   */
  private handleFrame(frame: ComputerStreamFrame): void {
    if (this.disposed || (!this.streamDesired && !this.streamAttached)) return;
    this.transport.publish(this.computerId, frame);
  }

  /**
   * Coordinates plus a window id are a window-scoped click: the point is
   * resolved exactly as a bare coordinate, and the window id only decides which
   * window is raised and receives the input. A label or role instead means the
   * coordinate is at most a hint, so those keep going through AT-SPI
   * resolution, which owns the final point.
   */
  private assertTargetCanUseCoordinates(target: ComputerTarget): void {
    if (observedComputerTargetNode(target)) {
      throw new ComputerTargetError({
        code: "computer_target_refused",
        message:
          "This observed element does not support the requested exact pointer action. Use an advertised semantic action or explicitly target a current screenshot; no coordinate fallback was sent.",
      });
    }
  }

  private async resolvePointTarget(
    target: ComputerTarget,
    threadId: string | undefined,
  ): Promise<ResolvedPointTarget> {
    if (hasCoordinates(target) && !hasLabelFields(target)) {
      this.spaceBroker.assertTargetBound(agentThreadId(threadId), target.windowId);
      const point = await this.resolveCoordinatePoint(target);
      if (target.windowId === undefined) {
        // The compositor routes a bare point to whatever is topmost at it, so
        // the denylist answers the same question the occlusion rules already
        // ask: which window would actually take this input. When stacking
        // cannot pick one — several windows cover the point and the list
        // carries no order — the check closes against every covering window:
        // the denied surface might be the one input reaches.
        const windows = await this.readWindows();
        const topmost = topmostWindowAtPoint(windows, point);
        if (topmost !== undefined) {
          await this.assertWindowInputAllowed(threadId, topmost.id);
        } else {
          for (const window of windows) {
            if (!window.visible || window.minimized) continue;
            if (!rectContainsPoint(window.bounds, point)) continue;
            await this.assertWindowInputAllowedWindow(threadId, window);
          }
        }
        return { point };
      }
      const occlusion = await this.scopedPointOcclusion(point, target.windowId);
      await this.assertWindowInputAllowed(threadId, target.windowId);
      // A denied surface sitting over the scoped point can still take the
      // input — the raise the covering list waits on may fail, and an
      // unranked window list cannot even prove what covers what — so the
      // point refuses while any window that could intercept it is denied.
      if (agentThreadId(threadId) !== undefined) {
        const suspects =
          occlusion.covering.length > 0
            ? occlusion.covering
            : occlusion.ranked
              ? []
              : occlusion.windows.filter(
                  (window) =>
                    window.id !== target.windowId &&
                    window.visible &&
                    !window.minimized &&
                    rectContainsPoint(window.bounds, point),
                );
        for (const window of suspects) {
          await this.assertWindowInputAllowedWindow(threadId, window);
        }
      }
      return { point, windowId: target.windowId, covering: occlusion.covering };
    }
    if (hasSemanticFields(target)) {
      const resolved = await this.resolveSemanticTarget(target);
      if (resolved.node.windowId) {
        await this.assertWindowInputAllowed(threadId, resolved.node.windowId);
      }
      return {
        point: resolved.point,
        semantic: resolved,
        ...(resolved.node.windowId ? { windowId: resolved.node.windowId } : {}),
      };
    }
    throw new ComputerTargetError({
      code: "computer_target_invalid",
      message: "Computer actions require x/y coordinates or a labelled target.",
    });
  }

  private async resolveCoordinatePoint(target: ComputerTarget): Promise<ComputerPoint> {
    if (target.windowId && hasCoordinates(target)) {
      const window = (await this.readWindows()).find((window) => window.id === target.windowId);
      const bounds = window?.bounds;
      const observed = (target as ComputerTarget & { observedWindowBounds?: ComputerRect })
        .observedWindowBounds;
      if (window && !bounds)
        throw new ComputerTargetError({
          code: "computer_target_offscreen",
          message: "The target window exposes no geometry.",
        });
      if (
        !bounds ||
        (observed &&
          (bounds.x !== observed.x ||
            bounds.y !== observed.y ||
            bounds.width !== observed.width ||
            bounds.height !== observed.height))
      )
        throw new ComputerTargetError({
          code: "computer_target_not_found",
          message:
            "The exact window closed or moved since this screenshot. Observe again before acting.",
        });
      if (
        target.x < bounds.x ||
        target.y < bounds.y ||
        target.x >= bounds.x + bounds.width ||
        target.y >= bounds.y + bounds.height
      )
        throw new ComputerTargetError({
          code: "computer_target_offscreen",
          message: "The coordinate is outside the exact target window.",
        });
      return { x: target.x, y: target.y };
    }
    try {
      return resolveComputerPoint(target, await this.backend.getScreenSize());
    } catch (error) {
      if (!(error instanceof ComputerTargetError) || error.code !== "computer_target_offscreen") {
        throw error;
      }
      const state = await this.backend
        .getState({
          includeTree: true,
          ...(target.windowId ? { windowId: target.windowId } : {}),
        })
        .catch(() => undefined);
      throw new ComputerTargetError({
        code: error.code,
        message: error.message,
        candidates: state?.root ? computerTargetCandidates(state.root) : [],
      });
    }
  }

  /**
   * Checks a scoped coordinate against the window it names, and reports the
   * windows stacked above it that also contain the point.
   *
   * A scoped click is refused rather than redirected. Input is routed to the
   * named window regardless of what covers that coordinate, so a point outside
   * its bounds would deliver a click to a part of the window that does not
   * exist — the one failure mode scoping is meant to remove. The covering list
   * comes from the same window read, so the raise path downstream never has to
   * repeat it.
   */
  private async scopedPointOcclusion(
    point: ComputerPoint,
    windowId: string,
  ): Promise<{
    readonly covering: readonly ComputerWindow[];
    readonly windows: readonly ComputerWindow[];
    readonly ranked: boolean;
  }> {
    const windows = await this.readWindows();
    const window = windows.find((candidate) => candidate.id === windowId);
    if (!window) throw windowNotFoundError(windowId);
    const bounds = window.bounds;
    if (!bounds) {
      // Scoping exists to guarantee the point is inside the named window. A
      // display server with no geometry cannot answer that, and letting the
      // click through unchecked would silently drop the guarantee the caller
      // asked for by passing window_id at all.
      throw new ComputerTargetError({
        code: "computer_target_offscreen",
        message:
          `This desktop reports no geometry for window ${JSON.stringify(windowId)}, so a coordinate ` +
          "cannot be checked against it. Drop window_id to click whatever is topmost at that point, " +
          "or target the control by label instead.",
      });
    }
    if (!rectContainsPoint(bounds, point)) {
      throw new ComputerTargetError({
        code: "computer_target_offscreen",
        message:
          `Computer target (${point.x}, ${point.y}) is outside window ${JSON.stringify(windowId)}, ` +
          `which covers ${bounds.width}x${bounds.height} at (${bounds.x}, ${bounds.y}). ` +
          "Pass a coordinate inside those bounds, or drop window_id to click whatever is topmost.",
      });
    }
    return {
      covering: windowsCoveringPoint(windows, windowId, point),
      windows,
      ranked: window.stackingIndex !== undefined,
    };
  }

  /**
   * Raise before focus: focus alone routes the agent's input to a window that
   * may still be buried, which leaves the human watching clicks land on pixels
   * they cannot see. Both calls are optional so a backend that supports neither
   * keeps working.
   *
   * A raise this desktop cannot perform is not by itself a failed action — the
   * compositor still routes the agent's input to the named window — so it only
   * refuses when a different window really does cover the point, which is the
   * one case where proceeding would deliver the click somewhere the caller did
   * not ask for and could not see coming.
   */
  private async prepareResolvedTarget(
    target: PreparedTarget | undefined,
    threadId: string | undefined,
  ): Promise<void> {
    const windowId = target?.windowId;
    this.spaceBroker.assertTargetBound(agentThreadId(threadId), windowId);
    if (windowId !== undefined) await this.assertWindowInputAllowed(threadId, windowId);
    if (windowId === undefined) {
      assertDesktopOperationActive();
      await this.backend.clearFocusWindow?.();
      return;
    }
    await this.revealTarget(target);
    assertDesktopOperationActive();
    await this.backend.focusWindow?.(windowId);
  }

  /** Restack without changing keyboard aim, including on a hover. */
  private async revealTarget(target: PreparedTarget | undefined): Promise<void> {
    // Cua decides whether exact background delivery is possible. Merely
    // selecting a target never authorizes persistent foreground promotion.
    if (this.backend.agentDialect === "macos") return;
    const windowId = target?.windowId;
    if (windowId === undefined) return;
    assertDesktopOperationActive();
    const raiseFailure = await this.raiseTargetWindow(windowId);
    if (raiseFailure !== undefined && target?.point) {
      const covering = target.covering ?? (await this.coveringWindowsAt(target.point, windowId));
      if (covering.length > 0) {
        throw occludedTargetError(windowId, target.point, covering, raiseFailure);
      }
    }
  }

  /**
   * Points the agent seat's keyboard at a window before a keystroke, or leaves
   * focus alone when the caller named none.
   *
   * Keyboard input carries no coordinate to scope it, so without a window it
   * lands wherever the seat's focus already is — usually where the last click
   * put it, which is what a click-then-type sequence depends on. Focus is
   * therefore never cleared here; only an explicit window moves it, and a stale
   * id fails before any key is sent rather than typing into another application.
   */
  private async prepareKeyboardTarget(
    windowId: string | undefined,
    threadId: string | undefined,
  ): Promise<void> {
    this.spaceBroker.assertTargetBound(agentThreadId(threadId), windowId);
    if (windowId === undefined) return;
    const windows = await this.readWindows();
    const window = windows.find((candidate) => candidate.id === windowId);
    if (window === undefined) {
      throw windowNotFoundError(windowId);
    }
    if (this.canUseBackgroundTarget()) {
      await this.admitWindowTarget(threadId, window);
      return;
    }
    await this.prepareResolvedTarget({ windowId }, threadId);
  }

  /**
   * The dispatch every focused-window keyboard action shares: aim the agent
   * seat's keyboard at the named window (or leave it where the last action
   * put it), prove the operation is still live, then inject and hand back
   * the backend's own result. Type, key press, hotkey and paste differ only
   * in the call each carries.
   */
  private async runKeyboardDispatch(
    threadId: string | undefined,
    windowId: string | undefined,
    dispatch: () => Promise<ComputerBackendActionResult | void>,
  ): Promise<ComputerBackendActionResult | void> {
    await timedComputerLeg("resolve", () => this.prepareKeyboardTarget(windowId, threadId));
    assertDesktopOperationActive();
    return timedComputerLeg("dispatch", dispatch);
  }

  /**
   * The resolve-and-aim every element-grain mutation shares: the target is
   * resolved from fresh state, or keeps an observed ref's native identity for
   * the backend to revalidate. The point gets the same focus aim a click would, and the
   * operation must still be live before anything dispatches. Set-value,
   * perform-action and select-text differ only in the call each carries
   * afterward — and in whether a window-only target may name the sole
   * writable control.
   */
  private async prepareSemanticDispatch(
    target: ComputerTarget,
    threadId: string | undefined,
    allowUniqueTextTarget = false,
  ): Promise<ComputerResolvedTarget> {
    const resolved = await timedComputerLeg("resolve", () =>
      this.resolveSemanticTarget(target, allowUniqueTextTarget),
    );
    if (this.canUseBackgroundTarget() && target.windowId) {
      await this.assertWindowInputAllowed(threadId, target.windowId);
    } else {
      await timedComputerLeg("resolve", () =>
        this.prepareResolvedTarget(semanticPointTarget(resolved), threadId),
      );
    }
    assertDesktopOperationActive();
    return resolved;
  }

  /** The restack, or the reason this desktop did not perform one. */
  private async raiseTargetWindow(windowId: string): Promise<string | undefined> {
    const raise = this.backend.raiseWindow?.bind(this.backend);
    if (!raise) return "this backend exposes no stacking control";
    try {
      await raise(windowId);
      return undefined;
    } catch (error) {
      return errorMessage(error);
    }
  }

  /**
   * Runs a pointer injection that named a window, and replaces the desktop's
   * bare refusal with something the caller can act on.
   *
   * The compositor refuses instead of retargeting, so a refusal is the one
   * failure that guarantees nothing was delivered — worth saying, because the
   * caller's alternative reading is that the control is broken. It reports only
   * which call it declined, so the cause has to be supplied here.
   */
  private async injectScoped<T>(
    action: string,
    target: PreparedTarget,
    inject: () => Promise<T>,
  ): Promise<T> {
    try {
      assertDesktopOperationActive();
      // The new-window baseline is taken here — after targeting, immediately
      // before inject — rather than only at lease claim: the targeting reads
      // above refreshed the window cache, so diffing against anything older
      // would report windows this action never opened. The claim-time baseline
      // stays as the fallback for inputs that never pass through here.
      if (this.lastKnownWindowIds !== undefined) {
        this.preActionWindowIds = this.lastKnownWindowIds;
      }
      return await timedComputerLeg("dispatch", inject);
    } catch (error) {
      const windowId = target.windowId;
      const point = target.point;
      if (windowId === undefined || !point) throw error;
      if (!(error instanceof ComputerBackendError) || error.rejectedOperation === undefined) {
        throw error;
      }
      throw refusedInjectionError(action, windowId, point);
    }
  }

  private async coveringWindowsAt(
    point: ComputerPoint,
    windowId: string,
  ): Promise<readonly ComputerWindow[]> {
    const windows = await this.readWindows().catch(() => []);
    return windowsCoveringPoint(windows, windowId, point);
  }

  private async resolveSemanticTarget(
    target: ComputerTarget,
    allowUniqueTextTarget = false,
  ): Promise<ComputerResolvedTarget> {
    const unnamedTarget = target.label === undefined && target.role === undefined;
    // Without a label or role the query matches every control in scope, and
    // the ambiguity refusal that follows would dump the whole tree at the
    // caller. Refuse up front, before paying for the accessibility walk, with
    // what is actually missing.
    if (unnamedTarget && (!allowUniqueTextTarget || !target.windowId)) {
      throw new ComputerTargetError({
        code: "computer_target_invalid",
        message:
          "This target does not name a control: window_id or coordinates alone match everything in scope. " +
          "Pass label (optionally with role and window_id) to pick a control, or use x/y coordinates " +
          "with the pointer tools. Only computer_scroll takes window_id alone, scrolling that window itself.",
      });
    }
    // A semantic resolve walks the accessibility tree before any input check
    // runs, and a denied app's tree is itself refused — ambiguity and
    // not-found errors otherwise carry its labels back as candidates. macOS
    // only answers scoped trees, so an unscoped walk there is already empty;
    // a desktop-wide tree on other dialects refuses while a denied window is
    // visible.
    if (target.windowId !== undefined) {
      await this.assertWindowContentAllowed(target.windowId);
    } else if (this.agentDialect !== "macos") {
      const denied = await this.deniedVisibleWindow();
      if (denied) throw new ComputerDenylistError(denied.match.app, denied.match.matched);
    }
    const observedNode = observedComputerTargetNode(target);
    if (observedNode) {
      if (!observedNode.windowId || observedNode.windowId !== target.windowId) {
        throw new ComputerTargetError({
          code: "computer_target_invalid",
          message: "The observed element and target name different windows; nothing was sent.",
        });
      }
      // The backend revalidates this original native token's window ancestry
      // and freshness at dispatch. Re-resolving a label/ordinal here could
      // silently give a stale ref the token of a different control.
      return { target, node: observedNode, point: activationPointForNode(observedNode) };
    }
    let state = await this.backend.getState({
      includeTree: true,
      reuseRecentTree: true,
      ...(target.windowId ? { windowId: target.windowId } : {}),
    });
    if (!state.root) {
      throw new ComputerTargetError({
        code: "computer_target_not_found",
        message: "Computer accessibility state did not include a target tree.",
        notFound: true,
      });
    }
    const resolve = (root: NonNullable<ComputerState["root"]>): ComputerResolvedTarget => ({
      target,
      ...(unnamedTarget
        ? resolveComputerUniqueTextTarget(root, target.windowId!, allowUniqueTextTarget)
        : resolveComputerSemanticTarget(root, target, allowUniqueTextTarget)),
    });
    try {
      return resolve(state.root);
    } catch (error) {
      // A tree served from the recent cache can miss a control that only just
      // appeared. Pay for one fresh walk before declaring it absent; on a
      // genuinely-missing target the extra walk is a rare error-path cost.
      // Other failure shapes (ambiguity, bad target) retrying cannot fix.
      if (error instanceof ComputerTargetError && error.code === "computer_target_not_found") {
        state = await this.backend.getState({
          includeTree: true,
          ...(target.windowId ? { windowId: target.windowId } : {}),
        });
        try {
          if (state.root) return resolve(state.root);
        } catch (freshError) {
          // The miss is confirmed against fresh state; report its candidates.
          if (freshError instanceof ComputerTargetError) error = freshError;
        }
      }
      // A truncated tree may simply not contain the control: name the narrow
      // query so the miss is recoverable instead of a dead end.
      if (
        error instanceof ComputerTargetError &&
        error.code === "computer_target_not_found" &&
        state.root?.truncated === true
      ) {
        throw new ComputerTargetError({
          code: error.code,
          message: `${error.message} The accessibility tree was truncated; use computer_get_state with label_contains to narrow the list and check whether the control is present.`,
          candidates: error.candidates,
          notFound: true,
        });
      }
      throw error;
    }
  }

  /**
   * The window id is the one targeting resolved, so the result reports where
   * input was routed; a backend that reports its own window id wins, being
   * closer to what actually happened.
   */
  private actionResult(
    threadId: string | undefined,
    action: string,
    point: ComputerPoint | undefined,
    result: ComputerBackendActionResult | void,
    windowId?: string,
  ): ComputerActionResult {
    const merged = computerBackendActionResult(this.computerId, action, {
      ...(point ? { point } : {}),
      ...(windowId !== undefined ? { windowId } : {}),
      ...(result === undefined ? {} : result),
    });
    // The verdict rides on the call context: the post-action observer reads
    // it for the conditional-settle waiver, and the timing line takes the
    // operation's name.
    const call = currentComputerCall();
    call?.timing?.setOperation(action);
    call?.recordActionProof(result);
    this.emitAction(threadId, action, merged);
    // The pane's agent-cursor dot is fed from here, the one funnel every
    // pointer action passes through: without it the field stayed declared but
    // never assigned, and the overlay never rendered.
    const attributed = agentThreadId(threadId);
    const state = attributed ? this.threads.get(attributed) : undefined;
    if (attributed && state && merged.point) {
      state.cursor = merged.point;
      this.publishCached(attributed);
    }
    return merged;
  }

  /**
   * Desktop activity is attributed to the thread that drove it so an observer
   * can tell one agent's work from another's. Pane input carries no thread and
   * stays unattributed rather than borrowing an unrelated thread id.
   */
  private emitAction(
    threadId: string | undefined,
    action: string,
    result?: ComputerActionResult,
  ): void {
    const attributed = agentThreadId(threadId);
    if (attributed) this.surfacePaneForAgent(attributed);
    this.emit({
      type: "computer.action",
      ...(result?.windowId ? { windowId: result.windowId } : {}),
      ...(result?.delivery ? { delivery: result.delivery } : {}),
      action,
      ok: true,
      ...(attributed ? { threadId: ThreadId.makeUnsafe(attributed) } : {}),
    });
  }

  /**
   * Put the desktop in front of the user the moment an agent starts driving it.
   * Emitted before the action event so the pane is already opening when the
   * first attributed action reaches the store. Mirrors
   * DeviceManager.requestOpenPane; see paneSurfaced for the once-per-thread
   * rule. The request is emitted on visible-desktop backends too — the client
   * gates the actual opening on its auto-open preference, and there the pane
   * renders stills only.
   *
   * The runtime record is still created in that case, before the decision: it
   * is what carries this thread's activity count and last error, and a thread
   * that drives the desktop needs one whether or not a pane is opened for it.
   */
  private surfacePaneForAgent(threadId: string): void {
    // A removed thread must not resurrect: an action resolving after the
    // thread's deletion would otherwise recreate its runtime record and emit
    // pane requests for a thread that no longer exists.
    if (this.suspendedThreads.has(threadId)) return;
    const state = this.threadRuntime(threadId);
    if (state.paneSurfaced) return;
    state.paneSurfaced = true;
    // Emitted for visible-desktop backends too: the client gates the actual
    // opening on its auto-open preference, and on a shared display the pane
    // renders stills only — watching the agent's captured view inside the app
    // is the point of the preview.
    this.emit({
      type: "computer.open-pane-requested",
      threadId: ThreadId.makeUnsafe(threadId),
    });
  }

  /**
   * Serializes publishes per thread. Two overlapping publishes read the same
   * state, each bump `version`, and both emit — the second overwriting the
   * first with a *newer* version number but identical or older content, which
   * is how duplicate versions leaked to the pane. Chaining makes each publish
   * see its predecessor's state.
   */
  private publishCached(threadId: string): ThreadComputerState | undefined {
    const state = this.threads.get(threadId);
    if (!state || this.disposed) return undefined;
    state.version = ++this.nextStateVersion;
    const snapshot = this.threadSnapshot(threadId, state);
    state.reportedError = null;
    this.emit({ type: "computer.thread-state", state: snapshot });
    return snapshot;
  }

  private async publish(threadId: string): Promise<ThreadComputerState | undefined> {
    const previous = this.publishChains.get(threadId) ?? Promise.resolve();
    const next = previous.then(() => this.publishNow(threadId));
    const settled = next.catch(() => undefined);
    this.publishChains.set(threadId, settled);
    try {
      return await next;
    } finally {
      if (this.publishChains.get(threadId) === settled) this.publishChains.delete(threadId);
    }
  }

  private async publishNow(threadId: string): Promise<ThreadComputerState | undefined> {
    const state = this.threads.get(threadId);
    if (!state) return undefined;
    try {
      if (!this.physicalState && !this.physicalFailure) await this.refreshPhysicalState();
      if (this.physicalFailure) throw new Error(this.physicalFailure);
      const physical = this.physicalState;
      if (physical) {
        state.availability = physical.availability;
        if (physical.windows) state.windows = physical.windows;
        if (physical.screenSize) state.screenSize = physical.screenSize;
      }
      state.lastError = null;
    } catch (error) {
      // Error text the backend does not control, so it meets the contract's
      // bound here rather than failing the state payload that carries it.
      state.lastError = clampComputerMessage(
        errorMessage(error),
        "The computer backend reported an error without a message.",
      );
    }
    if (this.disposed || this.threads.get(threadId) !== state) return undefined;
    state.version = ++this.nextStateVersion;
    const snapshot = this.threadSnapshot(threadId, state);
    // A reported error lands in exactly one publish — the panel keeps it
    // until the next refresh supersedes it, not forever.
    state.reportedError = null;
    this.emit({ type: "computer.thread-state", state: snapshot });
    return snapshot;
  }

  private async publishAllThreads(): Promise<void> {
    await this.refreshPhysicalState();
    this.publishAllDepth += 1;
    try {
      for (const threadId of this.threads.keys()) await this.publish(threadId);
    } finally {
      this.publishAllDepth -= 1;
      if (this.publishAllDepth === 0 && this.windowsPublishPending) {
        this.windowsPublishPending = false;
        this.scheduleWindowsPublish();
      }
    }
  }

  /**
   * Queue one republish for a window change, coalescing everything that arrives
   * before it runs — including the changes this pass's own window reads report,
   * which is the loop that made this necessary. A pass already running never
   * starts a second one on top of itself; it re-arms the timer on the way out.
   */
  private scheduleWindowsPublish(): void {
    if (this.disposed) return;
    if (this.publishAllDepth > 0) {
      this.windowsPublishPending = true;
      return;
    }
    if (this.windowsPublishTimer !== undefined) return;
    this.windowsPublishTimer = setTimeout(() => {
      this.windowsPublishTimer = undefined;
      if (this.disposed) return;
      void this.publishAllThreads().catch(() => undefined);
    }, this.windowsPublishDebounceMs);
    this.windowsPublishTimer.unref?.();
  }

  /**
   * Republish every thread from cached state. A backend health transition
   * changes what a panel must show but nothing the backend could tell us, and
   * querying it from the handler of the supervision loop's own event would put
   * a D-Bus round trip — and another connect attempt — on every failure the
   * loop reports, which is how a reconnect turns into a storm.
   */
  private republishAllThreads(): void {
    if (this.disposed) return;
    for (const [threadId, state] of this.threads) {
      state.version = ++this.nextStateVersion;
      this.emit({
        type: "computer.thread-state",
        state: this.threadSnapshot(threadId, state),
      });
    }
  }

  /**
   * A runtime record that is not registered — for reads of a thread that has
   * no live state, where inserting one would resurrect it.
   */
  private newThreadRuntime(): ThreadComputerRuntimeState {
    return {
      version: ++this.nextStateVersion,
      lastError: null,
      reportedError: null,
      windows: [],
      screenSize: { width: 1, height: 1 },
      availability: {
        kind: "backend-unavailable",
        message: "Computer state has not been queried yet",
      },
      paneSurfaced: false,
    };
  }

  private threadRuntime(threadId: string): ThreadComputerRuntimeState {
    let state = this.threads.get(threadId);
    if (!state) {
      state = this.newThreadRuntime();
      this.threads.set(threadId, state);
    } else {
      this.threads.delete(threadId);
      this.threads.set(threadId, state);
    }
    for (const [id, candidate] of this.threads) {
      if (this.threads.size <= 256) break;
      if (
        id === threadId ||
        id === this.lease?.threadId ||
        this.agentCallsInFlight.has(id) ||
        this.publishChains.has(id) ||
        candidate.paneSurfaced ||
        candidate.inputPause
      )
        continue;
      this.threads.delete(id);
      this.threadLabels.delete(id);
    }
    return state;
  }

  private threadSnapshot(threadId: string, state: ThreadComputerRuntimeState): ThreadComputerState {
    const backgroundOwners = new Set(
      [...this.backgroundLeases.values()].map((lease) => lease.threadId),
    );
    const controlOwner =
      this.lease?.threadId ?? (backgroundOwners.has(threadId) ? threadId : undefined);
    return {
      threadId: ThreadId.makeUnsafe(threadId),
      controlGeneration: this.controlState.get(threadId).generation,
      version: state.version,
      computerId: this.computerId,
      windows: state.windows,
      screenSize: state.screenSize,
      ...(state.cursor ? { cursor: state.cursor } : {}),
      agentActive: (this.agentCallsInFlight.get(threadId) ?? 0) > 0,
      ...(this.activity && this.lease?.threadId === threadId ? { activity: this.activity } : {}),
      ...(state.inputPause ? { inputPause: state.inputPause } : {}),
      controlledByOtherThread: this.lease !== null && this.lease.threadId !== threadId,
      ...(backgroundOwners.size > 1 ? { sharedPreviewUnavailable: true } : {}),
      ...(controlOwner
        ? {
            controlOwnerThreadId: ThreadId.makeUnsafe(controlOwner),
            controlOwnerLabel: (this.threadLabels.get(controlOwner) ?? "Agent").slice(0, 512),
          }
        : {}),
      availability: this.correctedAvailability(state.availability),
      health: this.backendHealth,
      capabilities: this.backendCapabilities,
      lastError: state.reportedError ?? state.lastError,
    };
  }

  /**
   * The last availability read, corrected by live backend health. The cached
   * value is whatever the last successful query said, so without this a panel
   * keeps being told the desktop is available while the supervision loop is
   * still trying to get it back. Only a claim of `available` is overridden:
   * anything already blocked carries its own, better explanation — the platform
   * it is running on, or the plugin it could not load.
   */
  private correctedAvailability(availability: ComputerAvailability): ComputerAvailability {
    // A backend nobody has asked to connect is not disconnected, it is idle, and
    // health says "unavailable" for both. Correcting against it before the first
    // real use would report every KDE desktop as broken until someone clicked
    // something — the exact opposite of what the probe is there to say.
    if (!this.backendEngaged) return availability;
    if (this.backendHealth.status === "connected" || availability.kind !== "available") {
      return availability;
    }
    return {
      kind: "backend-unavailable",
      message: healthUnavailableMessage(this.backendHealth),
    };
  }

  private isStreamWanted(epoch: number): boolean {
    return (
      !this.disposed &&
      this.streamDesired &&
      this.streamEpoch === epoch &&
      this.transport.streamSubscriberCount(this.computerId) > 0
    );
  }

  private recordError(error: unknown): void {
    const message = clampComputerMessage(
      errorMessage(error),
      "The computer backend reported an error without a message.",
    );
    for (const state of this.threads.values()) state.reportedError = message;
    // Written without a publish, a stream attach failure never reached the
    // panel it explains. Debounced, because this can fire per frame or per
    // call during an outage.
    if (this.threads.size === 0) return;
    this.errorRepublishTimer ??= setTimeout(() => {
      this.errorRepublishTimer = undefined;
      for (const threadId of this.threads.keys()) {
        void this.publish(threadId).catch(() => undefined);
      }
    }, COMPUTER_ERROR_REPUBLISH_DEBOUNCE_MS);
    this.errorRepublishTimer.unref?.();
  }

  private emit(event: ComputerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // One observer cannot stop the remaining observers.
      }
    }
  }
}

/**
 * The default travel measurement: decode both captures and correlate them. Both
 * halves already answer with undefined for anything they cannot handle, so a
 * capture in a format this does not decode costs the measurement, not the
 * scroll.
 */
async function measureScrollTravelFromPng(
  before: Uint8Array,
  after: Uint8Array,
): Promise<number | undefined> {
  const [decodedBefore, decodedAfter] = await Promise.all([
    decodePngLuma(before),
    decodePngLuma(after),
  ]);
  if (!decodedBefore || !decodedAfter) return undefined;
  return estimateVerticalTravel(decodedBefore, decodedAfter);
}

/** Scroll telemetry is a reading, not a measurement instrument: two decimals is all it means. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Whether a `waitForSettle` failure means this backend can never answer it.
 * Only the two name-resolution refusals count: a driver older than the
 * observer revision reports "Unknown tool: …", and a desktop host whose
 * allowlist predates it throws "Unsupported computer host request." Neither
 * can change for the backend's life, so the refusal is cached. Anything else
 * — a stale window id, a retired generation, a transport failure — is a
 * transient miss this one action falls back from and the next may retry.
 */
function settlePermanentlyUnsupported(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return message.startsWith("Unknown tool:") || message === "Unsupported computer host request.";
}

/**
 * The caller as an agent thread, or undefined for desktop input that belongs to
 * no thread — the human at the computer pane. Attribution and the desktop lease
 * must agree on who that is, so both read it here.
 */
function windowIdSet(windows: readonly ComputerWindow[]): ReadonlySet<string> {
  return new Set(windows.map((window) => window.id));
}

/** Rectangle intersection in the desktop's global coordinate space. */
function rectsOverlap(first: ComputerRect, second: ComputerRect): boolean {
  return (
    first.x < second.x + second.width &&
    second.x < first.x + first.width &&
    first.y < second.y + second.height &&
    second.y < first.y + first.height
  );
}

function agentThreadId(threadId: string | undefined): string | undefined {
  const trimmed = threadId?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Why a healthy-looking availability is being withheld. The failure text comes
 * from the display server, so the whole message is clamped rather than only the
 * part this composes.
 */
function healthUnavailableMessage(health: ComputerHealth): string {
  const reason =
    health.status === "reconnecting"
      ? "Reconnecting to the desktop."
      : "The desktop backend is not connected.";
  return clampComputerMessage(
    health.lastFailure ? `${reason} Last failure: ${health.lastFailure.message}` : reason,
    reason,
  );
}

function windowNotFoundError(windowId: string): ComputerTargetError {
  return new ComputerTargetError({
    code: "computer_target_not_found",
    message:
      `No desktop window has id ${JSON.stringify(windowId)}. ` +
      "Call computer_list_windows for the current window ids.",
    notFound: true,
  });
}

/**
 * Refusal for an app-named menu target the running inventory does not know.
 * The name may be a bundle id or a display name, so the message names both
 * spellings the caller can check against computer_list_apps.
 */
function menuAppNotFoundError(app: string): ComputerTargetError {
  return new ComputerTargetError({
    code: "computer_target_not_found",
    message:
      `No running application matches ${JSON.stringify(app)}. ` +
      "Call computer_list_apps for the running apps and their pids, then name one by app or pid.",
    notFound: true,
  });
}

/**
 * The raise/focus target for a control resolved through the accessibility tree.
 * The point comes along so a failed raise is still checked for occlusion:
 * nothing consulted the stacking order while matching the label, and the click
 * that follows is as misroutable as any other.
 */
function semanticPointTarget(resolved: ComputerResolvedTarget): PreparedTarget {
  return {
    point: resolved.point,
    ...(resolved.node.windowId ? { windowId: resolved.node.windowId } : {}),
  };
}

/**
 * Refusal for a scoped action whose window is covered at the point and could
 * not be raised out from under the windows covering it.
 *
 * Refusing beats warning. The input would land in another application, and a
 * warning read after the fact cannot undo a click that already fired — the live
 * failure this exists for was a model clicking a buried window repeatedly and
 * concluding the button was broken. The message names what is in the way and
 * both ways out, so the next call is a correct one rather than a retry.
 */
function occludedTargetError(
  windowId: string,
  point: ComputerPoint,
  covering: readonly ComputerWindow[],
  reason: string,
): ComputerTargetError {
  const blockers = covering
    .slice(0, 4)
    .map((window) => `${JSON.stringify(window.title || window.id)} (${window.id})`)
    .join(", ");
  return new ComputerTargetError({
    code: "computer_target_occluded",
    message:
      `Window ${JSON.stringify(windowId)} is covered at (${point.x}, ${point.y}) by ${blockers}, ` +
      `and this desktop could not raise it: ${reason}. The input would go to the covering window. ` +
      "Aim at a part of the target window that nothing covers, or move the covering window out of " +
      "the way first; or drop window_id to act on whatever is topmost at that point.",
  });
}

/**
 * Refusal for a scoped pointer action the desktop declined to deliver.
 *
 * A coordinate is validated against the window's frame, which includes the
 * invisible resize and shadow margins around it, so a point can sit inside
 * those bounds and still be outside the region the window accepts input in.
 * The window may equally have closed since it was listed. Either way the
 * remedy is the same, and it is not retrying the identical coordinate.
 */
function refusedInjectionError(
  action: string,
  windowId: string,
  point: ComputerPoint,
): ComputerTargetError {
  return new ComputerTargetError({
    code: "computer_target_refused",
    message:
      `The desktop refused to deliver ${action} to window ${JSON.stringify(windowId)} at ` +
      `(${point.x}, ${point.y}), so no input was sent. The window is not accepting input at that ` +
      "point: a window's bounds include invisible resize and shadow margins, and the window may " +
      "also have closed since it was listed. Aim nearer the middle of the control, target it by " +
      "label instead of a coordinate, or drop window_id to act on whatever is topmost there.",
  });
}

function tripleClickUnsupportedError(): ComputerBackendError {
  return new ComputerBackendError(
    "This desktop backend cannot send a triple click. Select the line another way — " +
      "click at its start and shift-click at its end, or use the application's own " +
      "select-all shortcut with computer_press_key.",
  );
}

/**
 * The click combinations the driver has no dispatch for at all — a middle
 * button, or a right button pressed more than once. Named in the refusal so
 * the model can pick a supported gesture instead of retrying.
 */
function clickGestureUnsupportedError(
  button: "right" | "middle",
  count: 1 | 2 | 3,
): ComputerBackendError {
  return new ComputerBackendError(
    `This desktop backend cannot send a ${button} click with count ${count}. ` +
      "Supported gestures are a left click with count 1-3 and a single right click.",
  );
}

function activationUnsupportedError(): ComputerBackendError {
  return new ComputerBackendError(
    "This desktop backend cannot bring a window forward. Ask the user to click the window " +
      "they want in front, or aim the action at it with window_id instead.",
  );
}

function clipboardUnsupportedError(): ComputerBackendError {
  return new ComputerBackendError("This computer backend does not support clipboard access.");
}

function hasCoordinates(target: ComputerTarget): target is ComputerTarget & ComputerPoint {
  return typeof target.x === "number" && typeof target.y === "number";
}

/** Fields that only the accessibility tree can resolve. */
function hasLabelFields(target: ComputerTarget): boolean {
  return target.label !== undefined || target.role !== undefined;
}

function hasSemanticFields(target: ComputerTarget): boolean {
  return hasLabelFields(target) || target.windowId !== undefined;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ComputerBackendError || error instanceof ComputerTargetError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Bounds one enable-path wait. Rejects past the timeout while leaving the
 * raced promise alone: the caller throws with the in-memory gate still held,
 * which is the fail-closed outcome the enable path depends on.
 */
function withControlEnableTimeout<A>(action: Promise<A> | undefined): Promise<A | undefined> {
  if (action === undefined) return Promise.resolve(undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new ComputerBackendError(
          "Enabling computer control timed out; control stays disabled for this conversation.",
        ),
      );
    }, COMPUTER_CONTROL_ENABLE_TIMEOUT_MS);
    timer.unref?.();
  });
  return Promise.race([action, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * The disable/removal/dispose side of the same bound: a wedged native call
 * wedges the operation tail, and without a deadline every teardown that
 * waits on it hangs forever — the in-memory gates are already held, so the
 * bounded wait can only lose cleanup confirmation, never authority.
 */
function withControlTeardownTimeout<A>(action: Promise<A>): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new ComputerBackendError(
          "Computer control teardown timed out waiting on a wedged operation; the in-memory gate stays held.",
        ),
      );
    }, COMPUTER_CONTROL_ENABLE_TIMEOUT_MS);
    timer.unref?.();
  });
  return Promise.race([action, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
