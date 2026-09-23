import { MODEL_SCREEN_IMAGE_MAX_DIMENSION } from "@synara/shared/modelImageBudget";
import {
  COMPUTER_DELIVERY_PATH_MAX_LENGTH,
  COMPUTER_MESSAGE_MAX_LENGTH,
  type ComputerAccessibilityTreeApp,
  type ComputerAccessibilityTreeWindow,
  type ComputerActionResult,
  type ComputerApp,
  type ComputerAvailability,
  type ComputerBuildSignature,
  type ComputerCapabilities,
  type ComputerCursorPosition,
  type ComputerDeliveryVerification,
  type ComputerFrameMimeType,
  type ComputerHealth,
  type ComputerId,
  type ComputerInputModifier,
  type ComputerInputPause,
  type ComputerLaunchAppResult,
  type ComputerPermission,
  type ComputerPoint,
  type ComputerRect,
  type ComputerScreenSize,
  type ComputerSpaceInventory,
  type ComputerScreenshot,
  type ComputerState,
  type ComputerTarget,
  type ComputerUiNode,
  type ComputerVerifyStateResult,
  type ComputerWindow,
  type ComputerZoomResult,
} from "@synara/contracts";

/**
 * The longest side, in pixels, of any screenshot handed to a model.
 *
 * This is a correctness bound before it is a cost one. Vision APIs downscale an
 * image whose long edge exceeds roughly 1568 px before the model ever sees it,
 * and the model then reads coordinates off a picture the server never produced:
 * at the old 2048 budget every pixel the model pointed at was mapped against an
 * image 1.33x larger than the one it looked at, so every click landed short and
 * consistently up-and-left. Nothing in this pipeline may depend on API-side
 * resizing — Synara does the downscale itself, records the resulting frame, and
 * maps the model's pixels through the frame it actually delivered.
 *
 * 1536 rather than something smaller because image tokens scale with area and
 * the temptation is to shrink hard: a 1024 budget did save tokens, but it lost
 * the precision needed to read a dense form or aim at a small field, and the
 * cost came back as mis-aimed clicks and extra re-screenshots that were slower
 * and more expensive than the shot they replaced. At 1536 a browser or editor
 * window comes back at full resolution, only a genuinely large capture is
 * scaled, and the real savings comes from the byte-identical dedupe
 * (`screenshotUnchanged`) that never resends an unchanged frame at all.
 */
export const COMPUTER_AGENT_IMAGE_MAX_DIMENSION = MODEL_SCREEN_IMAGE_MAX_DIMENSION;
/**
 * Longest screenshot side in pixels before a capture is downscaled. Identical
 * to the observation budget, and for the identical reason: both pictures are
 * read by the same eyes and pointed at through the same frame registry.
 */
export const DEFAULT_COMPUTER_CAPTURE_MAX_DIMENSION = COMPUTER_AGENT_IMAGE_MAX_DIMENSION;
/** The budget a post-action observation spends. See the constant above. */
export const COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION = COMPUTER_AGENT_IMAGE_MAX_DIMENSION;
/** Native per-side image limit enforced by the KWin capture path. */
export const MAX_COMPUTER_CAPTURE_MAX_DIMENSION = 16_384;
/**
 * Largest clipboard payload a backend moves in either direction. Clipboards
 * hold whole documents, so both directions need a ceiling: without one a read
 * would stream unbounded data into a turn and a write would pipe it back out.
 */
export const MAX_COMPUTER_CLIPBOARD_BYTES = 1024 * 1024;

/**
 * The id every real desktop backend reports for the one computer it drives.
 *
 * Shared rather than repeated because it is the key the frame socket, the pane,
 * and the thread state all address that desktop by: two backends spelling it
 * differently would route a frame to a pane that is not listening.
 */
export const DEFAULT_COMPUTER_ID = "desktop";

/**
 * Refuses a clipboard write past `MAX_COMPUTER_CLIPBOARD_BYTES`.
 *
 * One check for every backend: the Linux path enforced it and the macOS one did
 * not, so the same document that was refused on one desktop was piped through a
 * line-framed helper on the other.
 */
export function assertComputerClipboardWriteFits(text: string): void {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= MAX_COMPUTER_CLIPBOARD_BYTES) return;
  throw new ComputerBackendError(
    `Clipboard text is ${bytes} bytes, past the ${MAX_COMPUTER_CLIPBOARD_BYTES} byte limit this tool writes.`,
  );
}

/**
 * A zoomed capture request: one window, or one rect of the global desktop
 * coordinate space that window bounds and pointer actions already use.
 */
export type ComputerCaptureRequest =
  | { readonly kind: "window"; readonly windowId: string; readonly maxDimension?: number }
  | { readonly kind: "region"; readonly region: ComputerRect; readonly maxDimension?: number };

/** A single-channel capture; see `ComputerBackend.captureLuma`. */
export interface ComputerLumaCapture {
  readonly width: number;
  readonly height: number;
  /** Row-major, one byte per pixel, no row padding: `width * height` bytes. */
  readonly data: Uint8Array;
  /** Capture pixels per desktop pixel, as on `ComputerScreenshot.scale`. */
  readonly scale: number;
}

export interface ComputerStreamFrame {
  readonly sequence: number;
  readonly timestampMs: number;
  readonly keyframe: boolean;
  readonly codecConfig: boolean;
  readonly data: Uint8Array;
  /**
   * The still's image type, carried to the pane per frame. Absent means PNG.
   * Only the preview may use JPEG: every screenshot a model reads stays PNG.
   */
  readonly mimeType?: ComputerFrameMimeType;
}

export interface ComputerResolvedTarget {
  readonly target: ComputerTarget;
  readonly point: ComputerPoint;
  readonly node: ComputerUiNode;
}

