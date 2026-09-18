import { COMPUTER_WINDOW_LIST_MAX_LENGTH } from "@synara/contracts";
import type {
  ComputerAccessibilityTreeApp,
  ComputerAccessibilityTreeWindow,
  ComputerApp,
  ComputerAvailability,
  ComputerBuildSignature,
  ComputerCapabilities,
  ComputerCursorPosition,
  ComputerHealth,
  ComputerPoint,
  ComputerRect,
  ComputerScreenshot,
  ComputerScreenSize,
  ComputerState,
  ComputerUiNode,
  ComputerVerifyStateResult,
  ComputerWindow,
  ComputerZoomResult,
  ComputerInputModifier,
  ComputerInputPause,
  ComputerPermission,
} from "@synara/contracts";
import {
  computerPermissionSetupMessage,
  listComputerPermissions,
} from "@synara/shared/computerGrants";
import {
  cuaRequest,
  CUA_HOST_SOCKET_ENV,
  CUA_SETUP_TIMEOUT_MS,
  CuaTransportError,
  type CuaReply,
  type CuaToolResult,
  type CuaEffect,
  type CuaComputerTask,
  cuaComputerTaskKey,
} from "@synara/shared/cuaDriverProtocol";
import {
  ComputerBackendError,
  DEFAULT_COMPUTER_ID,
  NO_COMPUTER_CAPABILITIES,
  assertComputerClipboardWriteFits,
  type ComputerBackend,
  type ComputerBackendActionResult,
  type ComputerBrowserBackend,
  type ComputerBrowserCall,
  type ComputerBrowserCallResult,
  type ComputerCaptureRequest,
  type ComputerFrameListener,
  type ComputerShieldTarget,
  type ComputerResolvedTarget,
  type ComputerTextRange,
  type ComputerBackendEventListener,
} from "./ComputerBackend.ts";
import {
  desktopOperationSignal,
  assertDesktopOperationActive,
  desktopDeliveryMode,
} from "./DesktopOperationQueue.ts";
import { StillFramePublisher, resolveStillIntervalMs } from "./stillFramePublisher.ts";
import { isModelDesktopObservationActive } from "./modelDesktopObservation.ts";
import { currentComputerTask } from "./computerTaskContext.ts";
import {
  cuaPreviewStillMsOverride,
  currentComputerCall,
  timedComputerLeg,
} from "./computerCallContext.ts";
import { jpegDimensions } from "../jpegHeader.ts";
import { pngDimensions } from "../pngHeader.ts";