/**
 * An exact character range on a text element's value. `start` is the
 * zero-based character offset and `length` the number of characters —
 * `0` collapses the selection to a caret at `start`. Characters count the
 * same units `AXSelectedTextRange` and a JS string index do, so an element's
 * `value` from get_state is the coordinate space.
 */
export interface ComputerTextRange {
  readonly start: number;
  readonly length: number;
}

/**
 * How a menu invocation names its target.
 *
 * `windowId` keeps the exact-window semantics: one window of the owning app
 * is validated, the focus-sensitive menu state is made ready without raising
 * the app, and the prior key window is restored afterwards. `app`/`pid`
 * select the application-level menu bar — no window is resolved, focused, or
 * raised, which is the only menu route for a running app that has none. The
 * forms are mutually exclusive: a caller names exactly one, and mixing them
 * is refused rather than guessed at.
 */
export type ComputerMenuTarget =
  | { readonly windowId: string }
  | { readonly app: string }
  | { readonly pid: number };

/**
 * What a backend receives: the window form, or the process form the caller
 * (or the manager's app resolution) already settled on. An app name is
 * resolved to a live pid before dispatch, so a backend never has to guess
 * which process a name meant.
 */
export type ComputerMenuBackendTarget = { readonly windowId: string } | { readonly pid: number };

export interface ComputerBackendActionResult {
  readonly point?: ComputerPoint;
  /**
   * Set when the display server refused the requested point and moved the
   * pointer elsewhere, which happens on multi-monitor layouts whose global
   * coordinate space has gaps between outputs.
   */
  readonly clampedTo?: ComputerPoint;
  readonly windowId?: string;
  readonly value?: string;
  /**
   * Which rung of a backend's delivery ladder actually ran, and what the backend
   * could establish about the outcome.
   *
   * The macOS helper answers both for every input it delivers — keyboard and
   * pointer alike — naming the rung it took (`ax-insert`, `keystrokes`,
   * `foreground`, and so on). `verified` is deliberately three-valued:
   * `confirmed` means the effect was read back, `unconfirmed` means the read-back
   * was attempted and did not show it, and `unverifiable` means the surface
   * exposes no readable value to check against — the ordinary answer for most
   * native controls, and not a sign that anything went wrong.
   *
   * `computerBackendActionResult` projects the pair onto the wire result's
   * optional `delivery` (clamping the path there, so every backend that reports
   * one is bounded by the same rule), so the agent reading a tool result sees
   * the verdict too. Backends with no delivery ladder leave both unset and their
   * results are unchanged.
   */
  readonly deliveryPath?: string;
  readonly verified?: ComputerDeliveryVerification;
  readonly effect?: "not-dispatched" | "dispatched-unknown" | "verified";
  /** Native wheel units converted to injected pixel deltas, before app handling. */
  readonly scrollDelta?: { readonly deltaX: number; readonly deltaY: number };
}

export type ComputerBackendEvent =
  | { readonly type: "windows-changed"; readonly windows: readonly ComputerWindow[] }
  | { readonly type: "health-changed"; readonly health: ComputerHealth }
  | { readonly type: "capabilities-changed"; readonly capabilities: ComputerCapabilities }
  /**
   * The host proved a desktop availability interruption — screen lock,
   * system sleep, or a session switch — ran since the previous reply, even
   * when the cycle engaged and released between the two (the host's
   * interruption count advanced). Consent granted before the interruption
   * must not silently authorize the post-interruption desktop: the manager
   * revokes standing task grants on this event so the next mutating call
   * republishes its prompt. Input itself already fails closed at the host —
   * this event is the consent half of the same boundary.
   */
  | {
      readonly type: "desktop-interrupted";
      /**
       * The pause reasons the host reported active at reply time
       * (`"screen-lock"`, `"system-sleep"`, `"user-session"`), already empty
       * when the interruption cycle ended before the reply that carried it.
       */
      readonly pauses: readonly string[];
    }
  /**
   * The desktop this backend was bound to no longer exists and will not come
   * back on its own — the compositor instance it drove exited, as when a
   * Hyprland session ends while the server keeps running. Distinct from a
   * reconnect, which the backend handles itself. The service may re-run
   * backend selection and swap in whatever it picks, except for a backend an
   * explicit override named, which stays and reports. When selection picks
   * the same tier again, nothing is swapped and the event is spent: a backend
   * that emits it therefore owns the retry, and keeps looking for its desktop
   * (at a slow cadence) so one that comes back later is picked up without an
   * agent action. `message` says what was lost.
   */
  | { readonly type: "desktop-gone"; readonly message: string }
  | { readonly type: "frame"; readonly frame: ComputerStreamFrame };

/**
 * What one masked-activation shield should cover. `windowId` is the public
 * window id (e.g. `cua:<pid>:<windowId>`); the backend splits the native ids
 * out of it. `frame` is the window's bounds in screen coordinates at engage
 * time — the caller passes the same listing's rect it validated the window
 * against, rather than letting the backend re-read a moved window.
 * `shieldId` is caller-minted so a lost engage reply still leaves a
 * releasable handle; `label` is painted on the shield as the operator-facing
 * disclosure.
 */
export interface ComputerShieldTarget {
  readonly shieldId: string;
  readonly windowId: string;
  readonly frame: ComputerRect;
  readonly label: string;
}

/**
 * One call into the driver's CDP browser surface. `name` is a driver tool
 * name (see `CUA_BROWSER_TOOLS`), not a gateway name; `args` are the
 * sanitized model arguments — the backend/host layer owns every session,
 * transport, and ownership field. `task` is the trusted local attribution the
 * host turns into a browser lifecycle session label. `mutation` marks calls
 * whose loss mid-dispatch must be reported as an uncertain effect rather than
 * retried.
 */
export interface ComputerBrowserCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly task: { readonly threadId: string; readonly turnId?: string; readonly label?: string };
  readonly mutation: boolean;
  readonly signal: AbortSignal;
}

/**
 * The driver's MCP-shaped reply, carried verbatim: `content` holds text and
 * image parts (browser screenshots are driver-produced, not desktop
 * captures), `structuredContent` carries the browser payload — including
 * `status:"refused"` results, which deliberately keep `isError` unset.
 */
export interface ComputerBrowserCallResult {
  readonly content?: ReadonlyArray<Record<string, unknown>>;
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}

/**
 * The browser half of a desktop backend. Separate from the desktop method
 * set because browser targets are opaque session-scoped capabilities, not
 * `windowId`s, and because a backend can drive a desktop without owning any
 * browser route (or refuse every browser call). Absent means "no browser
 * surface": callers must not advertise the tools.
 */
export interface ComputerBrowserBackend {
  call(call: ComputerBrowserCall): Promise<ComputerBrowserCallResult>;
  /**
   * End every driver browser session attributed to this thread. Called when
   * the thread is removed; the driver also reaps sessions whose transport
   * owner disappears, so this is the explicit form of the same cleanup.
   */
  endThread?(threadId: string): Promise<void>;
}

/** One pending single-use clipboard offer; see `ComputerBackend.writeClipboardForPaste`. */
export interface ComputerClipboardPasteOffer {
  /**
   * Resolves once a paste target has read the payload. Rejects, or never
   * settles, when the offer ended some other way (replaced, the helper died);
   * the manager treats both as "not observed" and falls back to its bound.
   */
  readonly consumed: Promise<void>;
}

export type ComputerFrameListener = (frame: ComputerStreamFrame) => void;
export type ComputerBackendEventListener = (event: ComputerBackendEvent) => void;

export class ComputerBackendError extends Error {
  readonly retryable: boolean;
  /**
   * The failure is a decision, not a fault: the backend's desktop is
   * deliberately not running right now, and only a real use may start it.
   * Automatic supervision that sees this must report the message and stand
   * down, because retrying cannot conjure a desktop the backend refused to
   * boot — and on a backend that boots on demand, a retry that did boot would
   * respawn a window the human just closed.
   */
  readonly dormant: boolean;
  /**
   * The call the desktop declined, when the failure was a refusal rather than a
   * fault. A refusal means nothing was injected, which is what lets a caller
   * explain the miss instead of reporting a generic failure.
   */
  readonly rejectedOperation: string | undefined;
  /**
   * The desktop refused because the OS has not granted Synara a privacy
   * permission it needs — macOS Screen Recording or Accessibility today. Only
   * the backend can tell this apart from an ordinary action failure, so it is
   * marked here rather than guessed from message text further up: the agent
   * gateway turns exactly this flag into the chat's "needs setup" card, and a
   * card raised for a window that merely moved would be noise.
   */
  readonly setupRequired: boolean;
  /** A recoverable input refusal; observation remains available. */
  readonly inputPause: ComputerInputPause | undefined;
  /**
   * The call was refused because the thread's computer control was disabled —
   * the kill switch, not a fault. The audit seam reads this to keep disabled
   * state out of the log: a refusal written while control is off would record
   * attempts the feature was already refusing to make.
   */
  readonly controlRevoked: boolean;

  constructor(
    message: string,
    options: {
      readonly retryable?: boolean;
      readonly dormant?: boolean;
      readonly cause?: unknown;
      readonly rejectedOperation?: string;
      readonly setupRequired?: boolean;
      readonly inputPause?: ComputerInputPause;
      readonly controlRevoked?: boolean;
    } = {},
  ) {
    super(message, options);
    this.name = "ComputerBackendError";
    this.retryable = options.retryable ?? false;
    this.dormant = options.dormant ?? false;
    this.rejectedOperation = options.rejectedOperation;
    this.setupRequired = options.setupRequired ?? false;
    this.inputPause = options.inputPause;
    this.controlRevoked = options.controlRevoked ?? false;
  }
}

/**
 * What a backend that does not exist can do, which is nothing.
 *
 * Used where a state payload has to be produced with no backend behind it — an
 * unsupported host, a service that never started. The alternative is omitting
 * the field, and an absent capability set reads as a fully capable one, which
 * is how a panel ends up offering desktop control on a machine that has none.
 */
export const NO_COMPUTER_CAPABILITIES: ComputerCapabilities = {
  windows: false,
  windowBounds: false,
  stacking: false,
  capture: false,
  input: false,
  clipboard: false,
  focus: false,
  raise: false,
  ghostCursor: false,
  visibleDesktop: false,
};

/**
 * Which desktop vocabulary a backend speaks.
 *
 * Not a platform label for its own sake: three agent-facing descriptions are
 * only true of one family — what a keyboard shortcut may contain, which
 * semantic action names the accessibility layer accepts, and what an
 * application identifier looks like — and describing the other family's answer
 * teaches the model to send calls that are guaranteed to be refused. The tool
 * surface branches on this rather than on a delivery flag that happened to
 * correlate with the platform.
 */
export type ComputerAgentDialect = "linux" | "macos";

/**
 * The two facts about a desktop that the model is told once, at session start,
 * by guidance rendered far from the backend (`agentGateway/computerGuidance.ts`).
 */
export interface ComputerGuidanceProfile {
  readonly dialect: ComputerAgentDialect;
  /** See `ComputerBackend.dedicatedSeat`. */
  readonly dedicatedSeat: boolean;
}