export class CuaActionError extends ComputerBackendError {
  constructor(
    message: string,
    readonly effect: CuaEffect,
    readonly code = "cua_action_failed",
    inputPause?: ComputerInputPause,
  ) {
    super(`${message} [effect=${effect}; automatic replay is forbidden]`, {
      retryable: false,
      ...(effect === "not-dispatched" && inputPause ? { inputPause } : {}),
    });
  }
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const text = (value: unknown, max = 1024): string =>
  typeof value === "string" ? value.slice(0, max) : "";
const number = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : NaN;
function optionalRect(value: unknown): ComputerRect | undefined {
  const r = record(value);
  const out = {
    x: number(r.x),
    y: number(r.y),
    width: number(r.width ?? r.w),
    height: number(r.height ?? r.h),
  };
  return Object.values(out).every(Number.isFinite) && out.width > 0 && out.height > 0
    ? out
    : undefined;
}
function rect(value: unknown): ComputerRect {
  const bounds = optionalRect(value);
  if (!bounds)
    throw new CuaActionError(
      "Cua returned invalid geometry.",
      "not-dispatched",
      "invalid_geometry",
    );
  return bounds;
}
const sameRect = (a: ComputerRect, b: ComputerRect) =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
/**
 * The driver's proof a visibility mutation landed: `effect: confirmed` backed
 * by a `value_readback` evidence row — the AXMinimized/isHidden re-read the
 * native tool itself took. The bare success text is never trusted on its own,
 * and the window list exposes no minimized flag to check against, so this
 * record is the only evidence the verdict can stand on.
 */
function confirmedValueReadback(data: Record<string, unknown>): boolean {
  return (
    data.effect === "confirmed" &&
    Array.isArray(data.evidence) &&
    data.evidence.some((item) => text(record(item).kind) === "value_readback")
  );
}
/** Longest one same-window semantic text write may hold its lane before the
 * caller fails honestly. The underlying write still drains so lane order
 * survives the timeout and nothing is replayed. Same-window writes serialize
 * because the native semantic lease is per (pid, window): a second concurrent
 * lease for one exact window is refused outright (driver rev 12), and AX
 * insertions plus their readback verification on one element must not
 * interleave. Different windows — same pid included — overlap. */
export const CUA_SEMANTIC_TEXT_LANE_HOLD_MS = 15_000;
/** Settle gap the lane holds after each semantic text write, so the next
 * same-window insertion starts after AX quiesces. Bounded and inside the lane. */
export const CUA_SEMANTIC_TEXT_LANE_GAP_MS = 100;
/** How long an observed element tree may serve internal target resolution.
 * Native dispatch still validates the element token, so expiry is the drift
 * bound for a control that survives but moved or changed meaning. */
const RECENT_TREE_TTL_MS = 5_000;
/**
 * Pane preview still cadence when nothing overrides it. Slower than the
 * Tier-1 default: the whole-desktop PNG a tick pulls is the expensive frame
 * on this backend, and the pane reads as live at half a hertz.
 * `SYNARA_CUA_PREVIEW_STILL_MS` replaces it; the constructor option replaces
 * it in tests.
 */
const CUA_STILL_FRAME_INTERVAL_MS = 2_000;
/**
 * The semantic element actions this integration admits, what the pinned
 * driver's `click` element path performs for each (`action` argument, mapped
 * in `ax_actions::map_action`), and the AX action the element must advertise
 * for Synara to dispatch it.
 *
 * The driver's `map_action` silently defaults any unknown spelling to
 * AXPress, so names are mapped here explicitly: an unlisted request refuses
 * before dispatch rather than becoming a press the caller never asked for.
 */
const CUA_ELEMENT_ACTIONS: Readonly<
  Record<string, { readonly driverAction: string; readonly axAction: string }>
> = {
  axpress: { driverAction: "press", axAction: "AXPress" },
  press: { driverAction: "press", axAction: "AXPress" },
  open: { driverAction: "open", axAction: "AXOpen" },
  show_menu: { driverAction: "show_menu", axAction: "AXShowMenu" },
  menu: { driverAction: "show_menu", axAction: "AXShowMenu" },
  pick: { driverAction: "pick", axAction: "AXPick" },
  confirm: { driverAction: "confirm", axAction: "AXConfirm" },
  cancel: { driverAction: "cancel", axAction: "AXCancel" },
};

function cuaElementAction(
  name: string,
): { readonly driverAction: string; readonly axAction: string } | undefined {
  return CUA_ELEMENT_ACTIONS[name.toLowerCase()];
}

function cuaKey(value: string): string {
  const key = value.toLowerCase();
  if (key === "insert" || key === "ins")
    throw new CuaActionError(
      "Cua 0.28.2 has no Insert key mapping on macOS.",
      "not-dispatched",
      "unsupported_operation",
    );
  // Synara-side spellings that already resolve to a driver keyname. Only
  // entries whose target the pinned keymap accepts may live here: a name with
  // no driver mapping (keypad keys, f13-f20, menu, help) passes through
  // untouched so the driver's own "Unknown key name" refusal stays the honest
  // gate and an extended keymap revision lights them up without a Synara
  // change. Left-side modifier spellings resolve to the one physical code the
  // driver posts for that modifier; right-side spellings stay refused until
  // the keymap carries the right-key codes.
  const aliases: Record<string, string> = {
    meta: "command",
    super: "command",
    super_l: "command",
    win: "command",
    delete: "forward_delete",
    del: "forward_delete",
    arrowleft: "left",
    arrowright: "right",
    arrowup: "up",
    arrowdown: "down",
    " ": "space",
    page_up: "pageup",
    pgup: "pageup",
    prior: "pageup",
    page_down: "pagedown",
    pgdn: "pagedown",
    next: "pagedown",
    caps_lock: "capslock",
    shift_l: "shift",
    ctrl_l: "ctrl",
    control_l: "ctrl",
    alt_l: "alt",
    option_l: "alt",
  };
  return aliases[key] ?? key;
}

/**
 * Bounds one same-window lane write. Rejects past the hold while leaving the
 * raced write alone: the lane still drains in order, and the error reports
 * possible partial dispatch so no caller may replay it.
 */
function withSemanticTextLaneTimeout<A>(write: Promise<A>, holdMs: number): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new CuaActionError(
          "Semantic text delivery timed out; the write may have partially dispatched. " +
            "Observe the target before acting; never retype blindly.",
          "dispatched-unknown",
        ),
      );
    }, holdMs);
    timer.unref?.();
  });
  return Promise.race([write, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** The single macOS backend. Cua owns native actions; Synara owns admission,
 * session authority, explicit delivery policy and the provider result. */
export class CuaComputerBackend implements ComputerBackend {
  // Focus-neutral semantic writes are a Synara-patch guarantee. Unknown
  // (pre-handshake) reads as the patched default; `0` is the unpatched
  // upstream driver, where the property is unverified and unclaimed.
  get focusNeutralSemanticText(): boolean {
    return this.driverNativeRevision !== 0;
  }
  readonly computerId = DEFAULT_COMPUTER_ID;
  // The AXPress/meta-key dialect is macOS semantics; Windows and Linux
  // drivers speak the generic desktop dialect (press, ctrl+chords). The
  // host reports its own platform on every reply — a remote endpoint on
  // another OS overrides the local assumption.
  get agentDialect(): "macos" | "linux" {
    return (this.hostPlatform ?? process.platform) === "darwin" ? "macos" : "linux";
  }
  private readonly endpoint: string | undefined;
  private readonly capability: string | undefined;
  private windows: readonly ComputerWindow[] = [];
  private size: ComputerScreenSize = { width: 1, height: 1 };
  private permissions: ComputerPermission[] = [];
  private currentAvailability: ComputerAvailability = {
    kind: "backend-unavailable",
    message: "Computer has not connected to the Synara desktop app.",
  };
  private currentHealth: ComputerHealth = {
    status: "unavailable",
    consecutiveFailures: 0,
    reconnects: 0,
    captureAvailable: false,
  };
  private captureFailed = false;
  private readonly listeners = new Set<ComputerBackendEventListener>();
  private snapshotAt = 0;
  private hadMissingPermissions = false;
  private snapshot: Promise<void> | undefined;
  private selectedWindow: string | undefined;
  private readonly elementTokens = new WeakMap<ComputerUiNode, string>();
  /**
   * The AX action names the element advertised in the snapshot that produced
   * it — the same `actions` list the driver's own dispatch checks. Nodes are
   * recreated on every observation, so this is always the freshest claim.
   */
  private readonly elementActions = new WeakMap<ComputerUiNode, ReadonlySet<string>>();
  /**
   * Elements living inside Chromium-family web content. AXSelectedText
   * inserts never reach their DOM (verified against Electron 43), so text
   * writes to these route through `set_value` with an independent re-read
   * instead of the semantic-insert path native controls honour.
   */
  private readonly webContentElements = new WeakSet<ComputerUiNode>();
  /**
   * Element trees observed within the last few seconds, keyed by window id.
   * Internal target resolution reuses them: the element tokens bound to these
   * nodes are validated natively at dispatch, so an aged-out element refuses
   * rather than pressing the wrong control. Retaining the root keeps every
   * child node alive for the WeakMap token lookups.
   */
  private readonly recentTrees = new Map<string, { at: number; root: ComputerUiNode }>();
  private readonly observedGeometry = new Map<string, ComputerRect>();
  private readonly stills: StillFramePublisher;
  private cachedImage: ComputerScreenshot | undefined;
  private desktopEpoch: number | undefined;
  /**
   * The host's interruption count as of the newest reply observed. Unlike
   * {@link desktopEpoch} it moves only on real OS interruptions (lock,
   * sleep, session switch), so an advance — even with the pauses already
   * back to empty — is the proof a lock/resume cycle ran since consent was
   * last granted, and what drives the `desktop-interrupted` event.
   */
  private desktopInterruptions: number | undefined;
  /**
   * The Synara native revision the live driver reported through host
   * replies — `undefined` until the first reply carrying it, `0` on an
   * unpatched upstream driver. Capabilities that exist only in the Synara
   * patch are advertised only while this is nonzero or unknown.
   */
  private driverNativeRevision: number | undefined;
  /** The driver's host platform as last reported by a reply; undefined until first contact. */
  private hostPlatform: string | undefined;
  private imageGeneration = 0;
  private readonly previewTasks = new Map<string, CuaComputerTask>();
  /**
   * The newest window each live preview task addressed, recorded from the
   * same `pid`/`window_id` call args the host's frame tap reads — including
   * the browser family's bind calls. While one exists the stills stream
   * captures that window instead of the whole desktop, so the pane preview
   * shows what the agent drives rather than the user's screen.
   */
  private readonly previewWindows = new Map<string, { pid: number; windowId: number }>();
  private clearCachedImage(): void {
    this.imageGeneration += 1;
    this.cachedImage = undefined;
  }
  private disposed = false;
  constructor(
    options: {
      endpoint?: string;
      capability?: string | undefined;
      request?: typeof cuaRequest;
      /** Test injection so lane tests do not wait out the real hold. */
      semanticTextLaneHoldMs?: number;
      /** Test injection so lane tests do not sleep for real. */
      semanticTextLaneGapMs?: number;
      /**
       * Still-capture cadence for the pane preview; defaults to
       * `SYNARA_CUA_PREVIEW_STILL_MS`, then 2000 ms. Injectable so tests can
       * observe the interval without env manipulation.
       */
      stillIntervalMs?: number;
    } = {},
  ) {
    this.endpoint = options.endpoint ?? process.env[CUA_HOST_SOCKET_ENV];
    this.capability = options.capability;
    this.request = options.request ?? cuaRequest;
    this.semanticTextLaneHoldMs = options.semanticTextLaneHoldMs ?? CUA_SEMANTIC_TEXT_LANE_HOLD_MS;
    this.semanticTextLaneGapMs = options.semanticTextLaneGapMs ?? CUA_SEMANTIC_TEXT_LANE_GAP_MS;
    this.stills = new StillFramePublisher({
      capture: async () => {
        // Reuse a recent tool observation; idle panes spend at most one capture
        // every two seconds and detached panes spend none. The cache only ever
        // holds whole-desktop frames, so a scoped task window skips it rather
        // than paint the user's screen over the driven window.
        const target = this.previewWindowTarget();
        if (target === undefined) {
          const image =
            this.cachedImage && Date.now() - Date.parse(this.cachedImage.capturedAt) < 1_500
              ? this.cachedImage
              : await this.captureOverview(false);
          return Buffer.from(image.bytesBase64, "base64");
        }
        try {
          const scoped = await this.captureWindowStill(target.pid, target.windowId);
          return Buffer.from(scoped.bytesBase64, "base64");
        } catch {
          // A scoped miss (window closed, moved to another Space) is a stale
          // target, not a capture failure — the overview path reports capture
          // health honestly if the desktop itself stops producing pixels.
          this.previewWindows.delete(target.key);
          const image = await this.captureOverview(false);
          return Buffer.from(image.bytesBase64, "base64");
        }
      },
      prepare: async () => {
        await this.availability();
      },
      isCaptureAvailable: () => !this.disposed && !this.permissions.includes("screenRecording"),
      emit: () => undefined,
      now: Date.now,
      // Still cadence is 2 s unless SYNARA_CUA_PREVIEW_STILL_MS overrides it;
      // the publisher floor keeps an aggressive value from queueing captures
      // faster than one encode can finish.
      intervalMs: resolveStillIntervalMs(
        options.stillIntervalMs ?? cuaPreviewStillMsOverride() ?? CUA_STILL_FRAME_INTERVAL_MS,
      ),
    });
  }
  private readonly request: typeof cuaRequest;
  private readonly semanticTextLaneHoldMs: number;
  private readonly semanticTextLaneGapMs: number;
  /**
   * One tail promise per (pid, window) lane. Tails only ever resolve, so a
   * failed write never wedges its lane-mates; entries are pruned when their
   * owner settles.
   */
  private readonly semanticTextLanes = new Map<string, Promise<void>>();
  onEvent(listener: ComputerBackendEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private setHealth(health: ComputerHealth): void {
    if (JSON.stringify(health) === JSON.stringify(this.currentHealth)) return;
    this.currentHealth = health;
    for (const listener of this.listeners) listener({ type: "health-changed", health });
  }
  /**
   * One unusable capture flips health unavailable. The action verdict stands —
   * this never rewrites an input result — and inputs keep working: nothing on
   * the input path gates on health, and the next granted refresh heals this.
   */
  private markCaptureFailed(error: unknown): void {
    this.captureFailed = true;
    const message = error instanceof Error ? error.message : String(error);
    this.setHealth({
      ...this.currentHealth,
      status: "unavailable",
      captureAvailable: false,
      consecutiveFailures: this.currentHealth.consecutiveFailures + 1,
      lastFailure: {
        at: new Date().toISOString(),
        message: message.slice(0, 2048),
      },
    });
  }
  private async host(
    request: Record<string, unknown>,
    mutation = false,
    allowModelObservation = true,
  ): Promise<CuaReply> {
    if (this.disposed || !this.endpoint)
      throw new CuaActionError(
        "Open this session in the Synara macOS desktop app to use Computer.",
        "not-dispatched",
        "gui_host_required",
      );
    assertDesktopOperationActive();
    const task = request.method === "call" ? currentComputerTask() : undefined;
    if (task) this.trackPreviewTask(task);
    // Per-operation baseline, captured at dispatch. A newer desktop generation
    // observed while this call is in flight means the reply predates an
    // interruption (lock/resume) — even when the reply itself carries the new
    // generation — so it is rejected rather than trusted as current.
    const sendBaseline = this.desktopEpoch;
    const endpoint = this.endpoint;
    try {
      // The socket round trip, counted and timed on the active call's timing
      // record when SYNARA_CUA_TIMING_LOG is on — durations only, never the
      // request or reply payloads.
      currentComputerCall()?.timing?.count("host_calls");
      const reply = await timedComputerLeg("host", () =>
        this.request<CuaReply>(
          endpoint,
          {
            ...request,
            ...(task ? { task } : {}),
            ...(request.method === "call" &&
            (request.name === "get_window_state" || request.name === "get_desktop_state")
              ? {
                  modelObservation: allowModelObservation && isModelDesktopObservationActive(),
                }
              : {}),
            capability: this.capability,
          },
          {
            signal: desktopOperationSignal(),
            mutation,
            timeoutMs: request.method === "setup" ? CUA_SETUP_TIMEOUT_MS : 35_000,
          },
        ),
      );
      this.observeDesktopInterruption(reply);
      if (
        typeof reply.driverNativeRevision === "number" &&
        Number.isSafeInteger(reply.driverNativeRevision) &&
        reply.driverNativeRevision >= 0
      )
        this.driverNativeRevision = reply.driverNativeRevision;
      if (typeof reply.hostPlatform === "string" && reply.hostPlatform.length > 0)
        this.hostPlatform = reply.hostPlatform;
      const epoch = reply.desktopEpoch;
      if (epoch !== undefined && Number.isSafeInteger(epoch) && epoch >= 0) {
        if (
          sendBaseline !== undefined &&
          this.desktopEpoch !== undefined &&
          this.desktopEpoch !== sendBaseline
        )
          throw new CuaActionError(
            "The desktop changed while this operation was in flight. Observe again before continuing.",
            mutation ? "dispatched-unknown" : "not-dispatched",
            "stale_desktop_epoch",
          );
        if (sendBaseline !== undefined && epoch < sendBaseline)
          throw new CuaActionError(
            "The desktop changed while this operation was in flight. Observe again before continuing.",
            mutation ? "dispatched-unknown" : "not-dispatched",
            "stale_desktop_epoch",
          );
        if (epoch !== this.desktopEpoch) {
          this.desktopEpoch = epoch;
          this.clearCachedImage();
          this.observedGeometry.clear();
          this.snapshotAt = 0;
        }
      }
      if (!reply.ok)
        throw new CuaActionError(
          reply.error ?? "Cua host failed.",
          reply.effect ?? "not-dispatched",
        );
      if (task && request.method === "call")
        this.recordPreviewWindow(task, request.args, reply.result);
      return reply;
    } catch (error) {
      if (error instanceof CuaTransportError) throw new CuaActionError(error.message, error.effect);
      throw error;
    }
  }
  /**
   * Adopt the host's interruption count from a reply and announce a real
   * change once. The first observed count only sets the baseline — consent
   * cannot predate first contact — while every later difference (an advance,
   * or a reset from a host that restarted) proves the desktop went through
   * an interruption boundary consent must not silently cross. Called before
   * the epoch staleness checks so a reply that is about to be rejected still
   * reports the interruption it observed. Replies missing the field (an
   * older host) degrade to no tracking rather than false interruptions.
   */
  private observeDesktopInterruption(reply: CuaReply): void {
    const interruptions = reply.desktopInterruptions;
    if (
      typeof interruptions !== "number" ||
      !Number.isSafeInteger(interruptions) ||
      interruptions < 0
    )
      return;
    if (this.desktopInterruptions !== undefined && interruptions !== this.desktopInterruptions) {
      const pauses = Array.isArray(reply.desktopPauses)
        ? reply.desktopPauses.filter((reason): reason is string => typeof reason === "string")
        : [];
      for (const listener of this.listeners) listener({ type: "desktop-interrupted", pauses });
    }
    this.desktopInterruptions = interruptions;
  }
  private async call(
    name: string,
    args: Record<string, unknown> = {},
    mutation = false,
    allowModelObservation = true,
  ): Promise<CuaToolResult> {
    // The native operation itself, on the call's timing record — the name is
    // a fixed driver vocabulary, and nothing from `args` is recorded.
    currentComputerCall()?.timing?.count("native_calls");
    const reply = await timedComputerLeg("call", () =>
      this.host({ method: "call", name, args }, mutation, allowModelObservation),
    );
    const result = reply.result ?? {};
    if (result.isError || result.structuredContent?.effect === "refused") {
      const structured = result.structuredContent ?? {};
      // Only a structured native admission refusal proves no dispatch. An
      // arbitrary native exception may follow partially delivered input. The
      // driver publishes two refusal dialects: action tools carry
      // `effect:"refused"`, while tools like invoke_menu/kill_app carry
      // `status:"refused"` plus a `refusal.code` object.
      const refused = structured.effect === "refused" || structured.status === "refused";
      const refusal = record(structured.refusal);
      const message =
        (result.content ?? [])
          .map((c) => c.text ?? "")
          .join("\n")
          .slice(0, 2048) ||
        text(structured.message) ||
        text(refusal.message) ||
        text(structured.reason) ||
        "The native operation could not complete.";
      const code = text(structured.code) || text(refusal.code) || "cua_refusal";
      if (refused && code === "desktop_input_paused") {
        this.clearCachedImage();
        this.observedGeometry.clear();
      }
      const inputPause =
        refused &&
        (code === "target_not_on_active_space" ||
          code === "desktop_input_paused" ||
          code === "auth_sheet_focused") &&
        Number.isSafeInteger(args.pid) &&
        Number.isSafeInteger(args.window_id)
          ? { windowId: `cua:${args.pid}:${args.window_id}`, message }
          : undefined;
      throw new CuaActionError(
        message,
        mutation && !refused ? "dispatched-unknown" : "not-dispatched",
        code,
        inputPause,
      );
    }
    return result;
  }
  async probeAvailability(): Promise<ComputerAvailability> {
    if (!this.endpoint)
      return {
        kind: "backend-unavailable",
        message:
          "Computer requires the Synara macOS desktop app, which owns the native permissions.",
      };
    try {
      await this.host({ method: "probe" });
      return this.currentAvailability.kind === "backend-unavailable"
        ? { kind: "available", backend: "cua" }
        : this.currentAvailability;
    } catch (error) {
      return {
        kind: "backend-unavailable",
        message: String(error).slice(0, 2048),
      };
    }
  }
  async availability(): Promise<ComputerAvailability> {
    await this.refresh();
    return this.currentAvailability;
  }
  health(): ComputerHealth {
    return this.currentHealth;
  }
  capabilities(): ComputerCapabilities {
    return {
      ...NO_COMPUTER_CAPABILITIES,
      windows: true,
      windowBounds: true,
      stacking: true,
      capture: true,
      input: true,
      clipboard: true,
      focus: true,
      raise: true,
      // The compact agent cursor is a Synara-patch rendering path. Unknown
      // (no handshake yet) reads as the patched default; `0` is the
      // unpatched upstream driver's honest answer.
      ghostCursor: this.driverNativeRevision !== 0,
      visibleDesktop: true,
    };
  }
  async missingPermissions() {
    return this.permissions;
  }
  /**
   * How this build is code-signed, for the stale-grant advice. The helper only
   * reports the responsible bundle id, never the signature itself, so the
   * honest stable answer is `unknown` — and it is stable per build rather than
   * per probe, so it is a plain method rather than a reading that can flicker.
   */
  buildSignature(): ComputerBuildSignature {
    return "unknown";
  }
  async provision(): Promise<string> {
    // Let a pre-setup status read settle before invalidating it. Its missing
    // grants must not win the refresh after the user requests permissions.
    await this.snapshot?.catch(() => undefined);
    await this.host({ method: "setup" });
    this.snapshotAt = 0;
    // No unconditional capture-failure reset here: only an observed
    // screen_recording grant clears it, in refresh() below, so a setup that
    // did not actually restore capture cannot launder the health away.
    await this.refresh(true);
    if (!this.permissions.length)
      return "Computer permissions are ready. Send a message to continue; no action is retried automatically.";
    const missing = listComputerPermissions(this.permissions);
    // The setup surface is macOS TCC; other platforms report through the
    // driver's own probe, and the guidance names what the platform uses
    // rather than a settings pane that does not exist there.
    return (this.hostPlatform ?? process.platform) === "darwin"
      ? `Allow ${missing} for this copy of Synara in System Settings. Return here to check again; if macOS asks you to quit and reopen the app, do so.`
      : `The driver host reports missing ${missing} access. Grant it at the OS level the platform uses (display-server access on Linux, integrity/UIAccess on Windows), then check again; no action is retried automatically.`;
  }
  private refresh(force = false): Promise<void> {
    if (this.snapshot) return this.snapshot;
    if (!force && Date.now() - this.snapshotAt < 1_000) return Promise.resolve();
    this.snapshot = (async () => {
      let permission =
        (await this.call("check_permissions", { prompt: false })).structuredContent ?? {};
      // tccd can report a transient negative for a freshly spawned session
      // while it maps the running app to its grants — observed to outlive a
      // single 400ms re-probe at turn start. A missing report that follows a
      // granted or unread state gets up to four delayed re-probes before it
      // is published; a steady missing state converges on the last call and a
      // granted answer short-circuits the remaining probes.
      if (
        (permission.accessibility !== true || permission.screen_recording !== true) &&
        !this.hadMissingPermissions
      ) {
        for (let attempt = 0; attempt < 4; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 600));
          permission =
            (await this.call("check_permissions", { prompt: false })).structuredContent ?? {};
          if (permission.accessibility === true && permission.screen_recording === true) break;
        }
      }
      this.permissions = [];
      if (permission.accessibility !== true) this.permissions.push("accessibility");
      if (permission.screen_recording !== true) this.permissions.push("screenRecording");
      this.hadMissingPermissions = this.permissions.length > 0;
      // A capture failure clears only on an observed Screen Recording grant:
      // neither a previous-missing transition nor an explicit setup proves
      // pixels flow again, only a fresh probe saying so does.
      if (permission.screen_recording === true) this.captureFailed = false;
      const bundleId = text(record(permission.source).host_bundle_id, 256);
      const signature = this.buildSignature();
      this.setHealth({
        ...this.currentHealth,
        status: this.captureFailed ? "unavailable" : "connected",
        captureAvailable: permission.screen_recording === true && !this.captureFailed,
        consecutiveFailures: this.captureFailed ? this.currentHealth.consecutiveFailures : 0,
      });
      // TCC's setup surface is macOS-only: on other platforms the driver's
      // own probe reports what it found, and the message names the access
      // mechanism that platform actually has.
      const hostIsDarwin = (this.hostPlatform ?? process.platform) === "darwin";
      this.currentAvailability = this.permissions.length
        ? {
            kind: "permission-required",
            missing: this.permissions,
            buildSignature: signature,
            ...(bundleId ? { bundleId } : {}),
            message: hostIsDarwin
              ? computerPermissionSetupMessage(this.permissions, signature, bundleId || undefined)
              : `Synara's driver host reports missing ${listComputerPermissions(
                  this.permissions,
                )} access. Grant it at the OS level the platform uses — display-server access on Linux, integrity/UIAccess on Windows — then try again.`,
          }
        : { kind: "available", backend: "cua" };
      if (!this.permissions.length) {
        await this.readWindows();
        const geometry = (await this.call("get_screen_size")).structuredContent ?? {};
        const width = number(geometry.width),
          height = number(geometry.height);
        if (!(width > 0 && height > 0))
          throw new Error("Cua returned no primary display geometry.");
        this.size = { width, height, scale: number(geometry.scale_factor) };
      }
      this.snapshotAt = Date.now();
    })()
      .catch((error) => {
        this.setHealth({
          ...this.currentHealth,
          status: "unavailable",
          captureAvailable: false,
          consecutiveFailures: this.currentHealth.consecutiveFailures + 1,
          lastFailure: {
            at: new Date().toISOString(),
            message: String(error).slice(0, 2048),
          },
        });
        throw error;
      })
      .finally(() => {
        this.snapshot = undefined;
      });
    return this.snapshot;
  }
  private async readWindows(): Promise<readonly ComputerWindow[]> {
    const data = (await this.call("list_windows")).structuredContent ?? {};
    if (!Array.isArray(data.windows)) throw new Error("Invalid Cua window list.");
    const rows = data.windows
      .map(record)
      .sort((a, b) => (number(b.z_index) || 0) - (number(a.z_index) || 0));
    this.windows = rows
      .flatMap((w, i): ComputerWindow[] => {
        const pid = number(w.pid),
          windowId = number(w.window_id),
          bounds = optionalRect(w.bounds);
        // WindowServer can return zero-area placeholders. They are not input
        // targets and must not make every other application unavailable.
        if (
          !Number.isInteger(pid) ||
          pid <= 0 ||
          !Number.isInteger(windowId) ||
          windowId <= 0 ||
          !bounds
        )
          return [];
        return [
          {
            id: `cua:${pid}:${windowId}`,
            pid,
            title: text(w.title),
            appName: text(w.app_name),
            bounds,
            focused: this.selectedWindow === `cua:${pid}:${windowId}`,
            // A minimized window drops out of the screen list but keeps its
            // Space membership; a hidden app's windows report no membership at
            // all; an off-Space window reports on_current_space === false.
            minimized:
              w.is_on_screen === false &&
              w.on_current_space !== false &&
              Array.isArray(w.space_ids) &&
              w.space_ids.length > 0,
            visible: w.is_on_screen === true && w.on_current_space !== false,
            ...(Number.isInteger(w.z_index) ? { stackingIndex: i } : {}),
          },
        ];
      })
      .slice(0, 512);
    return this.windows;
  }
  async listWindows() {
    await this.refresh();
    return this.windows;
  }
  async getScreenSize() {
    await this.refresh();
    return this.size;
  }
  private async target(
    windowId = this.selectedWindow,
    fresh = true,
  ): Promise<{
    pid: number;
    window_id: number;
    window: ComputerWindow;
    baseline: number | undefined;
  }> {
    if (!windowId || !/^cua:[1-9]\d*:[1-9]\d*$/.test(windowId))
      throw new CuaActionError(
        "Select an exact window before acting.",
        "not-dispatched",
        "window_required",
      );
    const windows = fresh ? await this.readWindows() : this.windows;
    const window = windows.find((w) => w.id === windowId);
    if (!window?.bounds || !window.pid)
      throw new CuaActionError(
        "The target window closed or its identity changed.",
        "not-dispatched",
        "stale_target",
      );
    // The desktop generation this resolution is grounded in. Checked again at
    // inject: anything that moved the generation in between (a lock/resume the
    // reads above did not yet see) must refuse before dispatch, never after.
    return {
      pid: window.pid,
      window_id: Number(windowId.split(":")[2]),
      window,
      baseline: this.desktopEpoch,
    };
  }
  async focusWindow(windowId: string): Promise<void> {
    // Selection sends no input. The actual actuator revalidates the exact
    // window immediately before dispatch; reuse the just-observed identity here.
    await this.target(windowId, !this.windows.some((window) => window.id === windowId));
    this.selectedWindow = windowId;
  }
  async checkInputReady(windowId: string): Promise<void> {
    const { pid, window_id } = await this.target(windowId);
    const result = await this.call("check_input_ready", { pid, window_id });
    const data = result.structuredContent ?? {};
    if (data.ready !== true || number(data.pid) !== pid || number(data.window_id) !== window_id) {
      throw new CuaActionError(
        "Cua did not confirm input readiness for the exact target window.",
        "not-dispatched",
        "invalid_readiness",
      );
    }
  }
  /**
   * The driver's AX-observer settle: `wait_for_settle` is a read-only tool —
   * no input admission, no mutation lease — so this call runs through the
   * ordinary read path. The native observer scopes to the exact window's AX
   * subtree, debounces `quietMs` of silence, and reports `settled` plus the
   * observed event count at `timeoutMs`. An older or refusing driver fails
   * through `call`'s normal error path and the caller falls back to the fixed
   * settle rather than retrying an uncertain wait.
   */
  async waitForSettle(options: {
    readonly windowId: string;
    readonly timeoutMs: number;
    readonly quietMs: number;
  }): Promise<{
    readonly settled: boolean;
    readonly waitedMs: number;
    readonly eventsSeen?: number;
  }> {
    const { pid, window_id } = await this.target(options.windowId);
    const result = await this.call("wait_for_settle", {
      pid,
      window_id,
      timeout_ms: Math.max(0, Math.min(30_000, Math.floor(options.timeoutMs))),
      quiet_ms: Math.max(0, Math.min(5_000, Math.floor(options.quietMs))),
    });
    const data = result.structuredContent ?? {};
    if (typeof data.settled !== "boolean")
      throw new CuaActionError(
        "Cua did not return a settle verdict for the exact target window.",
        "not-dispatched",
        "invalid_settle_read",
      );
    const waited = number(data.waited_ms);
    return {
      settled: data.settled,
      waitedMs: Number.isFinite(waited) ? waited : 0,
      ...(typeof data.events_seen === "number" ? { eventsSeen: data.events_seen } : {}),
    };
  }
  async raiseWindow(windowId: string): Promise<void> {
    if (desktopDeliveryMode() !== "foreground")
      throw new CuaActionError(
        "Window activation requires foreground delivery within an authorized Computer task.",
        "not-dispatched",
        "foreground_required",
      );
    const { pid, window_id } = await this.target(windowId);
    const result = await this.call("bring_to_front", { pid, window_id }, true);
    if (result.structuredContent?.activated !== true)
      throw new CuaActionError(
        "Cua could not verify that the exact window became foreground. Do not repeat the activation blindly.",
        "dispatched-unknown",
      );
    this.snapshotAt = 0;
  }
  async clearFocusWindow(): Promise<void> {
    this.selectedWindow = undefined;
  }
  private screenshot(result: CuaToolResult, fallback?: ComputerRect): ComputerScreenshot {
    const data = result.structuredContent ?? {};
    if (data.screenshot_frame_freshness === "unverified_off_space")
      throw new CuaActionError(
        "The exact window is on another macOS Space. Cua returned pixels, but their freshness cannot be proven without switching Spaces, so Synara will not present them as a live observation.",
        "not-dispatched",
        "off_space_capture_unverified",
      );
    const image = result.content?.find(
      (c) => c.type === "image" && c.mimeType === "image/png" && c.data,
    );
    if (!image?.data || data.screenshot_frame_valid === false)
      throw new CuaActionError(
        "Cua could not establish the screenshot geometry.",
        "not-dispatched",
        "capture_unavailable",
      );
    // The PNG header contains the dimensions; do not decode the full image
    // until its bytes are needed by the preview transport.
    const dimensions = pngDimensions(Buffer.from(image.data.slice(0, 32), "base64"));
    const region = data.window_bounds ? rect(data.window_bounds) : fallback;
    if (!dimensions || !region) throw new Error("Cua screenshot is missing its coordinate frame.");
    const scale = dimensions.width / region.width;
    if (Math.abs(dimensions.height / region.height - scale) > 0.01)
      throw new Error("Cua screenshot dimensions disagree with its geometry.");
    return {
      mimeType: "image/png",
      ...dimensions,
      sizeBytes: Buffer.byteLength(image.data, "base64"),
      bytesBase64: image.data,
      region,
      scale,
      capturedAt: new Date().toISOString(),
    };
  }
  /**
   * Registers a dispatching task as preview-live. Both entry points that
   * attribute work to a task — `host()` for desktop calls, `browserCall` for
   * the CDP surface — share it, so an endTask from either path reaches the
   * host and the eviction bound holds across both.
   */
  private trackPreviewTask(task: CuaComputerTask): void {
    const currentKey = cuaComputerTaskKey(task);
    // Refresh recency: Map.set alone does not reorder, so a task that
    // keeps dispatching would otherwise age out while live. Delete first.
    if (this.previewTasks.has(currentKey)) this.previewTasks.delete(currentKey);
    this.previewTasks.set(currentKey, task);
    // Evict oldest first, but never the task dispatching right now:
    // evicting it would break the taskKey lock the preview helper relies on
    // and silently drop its later endTask (preview leak).
    while (this.previewTasks.size > 256) {
      const oldest = [...this.previewTasks.keys()].find((key) => key !== currentKey);
      if (oldest === undefined) break;
      this.previewTasks.delete(oldest);
      this.previewWindows.delete(oldest);
    }
  }
  /**
   * Same target the host's frame tap reads off the call args: a window the
   * task just successfully addressed is what the preview should show. Only
   * successful calls move it — a refused call proved nothing about where the
   * task is working, so both refusal dialects (`effect:"refused"` and
   * `status:"refused"`) leave the previous target alone.
   */
  private recordPreviewWindow(
    task: CuaComputerTask,
    args: unknown,
    result: CuaToolResult | undefined,
  ): void {
    if (result?.isError === true) return;
    const structured = result?.structuredContent;
    if (structured?.effect === "refused" || structured?.status === "refused") return;
    const pid = record(args).pid;
    const windowId = record(args).window_id;
    if (
      typeof pid !== "number" ||
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      typeof windowId !== "number" ||
      !Number.isSafeInteger(windowId) ||
      windowId <= 0
    )
      return;
    const currentKey = cuaComputerTaskKey(task);
    this.previewWindows.delete(currentKey);
    this.previewWindows.set(currentKey, { pid, windowId });
  }
  /**
   * The window the stills stream should paint: the most recently addressed
   * target across the live preview tasks, or none. Entries whose task ended
   * are dropped alongside `previewTasks`, so the newest live entry wins.
   */
  private previewWindowTarget(): { key: string; pid: number; windowId: number } | undefined {
    let newest: { key: string; pid: number; windowId: number } | undefined;
    for (const [key, target] of this.previewWindows) {
      if (this.previewTasks.has(key)) newest = { key, ...target };
    }
    return newest;
  }
  /**
   * One window-scoped still for the pane preview — the same `get_window_state`
   * screenshot {@link captureScreenshot} serves the model, at the preview's
   * fixed bound. Callers decide what a failure means; it never writes the
   * whole-desktop {@link cachedImage} slot.
   */
  private async captureWindowStill(pid: number, windowId: number): Promise<ComputerScreenshot> {
    const result = await this.call(
      "get_window_state",
      {
        pid,
        window_id: windowId,
        include_accessibility_tree: false,
        include_screenshot: true,
        max_dimension: 1536,
      },
      false,
      false,
    );
    this.assertObservedWindow(result, pid, windowId);
    return this.screenshot(result);
  }
  private async captureOverview(allowModelObservation = true): Promise<ComputerScreenshot> {
    const generation = this.imageGeneration;
    try {
      const result = await this.call("get_desktop_state", {}, false, allowModelObservation);
      const data = result.structuredContent ?? {};
      const image = this.screenshot(result, {
        x: 0,
        y: 0,
        width: number(data.screen_width),
        height: number(data.screen_height),
      });
      if (generation === this.imageGeneration && this.stills.attached && !this.disposed) {
        this.cachedImage = image;
      }
      // No capture-failure reset here: only an observed Screen Recording grant
      // (in refresh()) proves capture is back, so only it clears the flag.
      this.setHealth({
        ...this.currentHealth,
        status: "connected",
        captureAvailable: true,
        consecutiveFailures: 0,
      });
      return image;
    } catch (error) {
      this.markCaptureFailed(error);
      throw error;
    }
  }
  async captureScreenshot(request: ComputerCaptureRequest): Promise<ComputerScreenshot> {
    if (request.kind === "region")
      throw new CuaActionError(
        "Region capture is not supported by this pinned Cua backend. Capture an exact window; the overview covers the primary display only.",
        "not-dispatched",
        "unsupported_operation",
      );
    const { pid, window_id, window } = await this.target(request.windowId);
    try {
      const result = await this.call("get_window_state", {
        pid,
        window_id,
        include_accessibility_tree: false,
        include_screenshot: true,
        max_dimension: request.maxDimension ?? 1536,
      });
      this.assertObservedWindow(result, pid, window_id);
      const image = { ...this.screenshot(result), windowId: window.id };
      this.observedGeometry.set(window.id, image.region!);
      return image;
    } catch (error) {
      // Targeting failures above never reach here; anything failing past the
      // target produced no usable pixels, so health flips while the throw —
      // and any input verdict — stands exactly as before.
      if (!(error instanceof CuaActionError) || error.code !== "off_space_capture_unverified")
        this.markCaptureFailed(error);
      throw error;
    }
  }
  private assertObservedWindow(result: CuaToolResult, pid: number, windowId: number): void {
    const data = result.structuredContent ?? {};
    if (number(data.pid) !== pid || number(data.window_id) !== windowId)
      throw new CuaActionError("Cua observation belongs to a different window.", "not-dispatched");
  }
  async getState(options: {
    includeScreenshot?: boolean;
    includeTree?: boolean;
    windowId?: string;
    reuseRecentTree?: boolean;
  }): Promise<ComputerState> {
    await this.refresh();
    let state: ComputerState = {
      computerId: this.computerId,
      windows: this.windows,
      screenSize: this.size,
      availability: this.currentAvailability,
      capturedAt: new Date().toISOString(),
    };
    if (this.permissions.length) return state;
    if (!options.windowId)
      return {
        ...state,
        ...(options.includeScreenshot ? { screenshot: await this.captureOverview() } : {}),
        accessibility: {
          status: "partial",
          unavailableWindowIds: this.windows.map((w) => w.id),
        },
      };
    // refresh() already enumerated the windows. Native observation also
    // verifies PID/window ownership, so a second desktop enumeration buys nothing.
    const { pid, window_id, window } = await this.target(options.windowId, false);
    state = { ...state, windows: [window] };
    if (!options.includeTree && !options.includeScreenshot) return state;
    if (options.includeTree && options.reuseRecentTree && !options.includeScreenshot) {
      const cached = this.recentTrees.get(options.windowId);
      if (cached && Date.now() - cached.at < RECENT_TREE_TTL_MS)
        return {
          ...state,
          root: cached.root,
          accessibility: { status: "partial", unavailableWindowIds: [] },
        };
    }
    // A read that did not ask for pixels skips capture, encode, and image
    // delivery — but only because the flag travels on the wire: the driver
    // treats an ABSENT include_screenshot as true, so explicit false is the
    // pinned no-capture contract. (The retired AX_ONLY flag omitted the
    // field to "pin" the same contract and got a full-size frame instead.)
    const wantsPixels = options.includeScreenshot === true;
    let result: CuaToolResult;
    try {
      result = await this.call("get_window_state", {
        pid,
        window_id,
        include_screenshot: wantsPixels,
        max_dimension: 1536,
        include_accessibility_tree: options.includeTree === true,
        max_elements: 1024,
        max_depth: 25,
      });
      this.assertObservedWindow(result, pid, window_id);
    } catch (error) {
      // Past the target, a read that asked for pixels produced no frame, so
      // capture health flips. A tree-only failure never touched capture — a
      // timed-out AX walk on a heavy app must not mark it unavailable — while
      // the throw itself stands exactly as before.
      if (wantsPixels) this.markCaptureFailed(error);
      throw error;
    }
    const data = result.structuredContent ?? {};
    const children: ComputerUiNode[] = [];
    if (Array.isArray(data.elements))
      for (const value of data.elements.slice(0, 1024)) {
        const element = record(value);
        if (!element.frame) continue;
        const frame = optionalRect(element.frame);
        if (!frame) continue;
        const node: ComputerUiNode = {
          role: text(element.role, 128),
          label: text(element.label) || null,
          value: typeof element.value === "string" ? text(element.value, 16384) : null,
          description: text(element.value_description) || null,
          frame,
          activationPoint: {
            x: frame.x + frame.width / 2,
            y: frame.y + frame.height / 2,
          },
          onScreen: window.visible,
          windowId: window.id,
          children: [],
        };
        if (typeof element.element_token === "string") {
          this.elementTokens.set(node, element.element_token);
          if (element.in_web_content === true) this.webContentElements.add(node);
          if (Array.isArray(element.actions))
            this.elementActions.set(
              node,
              new Set(
                element.actions.filter((action): action is string => typeof action === "string"),
              ),
            );
        }
        children.push(node);
      }
    const root: ComputerUiNode = {
      role: "AXWindow",
      label: window.title,
      value: null,
      description: null,
      frame: window.bounds!,
      activationPoint: null,
      onScreen: window.visible,
      windowId: window.id,
      truncated: data.elements_complete !== true,
      children,
    };
    this.recentTrees.delete(options.windowId);
    this.recentTrees.set(options.windowId, { at: Date.now(), root });
    while (this.recentTrees.size > 8)
      this.recentTrees.delete(this.recentTrees.keys().next().value!);
    const image = options.includeScreenshot ? this.previewImage(result, window.id) : undefined;
    if (image && "screenshot" in image) {
      if (image.screenshot.region) this.observedGeometry.set(window.id, image.screenshot.region);
    }
    return {
      ...state,
      root,
      accessibility: { status: "partial", unavailableWindowIds: [] },
      ...(image && "screenshot" in image ? { screenshot: image.screenshot } : {}),
      ...(image && "previewNote" in image ? { previewNote: image.previewNote } : {}),
    };
  }
  /**
   * The window's preview image, or a note when only the preview failed. A
   * preview-only failure must not fail the observation: the tree above still
   * stands and input is unaffected — reselecting (observing) the window
   * resumes previews.
   */
  private previewImage(
    result: CuaToolResult,
    windowId: string,
  ): { readonly screenshot: ComputerScreenshot } | { readonly previewNote: string } {
    try {
      return { screenshot: { ...this.screenshot(result), windowId } };
    } catch (error) {
      if (
        !(error instanceof CuaActionError) ||
        !["capture_unavailable", "off_space_capture_unverified"].includes(error.code ?? "")
      )
        throw error;
      if (error.code === "off_space_capture_unverified")
        return {
          previewNote:
            "This window is on another macOS Space. Its preview is paused because frame freshness cannot be proven without switching Spaces; exact retained semantic text may still continue.",
        };
      this.markCaptureFailed(error);
      return {
        previewNote:
          "The preview for this window failed; input is unaffected. Reselect the window to resume.",
      };
    }
  }
  private async input(
    name: string,
    args: Record<string, unknown>,
    windowId?: string,
    point?: ComputerPoint,
    preparedBounds?: ComputerRect,
  ): Promise<ComputerBackendActionResult> {
    const { pid, window_id, window, baseline } = await this.target(windowId);
    // `select_text` shares the lane with semantic text writes on the same
    // window for a harder reason than convenience: the native semantic lease
    // is per (pid, window) and refuses a second concurrent lease, so a
    // lane-unaware selection would race — or refuse against — a type_text
    // write aimed at the same element. It is also a pure AX attribute write,
    // so it carries no visibility requirement either.
    const semanticLaneWrite =
      name === "select_text" ||
      // `set_value` is the same class of exact semantic mutation the lane
      // exists for: the driver admits it under StableMembership on the same
      // per-(pid, window) lease a concurrent type_text/select_text write
      // would race (same-target → native_input_busy), and an element-token
      // write carries no pointer's visibility requirement — the driver
      // explicitly permits it on minimized, hidden and off-Space windows.
      // Server-side every set_value dispatch is element-addressed (setValue
      // refuses without a token), so the lane condition mirrors the driver's
      // own uses_stable_space_membership check.
      (name === "set_value" &&
        (args.element_token !== undefined || args.element_index !== undefined)) ||
      (name === "type_text" &&
        args.semantic_only === true &&
        desktopDeliveryMode() !== "foreground" &&
        point === undefined);
    if (semanticLaneWrite) {
      return this.semanticTextInLane(pid, window_id, () =>
        this.inputDispatch(name, args, windowId, point, preparedBounds, true, {
          pid,
          window_id,
          window,
          baseline,
        }),
      );
    }
    return this.inputDispatch(name, args, windowId, point, preparedBounds, false, {
      pid,
      window_id,
      window,
      baseline,
    });
  }

  /**
   * Serialize background semantic text writes that share one exact window.
   * The native semantic lease is per (pid, window): a second concurrent lease
   * on the same window is refused outright, and a web element's
   * compose-set_value-reread sequence must not interleave with a sibling
   * write on the same element. Keying the lane on the window — not the pid —
   * lets distinct windows of one app type truly concurrently while the exact
   * target keeps ordering. Tails only resolve, the map prunes on settle, and
   * the hold timeout fails the caller honestly while the lane drains in order
   * behind it.
   */
  private async semanticTextInLane(
    pid: number,
    window_id: number,
    write: () => Promise<ComputerBackendActionResult>,
  ): Promise<ComputerBackendActionResult> {
    const key = `semantic-text:${pid}:${window_id}`;
    const predecessor = this.semanticTextLanes.get(key) ?? Promise.resolve();
    let releaseLane!: () => void;
    const laneHeld = new Promise<void>((resolve) => {
      releaseLane = resolve;
    });
    this.semanticTextLanes.set(key, laneHeld);
    const laneWaitStarted = Date.now();
    try {
      await predecessor;
      const laneWaitMs = Date.now() - laneWaitStarted;
      const deliveryStarted = Date.now();
      try {
        const result = await withSemanticTextLaneTimeout(write(), this.semanticTextLaneHoldMs);
        console.debug("[computer] semantic text lane write", {
          pid,
          windowId: `cua:${pid}:${window_id}`,
          laneWaitMs,
          deliveryMs: Date.now() - deliveryStarted,
          verified: result.verified,
          effect: result.effect,
        });
        return result;
      } finally {
        await new Promise((resolve) => setTimeout(resolve, this.semanticTextLaneGapMs));
      }
    } finally {
      releaseLane();
      if (this.semanticTextLanes.get(key) === laneHeld) this.semanticTextLanes.delete(key);
    }
  }

  private async inputDispatch(
    name: string,
    args: Record<string, unknown>,
    windowId: string | undefined,
    point: ComputerPoint | undefined,
    preparedBounds: ComputerRect | undefined,
    exactSemanticText: boolean,
    resolved: {
      pid: number;
      window_id: number;
      window: ComputerWindow;
      baseline: number | undefined;
    },
  ): Promise<ComputerBackendActionResult> {
    const { pid, window_id, window, baseline } = resolved;
    if (!window.visible && !exactSemanticText) {
      const message =
        "The target window is not on the current Space or not on screen. Only an exact retained semantic text element may be mutated without activation; pointer, synthetic keyboard, and generic window actions require computer_activate_window followed by fresh state.";
      throw new CuaActionError(message, "not-dispatched", "target_not_on_active_space", {
        windowId: window.id,
        message,
      });
    }
    const bounds = window.bounds!;
    if (preparedBounds && !sameRect(preparedBounds, bounds))
      throw new CuaActionError(
        "Target moved after drag preparation; obtain a new screenshot.",
        "not-dispatched",
        "stale_geometry",
      );
    const observed = this.observedGeometry.get(window.id);
    if (point && (!observed || !sameRect(observed, bounds)))
      throw new CuaActionError(
        "Window geometry changed since observation; obtain a new screenshot.",
        "not-dispatched",
        "stale_geometry",
      );
    // Fence the dispatch against the generation the target was resolved in.
    // The span above is synchronous today, so the operative guard for a
    // generation that moves mid-flight lives in host(); this refuses before
    // dispatch whenever resolution and injection ever straddle an await.
    if (baseline !== undefined && this.desktopEpoch !== undefined && this.desktopEpoch !== baseline)
      throw new CuaActionError(
        "The desktop changed after this target was resolved. Observe again before continuing.",
        "not-dispatched",
        "stale_desktop_epoch",
      );
    let pixel: Record<string, unknown> = {};
    if (point) {
      // Model image pixels have already been mapped to desktop logical points.
      // Native revision 3 validates the exact current target and converts these
      // local logical points without capturing another PNG to infer scale.
      const x = point.x - bounds.x,
        y = point.y - bounds.y;
      if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        x < 0 ||
        y < 0 ||
        x >= bounds.width ||
        y >= bounds.height
      )
        throw new CuaActionError("Point is outside the target window.", "not-dispatched");
      pixel = { x, y, coordinate_space: "window_points" };
    }
    assertDesktopOperationActive();
    let result: CuaToolResult;
    try {
      result = await this.call(
        name,
        {
          pid,
          window_id,
          // Always-background semantic AX writes take no delivery_mode —
          // there is no foreground/background split for an attribute write.
          ...(name !== "set_value" && name !== "select_text"
            ? { delivery_mode: desktopDeliveryMode() }
            : {}),
          ...args,
          ...pixel,
          ...(point || preparedBounds ? { expected_window_bounds: preparedBounds ?? bounds } : {}),
        },
        true,
      );
    } catch (error) {
      // A revoke, abort, or uncertain delivery can follow partial input, so the
      // grounding the next input would check against cannot survive it. Clean
      // refusals (nothing dispatched) keep it, so a pause recovery does not pay
      // for a recapture it does not need.
      if (
        desktopOperationSignal()?.aborted ||
        (error instanceof CuaActionError && error.effect === "dispatched-unknown")
      )
        this.observedGeometry.clear();
      throw error;
    } finally {
      // An error can follow partial input, so cached pixels cannot survive it.
      this.clearCachedImage();
      this.snapshotAt = 0;
    }
    const data = result.structuredContent ?? {};
    // Cua 0.24 publishes ActionResult, replacing internal `path` with `route`
    // and delivery metadata. Confirmed effects require its public evidence.
    const confirmed =
      data.effect === "confirmed" &&
      Array.isArray(data.evidence) &&
      data.evidence.some((item) =>
        ["value_readback", "window_change"].includes(text(record(item).kind)),
      );
    const mode = text(record(data.delivery).mode, 32) || "unknown";
    // Most tools report `route`; a few (scroll among them) still report `path`.
    const route = text(data.route, 64) || text(data.path, 64);
    return {
      windowId: window.id,
      ...(point ? { point } : {}),
      deliveryPath: `cua-${route || "unknown"}-${mode}`,
      verified: confirmed
        ? "confirmed"
        : data.effect === "unconfirmed" || data.effect === "suspected_noop"
          ? "unconfirmed"
          : "unverifiable",
      effect: confirmed ? "verified" : "dispatched-unknown",
    };
  }
  click(p: ComputerPoint, w?: string, modifiers?: readonly ComputerInputModifier[]) {
    return this.input(
      "click",
      {
        force_synthetic: true,
        count: 1,
        ...(modifiers?.length ? { modifier: modifiers.map(cuaKey) } : {}),
      },
      w,
      p,
    );
  }
  doubleClick(p: ComputerPoint, w?: string, modifiers?: readonly ComputerInputModifier[]) {
    return this.input(
      "click",
      {
        force_synthetic: true,
        count: 2,
        ...(modifiers?.length ? { modifier: modifiers.map(cuaKey) } : {}),
      },
      w,
      p,
    );
  }
  tripleClick(p: ComputerPoint, w?: string, modifiers?: readonly ComputerInputModifier[]) {
    return this.input(
      "click",
      {
        force_synthetic: true,
        count: 3,
        ...(modifiers?.length ? { modifier: modifiers.map(cuaKey) } : {}),
      },
      w,
      p,
    );
  }
  rightClick(p: ComputerPoint, w?: string, modifiers?: readonly ComputerInputModifier[]) {
    return this.input(
      "click",
      {
        force_synthetic: true,
        button: "right",
        ...(modifiers?.length ? { modifier: modifiers.map(cuaKey) } : {}),
      },
      w,
      p,
    );
  }
  async moveCursor(p: ComputerPoint, w?: string): Promise<ComputerBackendActionResult> {
    if (w) await this.target(w);
    await this.call("move_cursor", { x: p.x, y: p.y }, true);
    return {
      point: p,
      deliveryPath: "cua-overlay-only",
      verified: "unverifiable",
    };
  }
  async drag(
    from: ComputerPoint,
    to: ComputerPoint,
    durationMs: number,
    windowId?: string,
  ): Promise<ComputerBackendActionResult> {
    // Both scopes are admitted: a drag is exact-target by construction —
    // `target()` below requires a live `cua:<pid>:<window_id>` and `local()`
    // refuses any endpoint outside its bounds. In background mode the native
    // driver applies its own WindowPointer admission (fresh window ownership,
    // not-minimized/hidden, current-Space) before posting the window-local
    // CGEvent gesture, and reports `unverifiable` for surfaces that drop the
    // events, so the caller still verifies the drop from a fresh screenshot.
    // A driver build that predates background drag support refuses with
    // `background_unavailable`; foreground stays the explicit fallback.
    if (durationMs > 10_000)
      throw new CuaActionError(
        "Cua drag duration is limited to 10 seconds.",
        "not-dispatched",
        "unsupported_operation",
      );
    const target = await this.target(windowId);
    const observed = this.observedGeometry.get(target.window.id);
    if (!observed || !sameRect(observed, target.window.bounds!))
      throw new CuaActionError(
        "Window geometry changed since observation; obtain a new screenshot.",
        "not-dispatched",
        "stale_geometry",
      );
    const bounds = target.window.bounds!;
    const local = (p: ComputerPoint) => {
      const x = p.x - bounds.x,
        y = p.y - bounds.y;
      if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        x < 0 ||
        y < 0 ||
        x >= bounds.width ||
        y >= bounds.height
      )
        throw new CuaActionError("Drag crosses outside its target window.", "not-dispatched");
      return { x, y };
    };
    const start = local(from),
      end = local(to);
    return this.input(
      "drag",
      {
        from_x: start.x,
        from_y: start.y,
        to_x: end.x,
        to_y: end.y,
        duration_ms: durationMs,
        coordinate_space: "window_points",
      },
      target.window.id,
      undefined,
      bounds,
    );
  }
  /**
   * A scroll is one wheel gesture at the target point. Two axes and held
   * modifiers ride the same gesture: native rev 16 takes signed per-axis
   * ticks plus a modifier list and posts them as one pixel-unit wheel stream,
   * so a diagonal or ctrl-scroll no longer splits into two dispatches.
   *
   * When the target carries an element token and the request is an unmodified
   * vertical scroll, the driver can try its quietest route first — AppKit
   * scroll-bar AX presses, which never touch the pointer at all — before
   * falling back to the wheel. Signed-tick mode deliberately skips that path:
   * the deltas describe a wheel gesture, and mixing AX travel into wheel
   * gearing would teach the calibration loop a ratio that is neither.
   */
  async scroll(
    p: ComputerPoint | null,
    dx: number,
    dy: number,
    w?: string,
    modifiers?: readonly ComputerInputModifier[],
    target?: ComputerResolvedTarget,
  ) {
    if (!p)
      throw new CuaActionError("Scroll requires a screenshot target point.", "not-dispatched");
    if (!dx && !dy)
      return {
        ...(w ? { windowId: w } : {}),
        scrollDelta: { deltaX: 0, deltaY: 0 },
        deliveryPath: "cua-no-op",
        verified: "unverifiable" as const,
        effect: "not-dispatched" as const,
      };
    // Pinned macOS source defines one targeted line-notch as 120 wheel pixels.
    // Expose the quantization per axis; never multiply a requested pixel into
    // a notch. A nonzero axis still delivers at least one notch.
    const ticksX = dx ? Math.max(1, Math.round(Math.abs(dx) / 120)) : 0;
    const ticksY = dy ? Math.max(1, Math.round(Math.abs(dy) / 120)) : 0;
    if (ticksX > 50 || ticksY > 50)
      throw new CuaActionError(
        "Scroll exceeds Cua's 50-notch limit.",
        "not-dispatched",
        "unsupported_operation",
      );
    const mods = modifiers?.length ? modifiers.map(cuaKey) : undefined;
    const token = target ? this.elementTokens.get(target.node) : undefined;
    const args: Record<string, unknown> =
      token !== undefined && !dx && mods === undefined
        ? // AX-first: the driver resolves the token, tries scroll-bar presses,
          // then falls back to a wheel at the element's centre.
          {
            direction: dy > 0 ? "down" : "up",
            amount: ticksY,
            by: "line",
            element_token: token,
          }
        : {
            // Wheel gesture: `direction` stays the schema-required dominant
            // axis while the signed ticks carry the real per-axis amounts —
            // including a two-axis diagonal in one dispatch.
            direction: ticksY ? (dy > 0 ? "down" : "up") : dx > 0 ? "right" : "left",
            delta_x: ticksX ? Math.sign(dx) * ticksX : 0,
            delta_y: ticksY ? Math.sign(dy) * ticksY : 0,
            ...(mods ? { modifiers: mods } : {}),
          };
    const result = await this.input("scroll", args, w, p);
    return {
      ...result,
      scrollDelta: {
        deltaX: ticksX ? Math.sign(dx) * ticksX * 120 : 0,
        deltaY: ticksY ? Math.sign(dy) * ticksY * 120 : 0,
      },
    };
  }
  typeText(value: string, w?: string, target?: ComputerResolvedTarget) {
    const token = target ? this.elementTokens.get(target.node) : undefined;
    if (target && (!token || !target.node.windowId))
      throw new CuaActionError(
        "The AX text target is not bound to a live Cua token.",
        "not-dispatched",
        "stale_target",
      );
    if (token && this.webContentElements.has(target!.node))
      return this.webContentTypeText(target!.node, value);
    return this.input(
      "type_text",
      {
        text: value,
        ...(token ? { element_token: token, semantic_only: true } : { force_synthetic: true }),
      },
      target?.node.windowId ?? w,
    );
  }
  /**
   * Type into a Chromium-family web element. `AXSelectedText` writes dispatch
   * successfully yet never reach the DOM (verified: Electron 43, inactive and
   * frontmost alike), so the write composes `existing + text` through an
   * `AXValue` set — which lands, fires `input`, and leaves the operator's front
   * process untouched — then confirms the DOM value on a fresh read instead of
   * trusting the dispatch reply.
   */
  private async webContentTypeText(
    node: ComputerUiNode,
    value: string,
  ): Promise<ComputerBackendActionResult> {
    const windowId = node.windowId!;
    const { pid, window_id } = await this.target(windowId);
    return this.semanticTextInLane(pid, window_id, async () => {
      const before = await this.resolveWebField(windowId, node);
      if (!before)
        throw new CuaActionError(
          "The web text element is no longer present; observe fresh state.",
          "not-dispatched",
          "stale_target",
        );
      const composed = (before.value ?? "") + value;
      assertDesktopOperationActive();
      return await this.webSetValue(node, windowId, before, composed);
    });
  }
  /**
   * Write an `AXValue` into a web element and confirm it on a fresh read. The
   * driver's own read-back runs before Chromium publishes the new value and so
   * reports `unverifiable` on writes that landed; verification here re-resolves
   * the element and compares its DOM-visible value.
   */
  private async webSetValue(
    node: ComputerUiNode,
    windowId: string,
    field: { token: string; index: number },
    value: string,
  ): Promise<ComputerBackendActionResult> {
    const result = await this.inputDispatch(
      "set_value",
      { element_token: field.token, element_index: field.index, value },
      windowId,
      undefined,
      undefined,
      true,
      await this.target(windowId),
    );
    assertDesktopOperationActive();
    const after = await this.resolveWebField(windowId, node);
    if (after?.value === value) return { ...result, verified: "confirmed", effect: "verified" };
    return { ...result, verified: "unconfirmed", effect: "dispatched-unknown" };
  }
  /**
   * Re-observe one window and return the record for the same web element.
   * Tokens are snapshot-scoped, so identity matches on role + label + frame,
   * the stable tuple an unchanged element keeps across driver snapshots.
   */
  private async resolveWebField(
    windowId: string,
    node: ComputerUiNode,
  ): Promise<{ token: string; index: number; value: string | null } | undefined> {
    const { pid, window_id } = await this.target(windowId);
    const result = await this.call("get_window_state", {
      pid,
      window_id,
      include_accessibility_tree: true,
      max_elements: 1024,
      max_depth: 25,
    });
    const elements = result.structuredContent?.elements;
    if (!Array.isArray(elements)) return undefined;
    for (const value of elements) {
      const element = record(value);
      if (element.in_web_content !== true) continue;
      if (text(element.role, 128) !== node.role) continue;
      if ((text(element.label) || null) !== node.label) continue;
      const frame = optionalRect(element.frame);
      if (!frame || !sameRect(frame, node.frame)) continue;
      if (typeof element.element_token !== "string") continue;
      const index = number(element.element_index);
      return {
        token: element.element_token,
        index: Number.isFinite(index) ? index : 0,
        value: typeof element.value === "string" ? element.value : null,
      };
    }
    return undefined;
  }
  pressKey(key: string, w?: string) {
    return this.input("press_key", { key: cuaKey(key) }, w);
  }
  hotkey(keys: readonly string[], w?: string) {
    const native = keys.map(cuaKey);
    const modifiers = new Set([
      "command",
      "cmd",
      "shift",
      "option",
      "alt",
      "ctrl",
      "control",
      "fn",
    ]);
    if (native.length < 2 || native.filter((key) => !modifiers.has(key)).length !== 1)
      throw new CuaActionError(
        "A shortcut requires modifiers and exactly one other key.",
        "not-dispatched",
        "invalid_chord",
      );
    return this.input("hotkey", { keys: native }, w);
  }
  async setValue(target: ComputerResolvedTarget, value: string) {
    const token = this.elementTokens.get(target.node);
    if (!token || !target.node.windowId)
      throw new CuaActionError(
        "The AX target is not bound to a live Cua token.",
        "not-dispatched",
        "stale_target",
      );
    if (this.webContentElements.has(target.node)) {
      // The web path composes read → set_value → re-read on the same native
      // semantic lease, so the whole compose takes the lane — the same shape
      // webContentTypeText uses — instead of racing a same-window sibling.
      const windowId = target.node.windowId;
      const { pid, window_id } = await this.target(windowId);
      return this.semanticTextInLane(pid, window_id, async () => {
        const field = await this.resolveWebField(windowId, target.node);
        if (!field)
          throw new CuaActionError(
            "The web text element is no longer present; observe fresh state.",
            "not-dispatched",
            "stale_target",
          );
        return this.webSetValue(target.node, windowId, field, value);
      });
    }
    return this.input("set_value", { element_token: token, value }, target.node.windowId);
  }
  supportsAction(target: ComputerResolvedTarget, action: string): boolean {
    const spec = cuaElementAction(action);
    return spec !== undefined && this.elementActions.get(target.node)?.has(spec.axAction) === true;
  }
  async performAction(target: ComputerResolvedTarget, action: string) {
    const spec = cuaElementAction(action);
    if (spec === undefined)
      throw new CuaActionError(
        `Cua does not expose ${action} through this integration.`,
        "not-dispatched",
        "unsupported_operation",
      );
    const token = this.elementTokens.get(target.node);
    if (!token || !target.node.windowId)
      throw new CuaActionError(
        "The AX target is no longer valid.",
        "not-dispatched",
        "stale_target",
      );
    // Past AXPress the driver would submit an action the element never
    // advertised and report the outcome as merely suspected_noop; refuse
    // instead so an unsupported action is a clean non-dispatch. AXPress
    // itself keeps its long-standing dispatch — the driver degrades it to a
    // verified AXSelected write on collection items that never advertised it.
    if (
      spec.axAction !== "AXPress" &&
      this.elementActions.get(target.node)?.has(spec.axAction) !== true
    )
      throw new CuaActionError(
        `The resolved element does not advertise ${spec.axAction}; ${action} was not dispatched.`,
        "not-dispatched",
        "unsupported_operation",
      );
    return this.input(
      "click",
      { element_token: token, action: spec.driverAction },
      target.node.windowId,
    );
  }
  /**
   * Exact-range selection through `AXSelectedTextRange`: the native tool
   * writes a CFRange on the fresh element token and verifies by reading the
   * attribute back. Web content is deliberately not special-cased — the
   * driver refuses a marker-range-only target pre-dispatch rather than
   * approximating it with gestures, and Synara never composes a workaround.
   */
  async selectText(target: ComputerResolvedTarget, range: ComputerTextRange) {
    const token = this.elementTokens.get(target.node);
    if (!token || !target.node.windowId)
      throw new CuaActionError(
        "The AX text target is not bound to a live Cua token.",
        "not-dispatched",
        "stale_target",
      );
    return this.input(
      "select_text",
      { element_token: token, start: range.start, length: range.length },
      target.node.windowId,
    );
  }
  async readClipboard(): Promise<string> {
    const data =
      (await this.call("clipboard_read", { include_text: true }, true)).structuredContent ?? {};
    if (typeof data.text !== "string")
      throw new Error("The clipboard does not contain readable text.");
    if (data.text.length > 16384) throw new Error("Clipboard exceeds the tool's text limit.");
    return data.text;
  }
  async writeClipboard(value: string) {
    assertComputerClipboardWriteFits(value);
    await this.call("clipboard_write", { text: value }, true);
  }
  async launchApp(app: string, args?: readonly string[], options?: { readonly hidden?: boolean }) {
    if (app.startsWith("/"))
      throw new CuaActionError(
        "Use an installed app's name or bundle identifier with Cua.",
        "not-dispatched",
        "unsupported_operation",
      );
    await this.call(
      "launch_app",
      {
        ...(/^[a-zA-Z][\w-]*(\.[\w-]+)+$/.test(app) ? { bundle_id: app } : { name: app }),
        ...(args?.length ? { additional_arguments: args } : {}),
        // The open -j posture: windows are created but never rendered, and
        // nothing activates. Only sent when asked — an absent flag is the
        // ordinary background launch every existing caller expects.
        ...(options?.hidden === true ? { hidden: true } : {}),
      },
      true,
    );
    return { computerId: this.computerId, app, window: null };
  }
  async listApps(): Promise<readonly ComputerApp[]> {
    const result = await this.call("list_apps");
    const rows = result.structuredContent?.apps;
    if (!Array.isArray(rows))
      throw new CuaActionError(
        "Cua returned an invalid app list.",
        "not-dispatched",
        "invalid_response",
      );
    const apps: ComputerApp[] = [];
    for (const value of rows) {
      const row = record(value);
      // pid is 0 for installed-but-not-running apps — those rows are the
      // "is X installed?" half of the tool and must not be dropped.
      const pid = number(row.pid);
      const name = text(row.name, 512) || text(row.app_name, 512);
      if (!Number.isSafeInteger(pid) || pid < 0 || !name) continue;
      const bundleId = text(row.bundle_id, 512);
      // The driver's signature read, when it has one: durable consent grants
      // pin to bundle id + team id, so a missing team id only ever narrows
      // what a grant can match — it never invents an identity.
      const teamId = text(row.team_id, 128) || text(row.signing_team_id, 128);
      const launchPath = text(row.launch_path, 4_096);
      const lastUsed = text(row.last_used, 64);
      apps.push({
        pid,
        name: name.slice(0, 256),
        running: row.running === true || pid > 0,
        active: row.active === true || row.is_active === true,
        ...(bundleId ? { bundleId } : {}),
        ...(teamId ? { teamId } : {}),
        ...(launchPath ? { launchPath } : {}),
        ...(Array.isArray(row.windows) ? { windowCount: row.windows.length } : {}),
        ...(lastUsed ? { lastUsed } : {}),
      });
    }
    return apps.slice(0, 1_024);
  }
  async setWindowFrame(
    windowId: string,
    frame: ComputerRect,
  ): Promise<ComputerBackendActionResult> {
    if (!Object.values(frame).every(Number.isFinite) || frame.width <= 0 || frame.height <= 0)
      throw new CuaActionError(
        "A window frame needs finite coordinates and a positive size.",
        "not-dispatched",
        "invalid_geometry",
      );
    const { pid, window_id, window } = await this.target(windowId);
    const result = await this.call(
      "set_window_frame",
      {
        pid,
        window_id,
        x: frame.x,
        y: frame.y,
        width: frame.width,
        height: frame.height,
      },
      true,
    );
    const data = result.structuredContent ?? {};
    // The driver's own `effect: confirmed` + value_readback is not the
    // verification. A mutation was already dispatched, so the only honest
    // confirmation is a fresh list_windows read showing the exact frame on
    // the exact window; a readback that cannot be taken or disagrees leaves
    // the outcome unknown — never a silent success.
    let observed: ComputerRect | undefined;
    try {
      observed = (await this.readWindows()).find((candidate) => candidate.id === window.id)?.bounds;
    } catch {
      observed = undefined;
    }
    const confirmed = observed !== undefined && sameRect(observed, frame);
    // Ground the next input on what the read-back actually saw, not on the
    // requested frame: when the move did not land, `observed` is still the
    // true geometry; when the read-back itself failed, nothing may stay.
    if (observed !== undefined) this.observedGeometry.set(window.id, observed);
    else this.observedGeometry.delete(window.id);
    this.clearCachedImage();
    this.snapshotAt = 0;
    return {
      windowId: window.id,
      deliveryPath: `cua-${text(data.route, 64) || "window_frame"}-${text(record(data.delivery).mode, 32) || "background"}`,
      verified: confirmed ? "confirmed" : "unconfirmed",
      effect: confirmed ? "verified" : "dispatched-unknown",
    };
  }
  async invokeMenu(
    windowId: string,
    path: readonly string[],
  ): Promise<ComputerBackendActionResult> {
    // Fail closed rather than truncate: a sliced path can resolve to a
    // different menu item than the caller named, which is worse than a refusal.
    if (path.length === 0 || path.length > 6 || path.some((segment) => segment.trim().length === 0))
      throw new CuaActionError(
        "A menu path needs one to six non-empty titles.",
        "not-dispatched",
        "invalid_arguments",
      );
    const { pid, window_id, window } = await this.target(windowId);
    const result = await this.call("invoke_menu", { pid, window_id, path: [...path] }, true);
    const data = result.structuredContent ?? {};
    const confirmed = data.effect === "confirmed";
    // A menu command can open or close windows (a Save dialog, a Quit): the
    // cached snapshot no longer describes the desktop.
    this.clearCachedImage();
    this.snapshotAt = 0;
    return {
      windowId: window.id,
      deliveryPath: `cua-${text(data.route, 64) || "menu"}-${text(record(data.delivery).mode, 32) || "background"}`,
      verified: confirmed
        ? "confirmed"
        : data.effect === "unconfirmed"
          ? "unconfirmed"
          : "unverifiable",
      effect: confirmed ? "verified" : "dispatched-unknown",
    };
  }
  async setWindowMinimized(
    windowId: string,
    minimized: boolean,
  ): Promise<ComputerBackendActionResult> {
    // Fail closed rather than coerce: a non-boolean flag cannot be honored
    // exactly, and guessing a direction hides the caller's mistake.
    if (typeof minimized !== "boolean")
      throw new CuaActionError(
        "set_window_minimized needs a boolean minimized flag.",
        "not-dispatched",
        "invalid_arguments",
      );
    const { pid, window_id, window } = await this.target(windowId);
    const result = await this.call("set_window_minimized", { pid, window_id, minimized }, true);
    const data = result.structuredContent ?? {};
    const confirmed = confirmedValueReadback(data);
    // A minimize or restore changes what is on screen; the cached snapshot
    // and retained geometry no longer describe it.
    this.clearCachedImage();
    this.snapshotAt = 0;
    return {
      windowId: window.id,
      deliveryPath: `cua-${text(data.route, 64) || "window_minimized"}-${text(record(data.delivery).mode, 32) || "background"}`,
      verified: confirmed
        ? "confirmed"
        : data.effect === "unconfirmed" || data.effect === "suspected_noop"
          ? "unconfirmed"
          : "unverifiable",
      effect: confirmed ? "verified" : "dispatched-unknown",
    };
  }
  async setAppVisibility(pid: number, hidden: boolean): Promise<ComputerBackendActionResult> {
    if (!Number.isSafeInteger(pid) || pid <= 0 || typeof hidden !== "boolean")
      throw new CuaActionError(
        "set_app_visibility needs a positive integer pid and a boolean hidden flag.",
        "not-dispatched",
        "invalid_arguments",
      );
    const result = await this.call("set_app_visibility", { pid, hidden }, true);
    const data = result.structuredContent ?? {};
    const confirmed = confirmedValueReadback(data);
    this.clearCachedImage();
    this.snapshotAt = 0;
    return {
      deliveryPath: `cua-${text(data.route, 64) || "app_visibility"}-${text(record(data.delivery).mode, 32) || "background"}`,
      verified: confirmed
        ? "confirmed"
        : data.effect === "unconfirmed" || data.effect === "suspected_noop"
          ? "unconfirmed"
          : "unverifiable",
      effect: confirmed ? "verified" : "dispatched-unknown",
    };
  }
  async verifyState(
    windowId: string,
    expect: readonly Record<string, unknown>[],
  ): Promise<ComputerVerifyStateResult> {
    // Fail closed rather than truncate: a sliced predicate set can answer a
    // different question than the caller asked, which is worse than a refusal.
    if (
      expect.length === 0 ||
      expect.length > 8 ||
      expect.some((item) => !item || typeof item !== "object" || Array.isArray(item))
    )
      throw new CuaActionError(
        "verify_state needs one to eight object predicates.",
        "not-dispatched",
        "invalid_arguments",
      );
    const { pid, window_id } = await this.target(windowId);
    const result = await this.call("verify_state", {
      pid,
      window_id,
      expect: [...expect],
    });
    const data = result.structuredContent ?? {};
    // `unknown` is a verdict, not a failure shape: the driver could not prove
    // the predicate either way, which must never collapse into `unsatisfied`.
    const status =
      data.status === "satisfied" || data.status === "unsatisfied" || data.status === "unknown"
        ? data.status
        : "unknown";
    return {
      status,
      stable: data.stable === true,
      samples: Math.max(0, Math.trunc(number(data.samples) || 0)),
      elapsedMs: Math.max(0, Math.trunc(number(data.elapsed_ms) || 0)),
      predicates: Array.isArray(data.predicates) ? data.predicates.slice(0, 8) : [],
    };
  }
  async killApp(pid: number): Promise<ComputerBackendActionResult> {
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw new CuaActionError(
        "kill_app needs a positive integer pid.",
        "not-dispatched",
        "invalid_arguments",
      );
    // kill_app is not an action-result tool: success is a bare "sent SIGKILL"
    // text reply, so the only honest confirmation is an independent check that
    // the process is actually gone afterwards.
    await this.call("kill_app", { pid }, true);
    // The window set is stale the moment the signal lands: drop the cached
    // snapshot and every retained geometry for the dead pid before the
    // read-back, so nothing grounds a later call on a window that no longer
    // exists.
    this.clearCachedImage();
    this.snapshotAt = 0;
    // Map iterators tolerate deletion mid-walk: a key already visited is gone,
    // one still pending is simply skipped — exactly what this loop wants.
    for (const key of this.observedGeometry.keys())
      if (key.startsWith(`cua:${pid}:`)) this.observedGeometry.delete(key);
    // A killed process can linger in the app list for a beat while the OS
    // reaps it — poll briefly before admitting the kill is unconfirmed.
    let gone = false;
    for (let attempt = 0; attempt < 4 && !gone; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 250));
      gone = !(await this.listApps()).some((app) => app.pid === pid && app.running);
    }
    return {
      deliveryPath: "cua-process_signal-background",
      verified: gone ? "confirmed" : "unconfirmed",
      effect: gone ? "verified" : "dispatched-unknown",
    };
  }
  async zoomWindow(windowId: string, region: ComputerRect): Promise<ComputerZoomResult> {
    if (!Object.values(region).every(Number.isFinite) || region.width <= 0 || region.height <= 0)
      throw new CuaActionError(
        "The zoom region needs finite geometry and positive size.",
        "not-dispatched",
        "invalid_geometry",
      );
    const { pid, window_id, window } = await this.target(windowId);
    const bounds = window.bounds!;
    if (
      region.x < 0 ||
      region.y < 0 ||
      region.x + region.width > bounds.width ||
      region.y + region.height > bounds.height
    )
      throw new CuaActionError(
        "The zoom region lies outside the target window.",
        "not-dispatched",
        "invalid_geometry",
      );
    // The driver crops in "screenshot pixels" — the pixel space of its own
    // get_window_state capture for this exact window, which is the window's
    // display backing factor, not necessarily the main display's. Read that
    // scale from a fresh capture-only state call (no max_dimension, so the
    // returned image is the driver's native-resolution space) rather than
    // assuming the desktop scale applies.
    let state: CuaToolResult;
    try {
      state = await this.call("get_window_state", {
        pid,
        window_id,
        include_accessibility_tree: false,
        include_screenshot: true,
      });
      this.assertObservedWindow(state, pid, window_id);
    } catch (error) {
      if (!(error instanceof CuaActionError) || error.code !== "off_space_capture_unverified")
        this.markCaptureFailed(error);
      throw error;
    }
    const stateData = state.structuredContent ?? {};
    const freshBounds = stateData.window_bounds ? optionalRect(stateData.window_bounds) : undefined;
    if (!freshBounds || !sameRect(freshBounds, bounds))
      throw new CuaActionError(
        "The target window moved before the zoom capture.",
        "not-dispatched",
        "stale_target",
      );
    const reportedScale = number(stateData.screenshot_scale);
    const fallback = this.screenshot(state, freshBounds);
    const scale =
      Number.isFinite(reportedScale) && reportedScale > 0 ? reportedScale : (fallback.scale ?? 0);
    if (!(scale > 0))
      throw new CuaActionError(
        "Cua could not establish the window's screenshot scale.",
        "not-dispatched",
        "capture_unavailable",
      );
    const result = await this.call("zoom", {
      pid,
      window_id,
      x1: region.x * scale,
      y1: region.y * scale,
      x2: (region.x + region.width) * scale,
      y2: (region.y + region.height) * scale,
    });
    const image = result.content?.find(
      (c) => c.type === "image" && c.mimeType === "image/jpeg" && c.data,
    );
    const data = result.structuredContent ?? {};
    if (!image?.data)
      throw new CuaActionError(
        "Cua returned no zoom image.",
        "not-dispatched",
        "capture_unavailable",
      );
    const bytes = Buffer.from(image.data, "base64");
    // Dimensions come from the JPEG's own headers; the structured fields are
    // only a fallback for a driver that omits them, and both must be sane
    // before the result is trusted enough to hand a model.
    const dimensions = jpegDimensions(bytes) ?? {
      width: Math.trunc(number(data.width) || 0),
      height: Math.trunc(number(data.height) || 0),
    };
    if (dimensions.width <= 0 || dimensions.height <= 0)
      throw new CuaActionError(
        "Cua returned a zoom image without readable dimensions.",
        "not-dispatched",
        "invalid_response",
      );
    return {
      mimeType: "image/jpeg" as const,
      width: dimensions.width,
      height: dimensions.height,
      sizeBytes: bytes.byteLength,
      bytesBase64: image.data,
      windowId: window.id,
      capturedAt: new Date().toISOString(),
    };
  }
  async getAccessibilityTree(windowId?: string): Promise<{
    readonly apps: readonly ComputerAccessibilityTreeApp[];
    readonly windows: readonly ComputerAccessibilityTreeWindow[];
    readonly truncated: boolean;
  }> {
    // The driver's snapshot is desktop-wide and takes no arguments at all —
    // the named tool is the fast no-grant inventory, not a per-window AX
    // walk. `window_id` scoping is therefore a Synara-side filter to the app
    // that owns the exact window, resolved through the same fresh target()
    // every window read uses.
    const scopedPid = windowId === undefined ? undefined : (await this.target(windowId)).pid;
    const result = await this.call("get_accessibility_tree");
    const data = result.structuredContent ?? {};
    if (!Array.isArray(data.apps) || !Array.isArray(data.windows))
      throw new CuaActionError(
        "Cua returned an invalid desktop inventory.",
        "not-dispatched",
        "invalid_response",
      );
    const apps: ComputerAccessibilityTreeApp[] = [];
    for (const value of data.apps) {
      const row = record(value);
      const pid = number(row.pid);
      const name = text(row.name);
      // This inventory only ever lists running apps, so a non-positive pid is
      // a malformed row, not the not-running marker list_apps uses.
      if (!Number.isSafeInteger(pid) || pid <= 0 || name.length === 0) continue;
      if (scopedPid !== undefined && pid !== scopedPid) continue;
      const bundleId = text(row.bundle_id, 512);
      apps.push({ pid, name, ...(bundleId ? { bundleId } : {}) });
    }
    const windows: ComputerAccessibilityTreeWindow[] = [];
    for (const value of data.windows) {
      const row = record(value);
      const pid = number(row.pid);
      const wid = number(row.window_id);
      // Without the driver id pair no Synara window id can be formed, so the
      // row is unresolvable rather than merely thin.
      if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(wid) || wid <= 0)
        continue;
      if (scopedPid !== undefined && pid !== scopedPid) continue;
      const appName = text(row.app_name);
      const bounds = optionalRect(row.bounds);
      const zIndex = number(row.z_index);
      windows.push({
        id: `cua:${pid}:${wid}`,
        pid,
        ...(appName ? { appName } : {}),
        title: text(row.title),
        ...(bounds ? { bounds } : {}),
        ...(typeof row.is_on_screen === "boolean" ? { onScreen: row.is_on_screen } : {}),
        ...(Number.isInteger(zIndex) && zIndex >= 0 ? { zIndex } : {}),
      });
    }
    const truncated = apps.length > 1_024 || windows.length > COMPUTER_WINDOW_LIST_MAX_LENGTH;
    return {
      apps: apps.slice(0, 1_024),
      windows: windows.slice(0, COMPUTER_WINDOW_LIST_MAX_LENGTH),
      truncated,
    };
  }
  async getCursorPosition(
    windowId?: string,
  ): Promise<Omit<ComputerCursorPosition, "computerId" | "availability">> {
    // A scoped read also answers "is the cursor inside this window": the
    // position itself is desktop-global either way, so scoping resolves the
    // window's current bounds rather than changing what the driver returns.
    const window = windowId === undefined ? undefined : (await this.target(windowId)).window;
    const result = await this.call("get_cursor_position");
    const data = result.structuredContent ?? {};
    const x = number(data.x);
    const y = number(data.y);
    if (!Number.isFinite(x) || !Number.isFinite(y))
      throw new CuaActionError(
        "Cua returned no cursor position.",
        "not-dispatched",
        "invalid_response",
      );
    const bounds = window?.bounds;
    return {
      x,
      y,
      capturedAt: new Date().toISOString(),
      ...(window ? { windowId: window.id } : {}),
      ...(bounds
        ? {
            insideWindow:
              x >= bounds.x &&
              x < bounds.x + bounds.width &&
              y >= bounds.y &&
              y < bounds.y + bounds.height,
          }
        : {}),
    };
  }
  async attachStream(listener: ComputerFrameListener) {
    await this.stills.attach(listener);
  }
  async detachStream() {
    this.clearCachedImage();
    await this.stills.detach();
  }
  async requestKeyframe() {
    await this.stills.requestKeyframe();
  }
  async stopInput() {
    this.clearCachedImage();
    this.previewTasks.clear();
    this.previewWindows.clear();
    if (this.endpoint) {
      const result = await this.request<CuaReply>(this.endpoint, {
        method: "stop",
        capability: this.capability,
      });
      this.observeDesktopInterruption(result);
      if (!result.ok)
        throw new CuaActionError(
          result.error ?? "Computer stop was not acknowledged.",
          "dispatched-unknown",
        );
    }
    this.observedGeometry.clear();
    this.snapshotAt = 0;
  }
  /**
   * Relay the user's re-arm to the GUI host, the only place the physical
   * Escape latch lives. The host answers `{rearmed, wasStopped}`; a failed
   * relay throws so the manager keeps its own latch held — reporting input
   * re-armed while the driver still refuses it would be the worst outcome.
   */
  async rearmInput() {
    if (!this.endpoint || this.disposed) {
      throw new CuaActionError(
        "The desktop host is not connected; computer input stays stopped.",
        "not-dispatched",
        "gui_host_required",
      );
    }
    const result = await this.request<CuaReply>(this.endpoint, {
      method: "rearm",
      capability: this.capability,
    });
    if (!result.ok)
      throw new CuaActionError(
        result.error ?? "Computer re-arm was not acknowledged.",
        "not-dispatched",
      );
  }
  async endTask(threadId: string, turnId?: string): Promise<void> {
    if (!this.endpoint || this.disposed) return;
    const matches = [...this.previewTasks].filter(
      ([, task]) => task.threadId === threadId && (turnId === undefined || task.turnId === turnId),
    );
    if (matches.length === 0) return;
    const reply = await this.request<CuaReply>(this.endpoint, {
      method: "end_task",
      task: { threadId, ...(turnId ? { turnId } : {}) },
      capability: this.capability,
    });
    this.observeDesktopInterruption(reply);
    if (!reply.ok) throw new Error(reply.error ?? "Computer preview did not stop.");
    for (const [key] of matches) {
      this.previewTasks.delete(key);
      this.previewWindows.delete(key);
    }
    // Task-owned grounding ends with the task: a revoked task's window pixels
    // must not ground a later claim, so the next input re-observes first.
    this.observedGeometry.clear();
  }
  /**
   * The masked-activation shield, answered by the GUI host itself — the
   * driver never sees these requests. Engage deliberately bypasses
   * {@link host}: it runs inside the activation call's serialized slot
   * already, and its failure must refuse that call rather than be queued
   * behind it. The request is bounded tighter than an ordinary host call —
   * a shield that cannot confirm in five seconds is a wedged helper, and the
   * activation it gates must refuse.
   *
   * `mutation: true` because a lost engage reply is dispatched-unknown: the
   * shield may be up. The server-minted `shield_id` survives exactly that
   * case — the caller releases by id even when the reply never arrived.
   */
  async engageShield(target: ComputerShieldTarget): Promise<string> {
    if (this.disposed || !this.endpoint)
      throw new CuaActionError(
        "Open this session in the Synara macOS desktop app to use Computer.",
        "not-dispatched",
        "gui_host_required",
      );
    assertDesktopOperationActive();
    const match = /^cua:([1-9]\d*):([1-9]\d*)$/.exec(target.windowId);
    if (!match)
      throw new CuaActionError(
        `The activation shield cannot cover window ${target.windowId}: it is not a native window id.`,
        "not-dispatched",
        "invalid_target",
      );
    const task = currentComputerTask();
    // Same attribution the `call` path records: the host's end_task reply
    // releases shields by it, so a task ending mid-engage still cleans up.
    if (task) this.trackPreviewTask(task);
    try {
      const reply = await timedComputerLeg("host", () =>
        this.request<CuaReply>(
          this.endpoint!,
          {
            method: "shield",
            ...(task ? { task } : {}),
            args: {
              action: "engage",
              shield_id: target.shieldId,
              frame: target.frame,
              window_id: Number(match[2]),
              pid: Number(match[1]),
              label: target.label,
            },
            capability: this.capability,
          },
          {
            signal: desktopOperationSignal(),
            mutation: true,
            timeoutMs: 5_000,
          },
        ),
      );
      if (!reply.ok)
        throw new CuaActionError(
          reply.error ?? "The activation shield was refused.",
          "not-dispatched",
          "mask_unavailable",
        );
      return target.shieldId;
    } catch (error) {
      if (error instanceof CuaTransportError)
        throw new CuaActionError(error.message, error.effect, "mask_unavailable");
      throw error;
    }
  }
  /**
   * Release paths ride `request` directly — never the operation signal — so
   * they still land while their own operation is being cancelled. That is
   * the whole point: a shield outlives nothing.
   */
  async releaseShield(shieldId: string): Promise<void> {
    if (!this.endpoint || this.disposed) return;
    const reply = await this.request<CuaReply>(
      this.endpoint,
      {
        method: "shield",
        args: { action: "release", shield_id: shieldId },
        capability: this.capability,
      },
      { timeoutMs: 5_000 },
    );
    if (!reply.ok)
      throw new CuaActionError(
        reply.error ?? "The activation shield did not release.",
        "not-dispatched",
      );
  }
  /** The forced-release escape hatch; safe in every host state. */
  async releaseAllShields(): Promise<void> {
    if (!this.endpoint || this.disposed) return;
    const reply = await this.request<CuaReply>(
      this.endpoint,
      {
        method: "shield",
        args: { action: "release_all" },
        capability: this.capability,
      },
      { timeoutMs: 5_000 },
    );
    if (!reply.ok)
      throw new CuaActionError(
        reply.error ?? "The activation shields did not release.",
        "not-dispatched",
      );
  }
  /**
   * The CDP browser surface. Present whenever this backend exists — the GUI
   * host admits the driver's browser family — so the gateway can advertise
   * `computer_browser_*` whenever the computer surface is supported.
   *
   * Deliberately NOT routed through `call()`: the desktop path converts
   * `isError`/`status:"refused"` replies into thrown `CuaActionError`s, but
   * a browser refusal IS the result the model must branch on. Desktop-epoch
   * staleness and model-observation bookkeeping are skipped for the same
   * reason — a browser reply describes a CDP surface, not the desktop.
   */
  readonly browser: ComputerBrowserBackend = {
    call: (call) => this.browserCall(call),
    endThread: (threadId) => this.endBrowserThread(threadId),
  };
  private async browserCall(call: ComputerBrowserCall): Promise<ComputerBrowserCallResult> {
    if (this.disposed || !this.endpoint)
      throw new CuaActionError(
        "Open this session in the Synara macOS desktop app to use Computer.",
        "not-dispatched",
        "gui_host_required",
      );
    assertDesktopOperationActive();
    const task: CuaComputerTask = {
      threadId: call.task.threadId,
      ...(call.task.turnId ? { turnId: call.task.turnId } : {}),
      ...(call.task.label ? { label: call.task.label } : {}),
    };
    // Browser work is a live preview task too: an endTask must still reach
    // the host (frame tap, shields), and a bind call carrying the bound
    // window's pid/window_id is what scopes the stills to it.
    this.trackPreviewTask(task);
    try {
      const reply = await timedComputerLeg("host", () =>
        this.request<CuaReply>(
          this.endpoint!,
          {
            method: "call",
            name: call.name,
            args: call.args,
            task,
            capability: this.capability,
          },
          { signal: call.signal, mutation: call.mutation, timeoutMs: 35_000 },
        ),
      );
      // Desktop-epoch bookkeeping stays skipped on the CDP surface, but the
      // interruption count is host state, not reply semantics: a browser
      // reply proving a lock ran still invalidates pre-interruption consent.
      this.observeDesktopInterruption(reply);
      if (!reply.ok)
        throw new CuaActionError(
          reply.error ?? "Cua host failed.",
          reply.effect ?? "not-dispatched",
        );
      this.recordPreviewWindow(task, call.args, reply.result);
      return reply.result ?? {};
    } catch (error) {
      if (error instanceof CuaTransportError) throw new CuaActionError(error.message, error.effect);
      throw error;
    }
  }
  /**
   * Thread-scoped browser teardown. Thread removal is reversible (archive →
   * unarchive), but the session-end hooks are the driver's authoritative
   * cleanup — endpoints, grants, and owned browsers release now, and a
   * revived thread's next call reopens the same label via `start_session`.
   */
  private async endBrowserThread(threadId: string): Promise<void> {
    if (!this.endpoint || this.disposed) return;
    const reply = await this.request<CuaReply>(this.endpoint, {
      method: "end_browser_thread",
      task: { threadId },
      capability: this.capability,
    });
    this.observeDesktopInterruption(reply);
    if (!reply.ok) throw new Error(reply.error ?? "Browser session teardown was not acknowledged.");
  }
  async dispose() {
    this.clearCachedImage();
    await this.stills.detach();
    // Teardown cannot depend on the host still answering: an unreachable
    // endpoint means the input path it owned is already gone, so a transport
    // failure here confirms rather than defeats the stop.
    await this.stopInput().catch(() => undefined);
    this.disposed = true;
    this.listeners.clear();
  }
}