export function computerGuidanceProfile(
  backend: Pick<ComputerBackend, "agentDialect" | "dedicatedSeat">,
): ComputerGuidanceProfile {
  return {
    dialect: backend.agentDialect ?? "linux",
    dedicatedSeat: backend.dedicatedSeat === true,
  };
}

/**
 * Provider-side contract shared by real display backends and the CI fake.
 *
 * Optional members are read by presence, on every use. The manager may be
 * built on a `SwitchableComputerBackend` slot, a Proxy that resolves each
 * member against whichever backend occupies it at that moment, and backends
 * may also expose a member through a getter that comes and goes (a method
 * offered only while the connected desktop supports it). So a caller checks
 * `backend.member !== undefined` where it is about to use the member, never
 * caches the verdict across awaits, and when one use spans awaits, binds the
 * member once and keeps that reference (`backend.member?.bind(backend)`).
 */
export interface ComputerBackend {
  /**
   * The vocabulary this desktop speaks, for the tool descriptions that differ
   * by family. Absent means `"linux"`: the evdev + AT-SPI pair every backend
   * but the macOS one uses.
   */
  readonly agentDialect?: ComputerAgentDialect;
  /**
   * The agent drives this desktop through a seat of its own — a compositor
   * plugin's dedicated seat, or a private compositor — so its input never
   * touches the human's cursor, focus or keystrokes, and it has no browser
   * route. Only the Linux compositor backends set it. Guidance reads it rather
   * than the live capability set because the model is told about its desktop
   * once, at session start, and a backend whose desktop has not booted yet
   * reports no capabilities at all until its first real use. Absent means the
   * desktop is described the way it always was: the Cua host's wording.
   */
  readonly dedicatedSeat?: boolean;
  /**
   * Whether `selectText` can succeed on this desktop. `false` refuses the call
   * in the manager before the lease is claimed and the window restacked and
   * aimed for a dispatch the backend would refuse anyway. Absent means
   * supported.
   */
  readonly textRangeSelection?: boolean;
  readonly computerId: ComputerId;
  /**
   * Whether this host could drive a desktop, answered without doing anything to
   * it. Side-effect-free by contract: no session is started, nothing is
   * installed, nothing is loaded into a compositor, and no connection outlives
   * the call — the most a backend may spend is the cheap questions a desktop
   * answers for free, such as who owns a bus name and what is on disk.
   *
   * This is what boot and the UI's thread-state seeding read, because both run
   * for every user on every launch, long before anyone has asked for a desktop.
   * `availability()` is the opposite trade: it establishes the real thing and
   * reports what actually happened, so it belongs only on paths that were about
   * to use the desktop anyway.
   *
   * Optimism is the intended failure mode. A probe that says "available" and
   * then cannot provision costs the caller one actionable error card at first
   * use; a probe that says "unavailable" because it refused to look costs the
   * user the feature.
   */
  probeAvailability(): Promise<ComputerAvailability>;
  /**
   * The passive status read, for a backend whose desktop boots on demand and
   * must not be respawned by a status poll.
   *
   * `ComputerManager.getStatus` answers the settings screen's ten-second poll
   * from `availability({ refresh: true })` once something real has engaged
   * the backend, which is right for a desktop that is always there: the read
   * reports what it finds. A backend that starts a private compositor on first
   * use cannot afford it — the poll would boot a desktop nobody asked for, and
   * re-boot the one the human just closed. Such a backend implements this to
   * report the last established state without touching the desktop, and the
   * manager uses it for every status read, before and after engagement; the
   * desktop starts again on the next real use or from Set up. Absent means
   * `availability()` is safe to poll.
   */
  statusAvailability?(): Promise<ComputerAvailability>;
  /**
   * Availability as established, not as guessed: this may connect, install, and
   * load whatever the backend needs, so it belongs on paths that are about to
   * use the desktop. See `probeAvailability` for the passive counterpart.
   * `refresh` bypasses an established snapshot for explicit status/grant updates.
   */
  availability(options?: { readonly refresh?: boolean }): Promise<ComputerAvailability>;

  /**
   * Install or compile whatever this backend needs, on explicit request.
   *
   * Optional because not every backend has anything to provision: the fake and
   * the unavailable backends have nothing, and a nested session's compositor
   * arrived with its own. A backend that implements it returns one sentence
   * describing what it did, for the settings card that asked.
   */
  provision?(): Promise<string>;
  /**
   * Live supervision health. Synchronous and side-effect free on purpose: it
   * reports what the connect and reconnect paths already know, so reading it
   * can never cost the display server a round trip, and it stays safe to call
   * from the handler of the very event that changed it. Transitions arrive
   * through `onEvent` as `health-changed`.
   */
  health(): ComputerHealth;
  /**
   * What this backend can do once it is up. Synchronous and cheap by contract:
   * a capability is a property of the display server this process talks to, not
   * a live reading, so it is safe to publish with every state snapshot.
   *
   * Two things it deliberately is *not*. It is not a permission report: an OS
   * grant the user has withheld leaves the capability true and shows up in
   * `probeAvailability()` (`permission-required`) or, for screen capture, in
   * `health().captureAvailable` — the macOS backend advertises the full set on
   * a Mac that has granted it nothing. And it is not a live reading of the
   * running session: only the nested backend varies it at all, reporting the
   * empty set until its compositor and plugin exist so the settings panel can
   * offer Set up, and the full KWin set afterwards. That one transition arrives
   * through `onEvent` as `capabilities-changed`, so a caller may cache this
   * until the event fires.
   */
  capabilities(): ComputerCapabilities;
  /**
   * OS privacy grants this backend needs and does not have, established rather
   * than remembered.
   *
   * Asynchronous because the answer is only allowed to be stale in one
   * direction. The tool surface consults this after every computer call to
   * decide whether the user is owed a setup card, and the moment that matters
   * most is the one just after the user granted something: a cached "missing"
   * kept the card and the model's refusal on screen while the grant was already
   * live, which is the exact failure this signature exists to prevent. A backend
   * that knows nothing is missing answers from memory and costs nothing; one
   * whose last look saw a gap has to look again (behind its own short cache, so
   * a burst of calls still pays for one probe).
   *
   * Empty means either "nothing is missing" or "nothing has looked yet" — both
   * are states in which no user action is owed, so they need not be told apart
   * here.
   *
   * Optional because only macOS has a permission model at all; a backend that
   * omits it is read as missing nothing. `availability()` reports the *blocking*
   * subset of this as `permission-required`; a grant that only degrades the
   * desktop (Screen Recording) shows up here and nowhere else.
   */
  missingPermissions?(): Promise<readonly ComputerPermission[]>;
  /**
   * How this build is code-signed, as the last probe read it, or undefined when
   * nothing has looked yet or the backend has no permission model.
   *
   * Synchronous and free: it is a property of the binary, not a live reading.
   * It travels beside `missingPermissions()` because a missing grant on an
   * ad-hoc build has a second, invisible explanation — the grant is pinned to a
   * cdhash a rebuild replaced — and the card cannot say so without knowing this.
   */
  buildSignature?(): ComputerBuildSignature | undefined;
  listWindows(): Promise<readonly ComputerWindow[]>;
  /** Optional real managed-display inventory, including empty Spaces. Never changes the desktop. */
  listSpaces?(): Promise<ComputerSpaceInventory>;
  getScreenSize(): Promise<ComputerScreenSize>;
  getState(options: {
    readonly includeScreenshot?: boolean;
    /**
     * Walk the accessibility tree and return it as `root`.
     *
     * Named for what it costs rather than for what one caller does with it: the
     * agent tool surface needs the tree on every perception read (that is where
     * the elements list comes from) and the text rendering almost never, and
     * while this flag was called `includeText` every backend rendered the whole
     * desktop to prose on each of those reads and the caller threw it away.
     * Rendering now belongs to `ComputerManager`, which knows whether anyone
     * asked for it.
     */
    readonly includeTree?: boolean;
    readonly windowId?: string;
    /**
     * Internal target resolution may reuse a tree observed moments ago instead
     * of paying for another accessibility walk. The agent-facing state tools
     * never set this: what the model reads must stay fresh. Safe only because
     * dispatch validates the resolved element natively — a stale candidate
     * fails closed rather than acting on a moved control.
     */
    readonly reuseRecentTree?: boolean;
  }): Promise<ComputerState>;
  /**
   * Zoomed perception. `getState` downscales the whole multi-monitor workspace
   * into one screenshot, which loses small text; this captures a single window
   * or region at a far higher effective resolution and returns the same
   * `region` + `scale` mapping so pixels still convert to desktop coordinates.
   */
  captureScreenshot(request: ComputerCaptureRequest): Promise<ComputerScreenshot>;
  /**
   * The same capture as `captureScreenshot(request)`, as raw 8-bit luma instead
   * of an encoded image, for a picture that is only ever measured.
   *
   * Scroll calibration photographs the window before every measured scroll and
   * never shows that frame to anyone; encoding it to PNG, base64-encoding it
   * and decoding it back costs more than the correlation it feeds. A backend
   * that can hand back pixels implements this and the manager uses it for that
   * baseline. The next capture is still an ordinary screenshot (it becomes the
   * action's observation) and is correlated against this one, so the two must
   * agree: the same `width`, `height` and `scale` a `captureScreenshot` of this
   * request would report, and luma computed exactly as `decodePngLuma` derives
   * it — `floor((299 R + 587 G + 114 B) / 1000)` per pixel. A failure falls
   * back to the PNG baseline. Absent means every baseline is a screenshot.
   */
  captureLuma?(request: ComputerCaptureRequest): Promise<ComputerLumaCapture>;
  /**
   * The desktop rect a model observation photographs when it names no window
   * and no window holds the agent's focus — for a multi-monitor desktop, the
   * one output the agent is working on (the output of its focus target or its
   * cursor, the scoping the preview's stills already use), because the whole
   * workspace downscaled into one model image is several screens squeezed too
   * small to read.
   *
   * `ComputerManager.captureFocusedWindow` asks it before falling back to the
   * whole workspace, and refuses the region only where a visible denied window
   * intersects it. `undefined` (or a throw) keeps the workspace. The unscoped
   * `getState` screenshot is the backend's own capture, not the manager's: a
   * backend that implements this should scope that shot the same way.
   * Absent means the workspace, which is right for a single screen.
   */
  defaultObservationRegion?(): Promise<ComputerRect | undefined>;
  /** Pin or release the plugin's per-seat target window when supported. */
  focusWindow?(windowId: string): Promise<void>;
  /**
   * Restack a window above the ones covering it, without moving the user's
   * keyboard focus. Focus alone routes the agent's input to the window even
   * while it is buried, which leaves the human watching a click land on pixels
   * they cannot see.
   */
  raiseWindow?(windowId: string): Promise<void>;
  clearFocusWindow?(): Promise<void>;
  /**
   * The seat as the next owner must find it: nothing aimed, nothing held,
   * nothing remembered about the previous owner's targets. The manager calls
   * it on every desktop lease change and release, where `clearFocusWindow`
   * alone would leave a button or modifier the previous owner pressed still
   * held for the next one — a compositor seat outlives the thread that drove
   * it. Absent means the backend has nothing to hold: the manager clears the
   * aim through `clearFocusWindow` instead.
   */
  resetInputDelivery?(): Promise<void>;
  /**
   * Names the thread currently holding the desktop, for backends that draw an
   * agent cursor the human can see. `null` when nobody holds it. Best effort by
   * design: a label is presentation, so failing to set one must never fail the
   * action that changed the holder.
   */
  setDrivingAgent?(name: string | null): Promise<void>;
  /** Cosmetic activity only: never activates a window or sends input. */
  setCursorActivity?(text: string | null): Promise<void>;
  /**
   * Start `app` and report what the launch established. `pid` is the process
   * the launch started; window readiness matches it exactly unless the result
   * also names `appId`, the app identity its windows report as `appName`
   * (a desktop entry or flatpak id). A backend sets `appId` when its launch may
   * hand the window to another process — a flatpak or `gio launch` wrapper, a
   * single-instance app forwarding to its running copy — and readiness then
   * accepts a window of that app, or of the launch name, when none carries the
   * pid. Leaving it unset keeps the exact pid rule.
   */
  launchApp(
    app: string,
    args: readonly string[],
    options?: {
      /**
       * Request a hidden, non-activating launch. An application may still
       * activate itself; focusChangedDuringLaunch reports an observed change.
       * Hidden windows remain addressable for exact semantic actions.
       */
      readonly hidden?: boolean;
    },
  ): Promise<ComputerLaunchAppResult>;
  /** Fresh exact-window readiness only; never focus, raise, or send input. */
  checkInputReady?(windowId: string): Promise<void>;
  /**
   * Driver-observed UI settle for the exact window: resolves once no
   * accessibility notification arrives for `quietMs`, bounded by `timeoutMs`.
   * Pure read — no input, no mutation lease — so it is safe to run between an
   * action's dispatch and its observation. Optional because only the macOS
   * driver exposes an AX observer; callers must fall back to a fixed wait
   * when it is absent or refused. Read by presence on every use, so a backend
   * may offer it only while what it drives can answer (a getter returning
   * `undefined` for an older compositor plugin).
   */
  readonly waitForSettle?:
    | ((options: {
        readonly windowId: string;
        readonly timeoutMs: number;
        readonly quietMs: number;
        /**
         * How long `quietMs` of quiet is looked for. Past it, a surface that
         * has changed since the action counts as settled even though it keeps
         * repainting — an animation (a fading scrollbar, a button transition)
         * never goes quiet — and one that has not changed yet is waited for
         * until `timeoutMs` (or `changeWithinMs`), for a slow application's
         * first repaint. Absent: quiet is waited for until `timeoutMs`.
         */
        readonly quietWithinMs?: number;
        /**
         * How long a first change is looked for. A surface that has not
         * changed at all by then counts as settled: the action changed nothing
         * it paints (a click on a label, a key the focused control ignored),
         * and waiting on for a repaint that is not coming only delays the
         * observation. One that has changed is waited on for its quiet as
         * `quietWithinMs` says. Absent: a first change is waited for as long
         * as quiet is.
         */
        readonly changeWithinMs?: number;
      }) => Promise<{
        readonly settled: boolean;
        readonly waitedMs: number;
        readonly eventsSeen?: number;
      }>)
    | undefined;
  /**
   * The post-action settle this backend's `waitForSettle` is tuned for, when
   * it is not the AX observer's. A compositor that answers from surface
   * commits sees an update the frame it lands, so a short quiet window after
   * the first commit is enough, and a window that keeps repainting (a video,
   * a spinner) should not hold the observation for the observer's full bound.
   * The manager waits `min(quietMs, its configured settle)` of quiet, capped
   * at `timeoutMs` and passing `quietWithinMs` and `changeWithinMs` through,
   * after an action; an
   * explicit `computer_wait` keeps its own timeout and waits for real quiet.
   * Absent means the manager's defaults.
   */
  readonly actionSettle?: {
    readonly quietMs: number;
    readonly timeoutMs: number;
    readonly quietWithinMs?: number;
    readonly changeWithinMs?: number;
  };
  /**
   * The process-level app list — name, pid, bundle id, active state — for
   * backends that can enumerate it. Optional because a compositor plugin may
   * only see windows; the agent tool refuses when it is absent.
   */
  listApps?(): Promise<readonly ComputerApp[]>;
  /**
   * Move and resize the exact window to `frame` in desktop coordinates.
   * Backends report `verified` only when an independent read-back sees the new
   * frame; anything less is `unconfirmed`, never silent success.
   */
  setWindowFrame?(
    windowId: string,
    frame: ComputerRect,
  ): Promise<ComputerBackendActionResult | void>;
  /**
   * Invoke a menu-bar path — `["File", "Save"]`. A `windowId` target walks
   * the exact window's owning app; a `pid` target resolves from the
   * application-level `AXMenuBar` of that process without targeting,
   * focusing, or raising any window — the route for an app that has none.
   * The driver refuses disabled or absent items rather than falling through
   * to another actuator, and a non-macOS build refuses the pid form honestly
   * instead of approximating it.
   */
  invokeMenu?(
    target: ComputerMenuBackendTarget,
    path: readonly string[],
  ): Promise<ComputerBackendActionResult | void>;
  /**
   * Assert a predicate set against the exact window's live state — element
   * exists/enabled/selected/value, or window bounds. Pure read: the answer is
   * a tri-state (`satisfied` / `unsatisfied` / `unknown`) plus the per-predicate
   * evidence that settled it — `unknown` is never `unsatisfied`, and a caller
   * that branches on a boolean loses the distinction the driver guarantees.
   */
  verifyState?(
    windowId: string,
    expect: readonly Record<string, unknown>[],
  ): Promise<ComputerVerifyStateResult>;
  /**
   * A magnified capture of a rect inside the exact window. `region` is in
   * window-local desktop points — `(0,0)` is the window's top-left — and the
   * backend converts to the driver's screenshot-pixel space, so the caller
   * works in the same coordinates window bounds use.
   */
  zoomWindow?(windowId: string, region: ComputerRect): Promise<ComputerZoomResult>;
  /**
   * The driver's desktop-wide inventory — running apps and their on-screen
   * windows — a cheaper discovery read than a per-window accessibility walk.
   * `windowId` scopes the answer to the app that owns that exact window; the
   * driver itself only ever enumerates the whole desktop, so the scoping is
   * this layer's filter, and the caller still validates the window id exists
   * before asking. Optional because a compositor plugin may only see windows;
   * the agent tool refuses when it is absent.
   */
  getAccessibilityTree?(windowId?: string): Promise<{
    readonly apps: readonly ComputerAccessibilityTreeApp[];
    readonly windows: readonly ComputerAccessibilityTreeWindow[];
    readonly truncated: boolean;
  }>;
  /**
   * The human cursor's position in desktop points — a read, never a move.
   * `windowId` scopes the answer with whether the point lies inside that
   * window's bounds; the position itself is desktop-global either way.
   * Optional because a backend with a private pointer seat may have no shared
   * cursor to report; the agent tool refuses when it is absent.
   */
  getCursorPosition?(
    windowId?: string,
  ): Promise<Omit<ComputerCursorPosition, "computerId" | "availability">>;
  /**
   * Minimize or restore the exact window without activating it or switching
   * Spaces. A minimized window keeps its AX surface, so background semantic
   * actions still reach it — the window-grain explicit visibility control.
   * Backends report `verified` only when the driver's read-back evidence shows
   * the requested state; anything less is `unconfirmed`, never silent success.
   */
  setWindowMinimized?(
    windowId: string,
    minimized: boolean,
  ): Promise<ComputerBackendActionResult | void>;
  /**
   * Hide or unhide a running application by pid without activating it — the
   * Cmd+H path, not a Space change. A hidden app keeps its windows
   * addressable for background semantic reads and writes; neither direction
   * brings it frontmost. Same verification contract as `setWindowMinimized`.
   */
  setAppVisibility?(pid: number, hidden: boolean): Promise<ComputerBackendActionResult | void>;
  /**
   * Force-terminate a process by pid — the escalation path after the
   * cooperative close (cmd+q, window close) has already failed. Unsaved state
   * is lost; approval-gated at the tool surface.
   */
  killApp?(pid: number): Promise<ComputerBackendActionResult | void>;
  /**
   * `windowId` is the window the caller resolved this point to, when it named
   * one. A backend that injects at a screen coordinate ignores it — whatever is
   * stacked at that point receives the event either way. A backend that posts to
   * a window by id uses it as the delivery target, which is what makes a click
   * on a partially covered window reach the window the caller meant rather than
   * the one drawn on top of it.
   */
  /** True only when this fresh target advertises the native semantic action. */
  supportsAction?(target: ComputerResolvedTarget, action: string): boolean;
  click(
    point: ComputerPoint,
    windowId?: string,
    modifiers?: readonly ComputerInputModifier[],
  ): Promise<ComputerBackendActionResult | void>;
  doubleClick(
    point: ComputerPoint,
    windowId?: string,
    modifiers?: readonly ComputerInputModifier[],
  ): Promise<ComputerBackendActionResult | void>;
  /**
   * Three clicks close enough together for a toolkit to pair them, which is
   * what selects a whole line or paragraph. Optional because it is not the same
   * gesture as three separate clicks — the click count has to reach the target
   * as one number — so a backend that cannot express it must refuse rather than
   * approximate it with a loop the application reads as three carets.
   */
  tripleClick?(
    point: ComputerPoint,
    windowId?: string,
    modifiers?: readonly ComputerInputModifier[],
  ): Promise<ComputerBackendActionResult | void>;
  rightClick(
    point: ComputerPoint,
    windowId?: string,
    modifiers?: readonly ComputerInputModifier[],
  ): Promise<ComputerBackendActionResult | void>;
  moveCursor(point: ComputerPoint, windowId?: string): Promise<ComputerBackendActionResult | void>;
  drag(
    from: ComputerPoint,
    to: ComputerPoint,
    durationMs: number,
    windowId?: string,
  ): Promise<ComputerBackendActionResult | void>;
  scroll(
    point: ComputerPoint | null,
    deltaX: number,
    deltaY: number,
    windowId?: string,
    modifiers?: readonly ComputerInputModifier[],
    target?: ComputerResolvedTarget,
  ): Promise<ComputerBackendActionResult | void>;
  /**
   * Whether an exact semantic text target can be mutated without process
   * activation or process-scoped keyboard delivery.
   */
  readonly focusNeutralSemanticText?: boolean;
  /** Exact targets are revalidated and background input never falls back to global input. */
  readonly exactTargetBackgroundInput?: boolean;
  typeText(
    text: string,
    windowId?: string,
    target?: ComputerResolvedTarget,
  ): Promise<ComputerBackendActionResult | void>;
  pressKey(
    key: string,
    windowId?: string,
    target?: ComputerResolvedTarget,
  ): Promise<ComputerBackendActionResult | void>;
  hotkey(
    keys: readonly string[],
    windowId?: string,
    target?: ComputerResolvedTarget,
  ): Promise<ComputerBackendActionResult | void>;
  /**
   * The system clipboard the human user shares, not an agent-private one.
   * Toolkits bind their data device to the session's primary seat whichever
   * seat delivered the input, so a dedicated agent seat cannot own a working
   * clipboard of its own: reading returns whatever anyone last copied, and
   * writing replaces it for the human too.
   */
  readClipboard?(): Promise<string>;
  /** Writes the same shared system clipboard `readClipboard` reads. */
  writeClipboard?(text: string): Promise<void>;
  /**
   * Writes `text` to the shared clipboard for exactly one paste, and says when
   * that paste has read it.
   *
   * Paste has to put the human's clipboard back, and without this the manager
   * can only guess when the target application has finished reading the
   * payload (`COMPUTER_PASTE_RESTORE_MS`): a slow app reads after the guess and
   * pastes the human's text instead. A backend whose clipboard can serve a
   * single request and observe it (Wayland's `wl-copy --paste-once`) implements
   * this; the manager then restores as soon as `consumed` settles, bounded by
   * `COMPUTER_PASTE_CONSUME_TIMEOUT_MS` for a paste that never reads.
   *
   * The method resolves once the payload is on the clipboard, like
   * `writeClipboard`. The backend owns the offer's lifetime: a later
   * `writeClipboard` (the restore) must replace an unconsumed offer, and the
   * offer must not outlive the backend. Absent means the fixed restore wait.
   */
  writeClipboardForPaste?(text: string): Promise<ComputerClipboardPasteOffer>;
  setValue(
    target: ComputerResolvedTarget,
    value: string,
  ): Promise<ComputerBackendActionResult | void>;
  performAction(
    target: ComputerResolvedTarget,
    action: string,
  ): Promise<ComputerBackendActionResult | void>;
  /**
   * Select an exact character range on a semantic text element through the
   * accessibility layer — never a synthetic keystroke, click, or pointer drag.
   * Backends write the native selection attribute on the freshly resolved
   * element and report `verified` only when a read-back of that attribute
   * matches the requested range. A target with no settable selection
   * attribute refuses before dispatch; nothing approximates it with
   * triple-click, select-all, or a coordinate gesture.
   */
  selectText(
    target: ComputerResolvedTarget,
    range: ComputerTextRange,
  ): Promise<ComputerBackendActionResult | void>;
  onEvent?(listener: ComputerBackendEventListener): () => void;
  attachStream(listener: ComputerFrameListener): Promise<void>;
  detachStream(): Promise<void>;
  requestKeyframe?(): Promise<void>;
  /**
   * The masked-activation shield: a Synara-owned overlay that veils the
   * target window's frame for the length of one approval-gated foreground
   * excursion. Present only on backends that own a shield surface (the macOS
   * CUA path through the AppSnap helper).
   *
   * `engage` resolves once the shield is confirmed on screen and returns its
   * id. It must fail rather than degrade: a caller that armed masked
   * activation for a window refuses the activation outright when the shield
   * cannot be shown — never a silent unmasked excursion.
   *
   * `release` drops one shield by id and `releaseAll` drops every live
   * shield; both are idempotent teardown, safe to call from any cleanup path
   * in any host state.
   */
  engageShield?(target: ComputerShieldTarget): Promise<string>;
  releaseShield?(shieldId: string): Promise<void>;
  releaseAllShields?(): Promise<void>;
  stopInput?(task?: { readonly threadId: string; readonly turnId?: string }): Promise<void>;
  /** Release task-owned observation resources, including read-only turns. */
  endTask?(threadId: string, turnId?: string): Promise<void>;
  /**
   * The CDP browser surface this backend exposes, if any. Absent means the
   * `computer_browser_*` tools are not offered at all — an absent member is
   * the honest answer, never a stub that fails every call.
   */
  readonly browser?: ComputerBrowserBackend;
  dispose(): Promise<void> | void;
}

/**
 * Overlap of two desktop rects, or `undefined` when they do not overlap. Both
 * backends clip a capture request to what actually exists on the workspace, so
 * the region metadata describes the pixels the caller really received.
 */
export function intersectComputerRects(
  first: ComputerRect,
  second: ComputerRect,
): ComputerRect | undefined {
  const left = Math.max(first.x, second.x);
  const top = Math.max(first.y, second.y);
  const right = Math.min(first.x + first.width, second.x + second.width);
  const bottom = Math.min(first.y + first.height, second.y + second.height);
  if (right <= left || bottom <= top) return undefined;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Message text that satisfies the contract's bound on availability and health
 * strings. Both are built from error text the backend does not control — a
 * D-Bus payload, a plugin diagnostic — so an empty or oversized message must
 * degrade here rather than fail the state payload carrying it.
 */
export function clampComputerMessage(text: string, fallback: string): string {
  const trimmed = text.trim();
  const message = trimmed.length > 0 ? trimmed : fallback;
  return message.length > COMPUTER_MESSAGE_MAX_LENGTH
    ? `${message.slice(0, COMPUTER_MESSAGE_MAX_LENGTH - 1)}…`
    : message;
}

export function computerBackendActionResult(
  computerId: string,
  action: string,
  result: ComputerBackendActionResult | void,
): ComputerActionResult {
  return {
    computerId,
    action,
    ...(result?.point ? { point: result.point } : {}),
    ...(result?.clampedTo ? { clampedTo: result.clampedTo } : {}),
    ...(result?.windowId ? { windowId: result.windowId } : {}),
    ...(result?.value !== undefined ? { value: result.value } : {}),
    // Both halves or neither: a path with no verdict cannot tell a caller
    // whether the input landed, which is the only question this field answers.
    // The path is clamped here rather than in each backend, because it is copied
    // verbatim out of a helper reply and an over-long one would otherwise fail
    // the encode of an action that already happened.
    ...(result?.deliveryPath !== undefined && result.verified !== undefined
      ? {
          delivery: {
            path: result.deliveryPath.slice(0, COMPUTER_DELIVERY_PATH_MAX_LENGTH),
            verified: result.verified,
            ...(result.effect ? { effect: result.effect } : {}),
          },
        }
      : {}),
  } as ComputerActionResult;
}
