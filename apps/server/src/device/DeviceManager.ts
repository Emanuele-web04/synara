/**
 * DeviceManager - thread-scoped device attachment and boot ownership.
 *
 * State the manager owns, and why it owns it rather than the backend:
 *
 * - Attachment is per thread (one device per thread, mirroring
 *   `ThreadBrowserState`). A thread's `ThreadDeviceState` is versioned and
 *   pushed on `device.event` so panes can drop stale snapshots.
 * - Boot source. The backend cannot tell who booted a device, so the manager
 *   records the devices it booted itself. Only those are ever auto-shut-down;
 *   anything the user started (pane picker, Simulator.app) outlives us.
 * - The Synara boot cap (`DEVICE_SYNARA_BOOT_LIMIT`). Boot past the cap is
 *   refusable rather than fatal: the caller is handed the shutdown candidates
 *   so the pane can prompt.
 * - Shutdown triggers: app quit (`dispose`), thread removal
 *   (`handleThreadRemoved`), and an idle timeout after the last agent turn or detach.
 *
 * Everything the manager does to the device itself goes through DeviceBackend,
 * so the whole state machine is testable against `FakeDeviceBackend`.
 *
 * @module device/DeviceManager
 */
import {
  NULL_BOOT_OWNERSHIP,
  orphanedBootUdids,
  processIsAlive,
  type BootOwnershipStore,
} from "./bootOwnership.ts";
import {
  DEVICE_SYNARA_BOOT_LIMIT,
  DEVICE_THREAD_STATE_MAX_DEVICES,
  ThreadId,
  type DeviceAttachPhase,
  type DeviceAvailability,
  type DeviceBootResult,
  type DeviceDescribeUiResult,
  type DeviceDescriptor,
  type DeviceEvent,
  type DeviceHardwareButton,
  type DeviceInstallAppResult,
  type DeviceLaunchAppResult,
  type DeviceListResult,
  type DeviceOpenPaneReason,
  type DeviceStartRecordingResult,
  type DeviceStopRecordingResult,
  type DeviceUiNode,
  type ThreadDeviceState,
} from "@synara/contracts";

import {
  DeviceBackendError,
  fitDeviceMessage,
  type DeviceBackend,
  type DeviceConfiguration,
  type DeviceKeyEvent,
  type DeviceLaunchOptions,
  type DeviceLogQuery,
  type DeviceLogResult,
  type DeviceScreenshotCapture,
  type DeviceSwipeGesture,
  type DeviceTypeTextOutcome,
} from "./DeviceBackend.ts";
import {
  effectiveValue,
  findFocusedNode,
  isSecureField,
  uiFingerprint,
} from "./deviceUiSnapshot.ts";
import { DeviceFrameTransport, type DeviceFrameSink } from "./deviceFrameTransport.ts";
import {
  DeviceUiTargetError,
  deviceKeyboardTop,
  SCROLL_SWIPE_DURATION_MS,
  describeTarget,
  findTarget,
  targetPhrase,
  planScrollStep,
  visibleLabels,
  type DeviceUiTarget,
  type DeviceUiTargetMatch,
} from "./uiTreeTargeting.ts";

/** How long an unused Synara-booted device stays up after work or viewing ends. */
export const DEVICE_IDLE_SHUTDOWN_MS = 10 * 60 * 1000;

/**
 * How long to keep retrying a stream attach that keeps failing transiently.
 *
 * A simulator reports itself booted before CoreSimulator publishes its display,
 * so the first attach after a cold boot reliably fails with "no framebuffer
 * surface yet". On a warm machine the window is a second or two; on a cold one,
 * with the first launch of a new runtime, it has been seen past twenty. Sixty
 * seconds covers the bad case and still fails while the user is watching rather
 * than leaving them staring at a spinner forever.
 */
export const DEVICE_ATTACH_DEADLINE_MS = 60_000;

/** Gap between attach retries. Short enough to feel immediate once ready. */
export const DEVICE_ATTACH_RETRY_MS = 750;

/**
 * What to tell the user when the display never appeared.
 *
 * Names the one action that actually fixes it. Retrying the attach is what just
 * failed for a minute, so the message does not suggest it.
 */
const DISPLAY_TIMEOUT_MESSAGE =
  "The simulator booted but never published a screen to capture. Shut it down and start it again; " +
  "if that keeps happening, the runtime may need reinstalling from Xcode's Platforms settings.";

/**
 * Failures worth waiting out rather than latching.
 *
 * All of these mean "not ready yet" rather than "will never work": the display
 * has not been published, the device is mid-boot, or the helper's descriptor
 * belongs to a boot that is being replaced. A refusal that is not one of these
 * (no such device, a broken capability, a helper that will not compile) is
 * reported immediately, because retrying it for a minute only delays the truth.
 */
export function isTransientAttachFailure(error: unknown): boolean {
  if (error instanceof DeviceBackendError && error.retryable) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /framebuffer surface|display has no|is not booted|not attached|no display/iu.test(message);
}

/** Enough to cross a long Settings list; short enough to fail fast on a typo. */
export const DEVICE_DEFAULT_MAX_SCROLLS = 8;

/**
 * Settling after input: the screen counts as settled once its accessibility
 * fingerprint holds for `quietMs`, and the wait gives up at `timeoutMs`.
 *
 * The tree, not pixels: reads cost tens of milliseconds, they ignore a blinking
 * caret, and they are what the agent acts on next. A spinner or an endless
 * animation simply reaches the deadline, which is reported rather than hidden.
 * The first read waits `startDelayMs` so the gesture's own effect has begun.
 */
export const DEVICE_SETTLE_DEFAULTS = {
  quietMs: 300,
  timeoutMs: 2_500,
  pollMs: 100,
  startDelayMs: 120,
  /**
   * How long an action's effect may take to start. The home gesture, a push
   * after a network call, or a sheet can leave the old screen perfectly still
   * for half a second first, which a bare quiet window reads as "settled,
   * nothing changed". Waiting for the first change before settling costs
   * nothing when the change is immediate, and this much when there is none.
   */
  changeGraceMs: 1_000,
} as const;

/**
 * How long a launch may take to bring its app to the front. The first launch
 * after an install, right after a cold boot, has been seen past four seconds;
 * the bound only costs time when the app never comes forward at all.
 */
const APP_CHANGE_TIMEOUT_MS = 10_000;

/** Upper bound for an explicit wait, so a typo cannot hang a turn. */
export const DEVICE_WAIT_MAX_MS = 30_000;

/** USB HID keyboard usages used for editing chords. */
const HID_USAGE = { a: 0x04, returnKey: 0x28, deleteKey: 0x2a } as const;

export interface DeviceSettleOutcome {
  /** False when the screen was still changing at the deadline. */
  readonly settled: boolean;
  readonly waitedMs: number;
  /** The last tree read, or null when accessibility never answered. */
  readonly root: DeviceUiNode | null;
}

export interface DeviceObservation extends DeviceSettleOutcome {
  /** Whether the screen differs from just before the action; null if unknown. */
  readonly changed: boolean | null;
}

export type DeviceTextMethod = "auto" | "keys" | "value";

export interface DeviceTextEntryOutcome {
  /** How the text went in: keystrokes, or the field's value set directly. */
  readonly method: "keys" | "value";
  readonly submitted: boolean;
}

export interface DeviceWaitOutcome {
  readonly status: "ready" | "timeout" | "ambiguous";
  readonly waitedMs: number;
  readonly root: DeviceUiNode | null;
  readonly match: DeviceUiTargetMatch | null;
}

export type DeviceEventListener = (event: DeviceEvent) => void;

export interface DeviceManagerOptions {
  readonly backend: DeviceBackend;
  readonly transport?: DeviceFrameTransport;
  readonly idleShutdownMs?: number;
  readonly bootLimit?: number;
  /** Remembers Synara's boots across a crash; defaults to remembering nothing. */
  readonly bootOwnership?: BootOwnershipStore;
  readonly attachDeadlineMs?: number;
  readonly attachRetryMs?: number;
  readonly setTimeout?: (handler: () => void, ms: number) => NodeJS.Timeout;
  readonly clearTimeout?: (handle: NodeJS.Timeout) => void;
  readonly now?: () => number;
}

interface ThreadAttachment {
  version: number;
  attachedDeviceUdid: string | null;
  agentActiveCount: number;
  attachmentSource: "user" | "agent";
  /** Device use outlives an individual tool until its exact provider turn settles. */
  readonly agentDevicesByTurn: Map<string, Set<string>>;
  readonly endedAgentTurns: Set<string>;
  lastError: string | null;
  /** Non-null while the attachment is still coming up. */
  attachPhase: DeviceAttachPhase | null;
  /**
   * Identifies the attach attempt currently in flight. A retry loop that finds
   * a different token has been superseded — the user picked another device, or
   * detached — and stops without touching the newer attempt's state.
   */
  attachToken: number;
  /**
   * Device this thread has already asked the pane to open for. An agent driving
   * a device calls a tool every few seconds, so the second and later requests
   * would be pure noise; this is what makes them a no-op.
   */
  paneSurfacedUdid: string | null;
}

export class DeviceManager {
  private readonly backend: DeviceBackend;
  private readonly transport: DeviceFrameTransport;
  private readonly idleShutdownMs: number;
  private readonly bootLimit: number;
  private readonly bootOwnership: BootOwnershipStore;
  private readonly attachDeadlineMs: number;
  private readonly attachRetryMs: number;
  private readonly schedule: (handler: () => void, ms: number) => NodeJS.Timeout;
  private readonly cancel: (handle: NodeJS.Timeout) => void;
  private readonly now: () => number;

  private readonly threads = new Map<string, ThreadAttachment>();
  /** Availability + device list from the most recent discovery; see `snapshot`. */
  private lastDiscovery: {
    readonly availability: DeviceAvailability;
    readonly devices: readonly DeviceDescriptor[];
  } | null = null;
  /** Devices this manager booted, and therefore may shut down again. */
  private readonly synaraBooted = new Set<string>();
  /**
   * Boots still running. A device being booted can still read as shut down in
   * a listing taken meanwhile, and reconciling against that listing released
   * its slot and forgot that Synara owns it.
   */
  private readonly bootsInFlight = new Set<string>();
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  /** New consumers wait out an already-issued idle poweroff before dispatching. */
  private readonly idleShutdowns = new Map<string, Promise<void>>();
  private readonly activeDeviceActions = new Map<string, number>();
  private activeStreamUdid: string | null = null;
  private desiredStreamUdid: string | null = null;
  /** Serializes the native helper's single stream while allowing the desired device to change. */
  private streamTransition: Promise<void> = Promise.resolve();
  private readonly recording = new Set<string>();
  private readonly listeners = new Set<DeviceEventListener>();
  private disposed = false;

  constructor(options: DeviceManagerOptions) {
    this.backend = options.backend;
    this.transport = options.transport ?? new DeviceFrameTransport();
    this.idleShutdownMs = options.idleShutdownMs ?? DEVICE_IDLE_SHUTDOWN_MS;
    this.bootLimit = options.bootLimit ?? DEVICE_SYNARA_BOOT_LIMIT;
    this.bootOwnership = options.bootOwnership ?? NULL_BOOT_OWNERSHIP;
    this.attachDeadlineMs = options.attachDeadlineMs ?? DEVICE_ATTACH_DEADLINE_MS;
    this.attachRetryMs = options.attachRetryMs ?? DEVICE_ATTACH_RETRY_MS;
    this.schedule = options.setTimeout ?? ((handler, ms) => setTimeout(handler, ms));
    this.cancel = options.clearTimeout ?? ((handle) => clearTimeout(handle));
    this.now = options.now ?? Date.now;
    this.backend.onStreamInterrupted?.((udid, reason) =>
      this.handleStreamInterrupted(udid, reason),
    );
  }

  private async recordBootOwnership(): Promise<void> {
    await this.bootOwnership.write([...this.synaraBooted]).catch(() => undefined);
  }

  /**
   * Shut down simulators a previous run booted and never got to clean up.
   *
   * Called once at startup. A clean quit leaves an empty record, so this is a
   * no-op; a crash leaves udids behind, and without this they would linger
   * forever, because the next run sees them as user-booted and therefore
   * outside the cap, the idle sweep and the quit-time shutdown alike.
   *
   * Returns the udids it shut down so the caller can log them: silently killing
   * a simulator the user can see would be its own surprise.
   */
  async reclaimOrphanedBoots(
    isProcessAlive: (pid: number) => boolean = processIsAlive,
  ): Promise<readonly string[]> {
    const recorded = await this.bootOwnership.read().catch(() => null);
    if (recorded === null || recorded.udids.length === 0) return [];

    const devices = await this.backend.listDevices({ includeShutdown: false }).catch(() => []);
    const orphans = orphanedBootUdids(
      recorded,
      devices.map((device) => device.udid),
      isProcessAlive,
    );
    for (const udid of orphans) {
      await this.backend.shutdown(udid).catch(() => undefined);
    }
    // Cleared even when nothing was shut down: the record described a dead
    // process, so keeping it would re-run this every start.
    if (!isProcessAlive(recorded.pid)) await this.bootOwnership.clear().catch(() => undefined);
    return orphans;
  }

  /** Waits without holding the process open, and shares the injected scheduler. */
  private delay(ms: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.cancel(timer);
        signal?.removeEventListener("abort", abort);
        reject(signal?.reason);
      };
      const timer = this.schedule(() => {
        signal?.removeEventListener("abort", abort);
        resolve();
      }, ms);
      timer.unref?.();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  // ── Events ─────────────────────────────────────────────────────────

  onEvent(listener: DeviceEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ── Queries ────────────────────────────────────────────────────────

  async availability(): Promise<DeviceAvailability> {
    return await this.backend.availability();
  }

  async list(options: { readonly includeShutdown?: boolean } = {}): Promise<DeviceListResult> {
    const availability = await this.backend.availability();
    const devices = await this.discover(availability, options);
    return { devices, availability };
  }

  /**
   * Devices to show alongside an availability state.
   *
   * Discovery is gated only on the platform, never on full availability.
   * Listing runs on `simctl`, which works long before the native helper exists,
   * and the helper is only built on first attach. Requiring `available` here
   * deadlocked a fresh machine: the picker stayed empty because the helper was
   * unbuilt, and the helper stayed unbuilt because attaching needs a udid from
   * the picker. The pane shows the devices and the remaining setup step
   * together, which is what the setup checklist is for.
   */
  private async discover(
    availability: DeviceAvailability,
    options: { readonly includeShutdown?: boolean } = {},
  ): Promise<readonly DeviceDescriptor[]> {
    if (availability.kind === "unsupported-platform") return [];
    // Already reported through `availability`; an empty list is the honest
    // answer when simctl itself cannot run.
    const devices = await this.backend.listDevices(options).catch(() => []);
    return devices.map((device) => this.describe(device));
  }

  async getThreadState(threadId: string): Promise<ThreadDeviceState> {
    return await this.snapshot(threadId);
  }

  /** Devices the pane may offer as shutdown candidates when the cap is hit. */
  async synaraBootedDevices(): Promise<readonly DeviceDescriptor[]> {
    const listed = await this.backend.listDevices({ includeShutdown: true }).catch(() => null);
    // A failed listing says nothing about what is running; reconciling against
    // it would drop every device Synara booted.
    if (listed !== null) this.reconcileSynaraBooted(listed);
    const devices = listed ?? [];
    return devices
      .filter((device) => this.synaraBooted.has(device.udid))
      .map((device) => this.describe(device));
  }

  /**
   * Forget devices that are no longer running.
   *
   * The set is Synara's own bookkeeping, but the simulators are not Synara's to
   * keep: `simctl shutdown all` from a shell, Simulator.app quitting, a crashed
   * runtime, or the agent tidying up all shut a device down without telling us.
   * Every one of those left a phantom holding a slot, and three phantoms made
   * the pane refuse the next boot and offer to shut down devices that were
   * already off — including, absurdly, the one being asked for.
   *
   * Reconciled from the listing every caller already has rather than by polling:
   * the cap is only consulted on boot, and that path lists devices anyway.
   */
  private reconcileSynaraBooted(devices: readonly DeviceDescriptor[]): void {
    const running = new Set(
      devices
        .filter((device) => device.state === "booted" || device.state === "booting")
        .map((device) => device.udid),
    );
    for (const udid of this.synaraBooted) {
      if (running.has(udid) || this.bootsInFlight.has(udid)) continue;
      this.synaraBooted.delete(udid);
      this.clearIdleTimer(udid);
    }
  }

  // ── Boot / shutdown ────────────────────────────────────────────────

  async boot(udid: string): Promise<DeviceBootResult> {
    this.assertNotDisposed();
    await this.waitForIdleShutdown(udid);
    this.assertNotDisposed();
    const listed = await this.backend.listDevices({ includeShutdown: true }).catch(() => null);
    this.assertNotDisposed();
    // Devices that stopped without Synara doing it still held their slots, so
    // three shutdowns from a shell were enough to make every later boot refuse.
    if (listed !== null) this.reconcileSynaraBooted(listed);
    const devices = listed ?? [];
    const known = devices.find((device) => device.udid === udid) ?? null;
    // Viewing an already-booted device is uncapped: the cap exists to stop
    // Synara from accumulating simulators, not to limit what the user watches.
    if (known?.state === "booted") {
      return { kind: "booted", device: this.describe(known) };
    }
    if (this.synaraBooted.size >= this.bootLimit) {
      return {
        kind: "boot-limit-reached",
        limit: this.bootLimit,
        synaraBooted: await this.synaraBootedDevices(),
      };
    }

    // The slot is taken before the await, not after it. A boot runs for the
    // better part of a minute, so two threads asking for different simulators
    // would both read a size under the limit and both proceed, and the cap that
    // exists to stop Synara accumulating multi-gigabyte simulators would be
    // exceeded by however many requests arrived inside that window.
    this.synaraBooted.add(udid);
    this.bootsInFlight.add(udid);
    let device: DeviceDescriptor;
    try {
      device = await this.backend.boot(udid);
    } catch (cause) {
      // A reservation only stands for a boot that actually happened; holding it
      // after a failure would leak the slot for the process lifetime.
      this.synaraBooted.delete(udid);
      throw cause;
    } finally {
      this.bootsInFlight.delete(udid);
    }
    // Persisted before the caller is told the boot succeeded, so a crash in the
    // next instant still leaves a record to reclaim from.
    await this.recordBootOwnership();
    // A device booted for a new purpose is no longer idle-condemned.
    this.clearIdleTimer(udid);
    await this.publishAllThreads();
    return { kind: "booted", device: { ...device, bootSource: "synara" } };
  }

  async shutdown(udid: string, onlyIfIdle = false): Promise<void> {
    await this.stopRecordingIfActive(udid).catch(() => undefined);
    await this.stopStream(udid);
    // Stream teardown yields: a new tool, user attachment or viewer may arrive meanwhile.
    if (onlyIfIdle && (this.disposed || this.isDeviceBusy(udid))) return;
    const attachedTokens = onlyIfIdle
      ? new Map(
          [...this.threads].map(([threadId, attachment]) => [threadId, attachment.attachToken]),
        )
      : null;
    await this.backend.shutdown(udid);
    this.synaraBooted.delete(udid);
    await this.recordBootOwnership();
    this.clearIdleTimer(udid);
    // Any thread watching this device loses its attachment rather than pointing
    // at a shut-down simulator.
    for (const [threadId, attachment] of this.threads) {
      if (attachment.attachedDeviceUdid !== udid) continue;
      if (attachedTokens !== null && attachedTokens.get(threadId) !== attachment.attachToken)
        continue;
      attachment.attachedDeviceUdid = null;
      attachment.attachPhase = null;
      // Stops a retry loop still waiting on this device's display: it is not
      // coming, and the loop would otherwise time out into a misleading error.
      attachment.attachToken += 1;
      await this.publish(threadId);
    }
    await this.publishAllThreads();
  }

  // ── Attachment ─────────────────────────────────────────────────────

  /**
   * Point a thread at a device and bring its stream up.
   *
   * Resolves as soon as the attachment is recorded, not when the picture
   * arrives: a cold boot publishes its display seconds after reporting itself
   * booted, and holding the RPC open for that left the picker on "Choose a
   * simulator" and the screen blank for the whole wait. The stream comes up in
   * the background, pushing a phase per stage, and the pane renders the device
   * it was told to show from the first frame of the interaction.
   */
  async attach(
    threadId: string,
    udid: string,
    source: "user" | "agent" = "user",
  ): Promise<ThreadDeviceState> {
    this.assertNotDisposed();
    const attachment = this.threadState(threadId);
    const previous = attachment.attachedDeviceUdid;
    // Cleared before releasing: `releaseDevice` asks whether anyone still holds
    // the device, and this thread must no longer count as a holder.
    attachment.attachedDeviceUdid = udid;
    attachment.attachmentSource = source;
    attachment.lastError = null;
    attachment.attachPhase = "connecting";
    const token = (attachment.attachToken += 1);
    if (previous !== null && previous !== udid) await this.releaseDevice(previous, "switched");
    this.clearIdleTimer(udid);
    await this.waitForIdleShutdown(udid);
    this.assertNotDisposed();
    if (attachment.attachToken !== token) return await this.snapshot(threadId);

    // Already streaming (another thread is watching the same device): there is
    // nothing to wait for, so the phase clears without a round trip.
    if (this.activeStreamUdid === udid || this.desiredStreamUdid === udid) {
      attachment.attachPhase = null;
      return await this.publish(threadId);
    }

    const state = await this.publish(threadId);
    void this.bringStreamUp(threadId, udid, token);
    return state;
  }

  /**
   * Open the stream, waiting out the failures that only mean "not ready yet".
   *
   * The retry is the whole point: attaching to a device that has not published
   * its display fails every time, and a single attempt therefore turned every
   * cold boot into a dead pane with an error under it. Bounded by
   * `DEVICE_ATTACH_DEADLINE_MS` so a device that genuinely never comes up ends
   * in a message naming what to do instead of an endless spinner.
   */
  private async bringStreamUp(threadId: string, udid: string, token: number): Promise<void> {
    const deadline = this.now() + this.attachDeadlineMs;
    let sawTransientFailure = false;

    while (!this.disposed) {
      const attachment = this.threads.get(threadId);
      // Superseded or gone: another attach owns this thread's state now.
      if (!attachment || attachment.attachToken !== token) return;

      if (this.wouldStealStream(udid)) {
        // Nobody is watching this device yet, while another thread's viewers
        // watch a different one on the helper's single stream. Taking it over
        // froze their pane for an attachment nobody could see; the stream
        // starts when this device gets a viewer instead.
        if (attachment.attachPhase !== null) {
          attachment.attachPhase = null;
          await this.publish(threadId);
        }
        return;
      }

      try {
        const started = await this.startStream(udid);
        if (!started) return;
        if (attachment.attachPhase === null && attachment.lastError === null) return;
        attachment.attachPhase = null;
        attachment.lastError = null;
        await this.publish(threadId);
        return;
      } catch (error) {
        if (!isTransientAttachFailure(error)) {
          attachment.attachPhase = null;
          attachment.lastError = errorMessage(error);
          await this.publish(threadId);
          return;
        }
        // The device is up but has no screen yet, which is a different wait
        // from booting and worth saying so.
        const phase: DeviceAttachPhase = /is not booted/iu.test(errorMessage(error))
          ? "booting"
          : "waiting-for-display";
        if (attachment.attachPhase !== phase) {
          attachment.attachPhase = phase;
          await this.publish(threadId);
        }
        sawTransientFailure = true;
      }

      if (this.now() >= deadline) break;
      await this.delay(this.attachRetryMs);
    }

    const attachment = this.threads.get(threadId);
    if (!attachment || attachment.attachToken !== token) return;
    attachment.attachPhase = null;
    // Only the display-wait deadline gets the tailored message; a disposal or a
    // shutdown mid-wait is not the user's problem to act on.
    if (sawTransientFailure && !this.disposed) attachment.lastError = DISPLAY_TIMEOUT_MESSAGE;
    await this.publish(threadId);
  }

  /**
   * Point a thread at the device its agent is driving, unless the user already
   * pointed it somewhere else.
   *
   * Auto-opening the pane is only useful if there is something to watch: before
   * this, an agent's launch opened a pane still asking the user to pick a
   * simulator, so they stared at a black phone while the agent worked. The
   * attachment is what makes `ThreadDeviceState.attachedDeviceUdid` non-null,
   * and the pane's existing logic starts the stream from there.
   *
   * Never steals: a thread already attached to a different device keeps it,
   * because that attachment reflects a deliberate choice by the user and the
   * agent's device is still reachable through the picker. Idempotent, so
   * repeated launches on the same device cost nothing.
   */
  async ensureThreadAttached(threadId: string, udid: string): Promise<void> {
    const attached = this.threadState(threadId).attachedDeviceUdid;
    if (attached === udid) return;
    if (attached !== null) return;
    await this.attach(threadId, udid, "agent");
    this.updateIdleTimer(udid);
  }

  async detach(threadId: string): Promise<ThreadDeviceState> {
    const attachment = this.threadState(threadId);
    const udid = attachment.attachedDeviceUdid;
    attachment.attachedDeviceUdid = null;
    attachment.attachPhase = null;
    // Abandons any attach still retrying in the background, so it cannot
    // resurrect a phase or an error on a thread that is no longer watching.
    attachment.attachToken += 1;
    if (udid !== null) await this.releaseDevice(udid);
    return await this.publish(threadId);
  }

  /** Thread archive or deletion is terminal for its attachment; treat it as a detach. */
  async handleThreadRemoved(threadId: string): Promise<void> {
    if (!this.threads.has(threadId)) return;
    await this.detach(threadId);
    const devices = new Set<string>();
    for (const used of this.threads.get(threadId)!.agentDevicesByTurn.values())
      for (const udid of used) devices.add(udid);
    this.threads.delete(threadId);
    for (const device of devices) this.updateIdleTimer(device);
  }

  // ── Streaming ──────────────────────────────────────────────────────

  /**
   * Register a WebSocket sink for a device's video. The backend stream is
   * started lazily and stopped when the last subscriber and attachment go away.
   */
  subscribeFrames(udid: string, sink: DeviceFrameSink): () => void {
    if (this.disposed) return () => {};
    const unsubscribe = this.transport.subscribe(udid, sink);
    this.clearIdleTimer(udid);
    void (async () => {
      await this.waitForIdleShutdown(udid);
      if (this.disposed || this.transport.deviceSubscriberCount(udid) === 0) return;
      // A thread whose attach deferred its stream (see `wouldStealStream`) gets
      // the attach's retry loop now that someone is watching: the device may
      // still be publishing its display.
      const waiting = [...this.threads].find(
        ([, attachment]) =>
          attachment.attachedDeviceUdid === udid && this.activeStreamUdid !== udid,
      );
      if (waiting) {
        const [threadId, attachment] = waiting;
        void this.bringStreamUp(threadId, udid, attachment.attachToken);
      } else {
        void this.startStream(udid).catch(() => undefined);
      }
    })().catch(() => undefined);
    return () => {
      unsubscribe();
      this.updateIdleTimer(udid);
      // Capture stops as soon as the last viewer goes, whether or not a thread
      // is still attached. Collapsing the pane closes the frame socket but
      // leaves the attachment, and gating this on the attachment too meant the
      // helper kept reading the framebuffer and encoding H.264 for nobody,
      // indefinitely. An agent-driven attachment that never opens a pane cost
      // the same. The attachment is metadata and survives; only the encode
      // stops, and `subscribeFrames` starts it again on the next subscriber.
      if (this.transport.deviceSubscriberCount(udid) === 0) {
        void this.stopStream(udid).catch(() => undefined);
      }
    };
  }

  // ── Control plane ──────────────────────────────────────────────────

  async tap(
    udid: string,
    x: number,
    y: number,
    options: { readonly holdMs?: number } = {},
  ): Promise<void> {
    await this.withDeviceAction(udid, () => this.backend.tap(udid, x, y, options));
  }

  /**
   * Tap the element a label names, scrolling it into view first if needed.
   *
   * The tree is read fresh rather than cached: a stale frame is exactly how a
   * tap lands on whatever scrolled into that position instead. Returns the
   * node so the caller can report what it actually hit and its state.
   */
  async tapElement(
    udid: string,
    target: DeviceUiTarget,
    options: {
      readonly maxScrolls?: number | undefined;
      readonly holdMs?: number;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<DeviceUiTargetMatch> {
    options.signal?.throwIfAborted();
    const match = await this.scrollToElement(udid, target, options);
    options.signal?.throwIfAborted();
    await this.withDeviceAction(udid, () =>
      this.backend.tap(
        udid,
        match.point.x,
        match.point.y,
        options.holdMs === undefined ? {} : { holdMs: options.holdMs },
      ),
    );
    return match;
  }

  /**
   * Bring the element a label names into the tappable band and return it.
   *
   * The swipe-describe-check loop lives here rather than in the agent because
   * it is motor control, not judgement: an agent driving it by hand guesses
   * distances, overshoots, and re-describes between every attempt. Already
   * visible targets cost one describe and no swipes.
   *
   * A label missing from the tree is treated as "not reached yet" rather than
   * as a failure. Long lists are virtualized, so UIKit only materializes the
   * rows near the viewport: Settings genuinely has no "Developer" node until
   * scrolling gets close to it. The loop keeps paging down while the label is
   * absent, and only reports it missing once the list stops moving.
   */
  async scrollToElement(
    udid: string,
    target: DeviceUiTarget,
    options: { readonly maxScrolls?: number | undefined; readonly signal?: AbortSignal } = {},
  ): Promise<DeviceUiTargetMatch> {
    const maxScrolls = options.maxScrolls ?? DEVICE_DEFAULT_MAX_SCROLLS;
    let tree = await this.describeUi(udid);
    let match = this.locate(tree.root, target);
    let previousPosition: string | null = null;

    for (let scrolls = 0; scrolls < maxScrolls; scrolls += 1) {
      options.signal?.throwIfAborted();
      // Nothing to aim at yet: page down by a screenful to materialize more of
      // the list. Once the node exists, the planner takes over and aims at it.
      const step =
        match === null ? this.pageDownStep(tree.root) : planScrollStep(match.node, tree.root);
      if (step === null) return match as DeviceUiTargetMatch;

      const positionBefore = match === null ? null : match.node.frame.y;
      await this.withDeviceAction(udid, () => this.backend.swipe(udid, step));
      tree = await this.describeUi(udid);
      match = this.locate(tree.root, target);

      // Fixed chrome (a navigation bar's back button, a tab bar) sits outside
      // the safe band by design and does not scroll. Only identified chrome
      // outside the keyboard overlay may be tapped in place.
      if (
        match !== null &&
        match.onScreen &&
        match.node.frame.y === positionBefore &&
        this.isFixedChrome(tree.root, match.node)
      ) {
        return match;
      }

      // A list at its end keeps rendering the same thing; swiping again would
      // burn the whole budget to no effect. Compared across the visible labels
      // as well as the target's own position, since an absent target has none.
      const position = match === null ? this.treeFingerprint(tree.root) : `y:${match.node.frame.y}`;
      if (previousPosition !== null && position === previousPosition) {
        throw new DeviceUiTargetError(
          match === null
            ? `No element ${targetPhrase(target)} appeared after scrolling to the end of the screen.`
            : `Scrolling stopped moving ${describeTarget(target)} after ${scrolls + 1} ` +
                `swipe${scrolls === 0 ? "" : "s"}; the list appears to be at its end and the element is still out of reach.`,
          match === null ? visibleLabels(tree.root) : [],
          match === null,
        );
      }
      previousPosition = position;
    }

    if (match !== null && planScrollStep(match.node, tree.root) === null) return match;
    throw new DeviceUiTargetError(
      `Could not bring ${describeTarget(target)} into view within ${maxScrolls} swipes. ` +
        `Raise maxSwipes, or scroll manually with device_swipe if it sits in a nested scroll area.`,
      match === null ? visibleLabels(tree.root) : [],
      match === null,
    );
  }

  /** The match, or null when the label has not been rendered into the tree yet. */
  private locate(root: DeviceUiNode, target: DeviceUiTarget): DeviceUiTargetMatch | null {
    try {
      return findTarget(root, target);
    } catch (error) {
      // Only absence means "keep scrolling". An ambiguous label is a real
      // answer the caller must resolve, so it propagates immediately.
      if (error instanceof DeviceUiTargetError && error.notFound) return null;
      throw error;
    }
  }

  /** A blind screenful downward, for when the target has not appeared yet. */
  private pageDownStep(root: DeviceUiNode): DeviceSwipeGesture {
    const midX = root.frame.x + root.frame.width / 2;
    const centre = root.frame.y + root.frame.height / 2;
    const distance = root.frame.height * 0.6;
    return {
      fromX: midX,
      fromY: centre + distance / 2,
      toX: midX,
      toY: centre - distance / 2,
      durationMs: SCROLL_SWIPE_DURATION_MS,
    };
  }

  /** What is on screen right now, to tell a moving list from a stuck one. */
  private treeFingerprint(root: DeviceUiNode): string {
    return visibleLabels(root).join("|");
  }

  async swipe(udid: string, gesture: DeviceSwipeGesture): Promise<void> {
    await this.withDeviceAction(udid, () => this.backend.swipe(udid, gesture));
  }

  /** A stationary frame alone can also be an off-screen or keyboard-covered control. */
  private isFixedChrome(root: DeviceUiNode, target: DeviceUiNode, chrome = false): boolean {
    const ownsChrome =
      chrome ||
      /^(?:AX)?(?:NavigationBar|TabBar)$/iu.test(root.role) ||
      /^(?:AX)?(?:NavigationBar|TabBar)$/iu.test(root.subrole ?? "");
    if (root === target) return ownsChrome;
    return root.children.some((child) => this.isFixedChrome(child, target, ownsChrome));
  }

  async typeText(udid: string, text: string): Promise<DeviceTypeTextOutcome> {
    return await this.withDeviceAction(udid, () => this.backend.typeText(udid, text));
  }

  /**
   * Put text into the focused field the way a test needs it to land: exactly.
   *
   * Keystrokes are the realistic path, but the guest maps each key through its
   * own hardware layout (an Italian simulator turns "-" into "'") and only
   * ASCII has keys at all. `auto` therefore types keys for ASCII on a US
   * layout and otherwise sets the field's value through accessibility, which
   * carries any Unicode. Trailing newlines become a Return press either way.
   */
  async enterText(
    udid: string,
    text: string,
    options: {
      readonly method?: DeviceTextMethod;
      readonly clear?: boolean;
      readonly submit?: boolean;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<DeviceTextEntryOutcome> {
    options.signal?.throwIfAborted();
    const body = text.replace(/\n+$/u, "");
    const submit = options.submit === true || body.length !== text.length;
    const printableAscii = /^[\x20-\x7e\t\n]*$/u.test(body);
    let method: "keys" | "value";
    if (options.method === "keys") {
      if (!printableAscii) {
        throw new DeviceBackendError(
          'method "keys" types printable ASCII only; use method "value" (or "auto") for this text.',
        );
      }
      method = "keys";
    } else if (options.method === "value") {
      method = "value";
    } else {
      method =
        printableAscii &&
        (await this.withDeviceAction(udid, () => this.backend.usesUsKeyboardLayout(udid)).catch(
          () => false,
        ))
          ? "keys"
          : "value";
    }

    if (method === "value" && body.length > 0) {
      const tree = await this.describeUi(udid);
      const focused = findFocusedNode(tree.root);
      if (focused === null) {
        throw new DeviceUiTargetError(
          "No element has keyboard focus, so there is nowhere to put the text. Tap the field first, then retry.",
        );
      }
      if (isSecureField(focused) && options.clear !== true) {
        throw new DeviceBackendError(
          "Secure fields cannot be appended to through accessibility; pass clear: true to replace the whole value.",
        );
      } else {
        const current = options.clear === true ? "" : (effectiveValue(focused) ?? "");
        options.signal?.throwIfAborted();
        await this.withDeviceAction(udid, () =>
          this.backend.setFocusedValue(udid, `${current}${body}`),
        );
      }
    }
    if (method === "keys") {
      options.signal?.throwIfAborted();
      if (options.clear === true) await this.clearFocusedField(udid);
      if (body.length > 0) {
        const outcome = await this.withDeviceAction(udid, () =>
          this.backend.typeText(udid, body, {
            ...(options.signal ? { signal: options.signal } : {}),
          }),
        );
        if (outcome.skipped > 0) {
          throw new DeviceBackendError(
            `${outcome.skipped} character(s) have no key and were not typed; retry with method "value".`,
          );
        }
      }
    } else if (body.length === 0 && options.clear === true) {
      await this.withDeviceAction(udid, () => this.backend.setFocusedValue(udid, ""));
    }
    options.signal?.throwIfAborted();
    if (submit) await this.pressKey(udid, HID_USAGE.returnKey);
    return { method, submitted: submit };
  }

  /** Select all, then delete: the hardware-keyboard way to empty a field. */
  private async clearFocusedField(udid: string): Promise<void> {
    await this.pressKey(udid, HID_USAGE.a, ["command"]);
    await this.pressKey(udid, HID_USAGE.deleteKey);
  }

  private async pressKey(
    udid: string,
    keyCode: number,
    modifiers: DeviceKeyEvent["modifiers"] = [],
  ): Promise<void> {
    await this.withDeviceAction(udid, () =>
      this.backend.keyEvent(udid, { keyCode, modifiers, direction: "down" }),
    );
    await this.withDeviceAction(udid, () =>
      this.backend.keyEvent(udid, { keyCode, modifiers, direction: "up" }),
    );
  }

  // ── Observation ────────────────────────────────────────────────────

  /**
   * Wait until the screen stops changing, or the deadline passes.
   *
   * Reads failing mid-transition (the frontmost app is swapping) count as
   * change rather than as an error: a launch or a dismissal is exactly when
   * the tree is briefly unreadable.
   */
  async waitForSettle(
    udid: string,
    options: {
      readonly quietMs?: number;
      readonly timeoutMs?: number;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<DeviceSettleOutcome> {
    const quietMs = options.quietMs ?? DEVICE_SETTLE_DEFAULTS.quietMs;
    const timeoutMs = options.timeoutMs ?? DEVICE_SETTLE_DEFAULTS.timeoutMs;
    const started = this.now();
    await this.delay(Math.min(DEVICE_SETTLE_DEFAULTS.startDelayMs, timeoutMs), options.signal);
    let root: DeviceUiNode | null = null;
    let fingerprint: string | null = null;
    let stableSince = this.now();
    while (true) {
      options.signal?.throwIfAborted();
      const read = await this.describeUi(udid).catch(() => null);
      const next = read === null ? null : uiFingerprint(read.root);
      if (read !== null) root = read.root;
      if (next === null || next !== fingerprint) {
        fingerprint = next;
        stableSince = this.now();
      } else if (this.now() - stableSince >= quietMs) {
        return { settled: true, waitedMs: this.now() - started, root };
      }
      if (this.now() - started >= timeoutMs) {
        return { settled: false, waitedMs: this.now() - started, root };
      }
      await this.delay(DEVICE_SETTLE_DEFAULTS.pollMs, options.signal);
    }
  }

  /**
   * Run an action and report what it did to the screen: the settled tree and
   * whether it differs from just before. An unchanged screen after a tap is the
   * clearest sign the tap missed, and it costs the agent nothing to see it.
   */
  async observe(
    udid: string,
    action: () => Promise<void>,
    options: {
      readonly quietMs?: number;
      readonly timeoutMs?: number;
      /**
       * Wait for an app to come to the front before settling: `"different"`
       * for one other than the app in front before, `"any"` when relaunching
       * the app already in front. A launch reports success well before its app
       * is frontmost, and the old screen or the blank transition holding still
       * in the meantime would read as settled.
       */
      readonly awaitApp?: "different" | "any";
      readonly awaitChange?: boolean;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<DeviceObservation> {
    const beforeTree = await this.describeUi(udid).catch(() => null);
    const before = beforeTree === null ? null : uiFingerprint(beforeTree.root);
    options.signal?.throwIfAborted();
    await action();
    options.signal?.throwIfAborted();
    const acted = this.now();
    if (options.awaitApp !== undefined) {
      const transitioned = await this.waitForApp(
        udid,
        beforeTree?.root.label,
        before,
        options.awaitApp,
        options.signal,
      );
      if (!transitioned) {
        return {
          settled: false,
          waitedMs: this.now() - acted,
          root: (await this.describeUi(udid).catch(() => null))?.root ?? null,
          changed: null,
        };
      }
    } else if (before !== null) {
      const changed = await this.waitForChange(
        udid,
        before,
        options.signal,
        options.awaitChange ? options.timeoutMs : undefined,
      );
      if (options.awaitChange && !changed) {
        return {
          settled: false,
          waitedMs: this.now() - acted,
          root: (await this.describeUi(udid).catch(() => null))?.root ?? null,
          changed: false,
        };
      }
    }
    const settled = await this.waitForSettle(udid, options);
    const after = settled.root === null ? null : uiFingerprint(settled.root);
    return {
      ...settled,
      // From the end of the action, so a slow-starting transition counts.
      waitedMs: this.now() - acted,
      changed: before === null || after === null ? null : before !== after,
    };
  }

  /** Poll until the screen differs from `baseline`, for at most the change grace. */
  private async waitForChange(
    udid: string,
    baseline: string,
    signal?: AbortSignal,
    timeoutMs: number = DEVICE_SETTLE_DEFAULTS.changeGraceMs,
  ): Promise<boolean> {
    const started = this.now();
    while (this.now() - started < timeoutMs) {
      signal?.throwIfAborted();
      const tree = await this.describeUi(udid).catch(() => null);
      if (tree !== null && uiFingerprint(tree.root) !== baseline) return true;
      await this.delay(DEVICE_SETTLE_DEFAULTS.pollMs, signal);
    }
    return false;
  }

  /**
   * Poll until an app is in front (the root carries a name; SpringBoard and
   * the launch transition do not) and, when `previous` is given, it is not
   * that one. Bounded by `APP_CHANGE_TIMEOUT_MS`: an app that was already in
   * front never changes, and the bound lets that fall through to a settle.
   */
  private async waitForApp(
    udid: string,
    previous: string | null | undefined,
    baseline: string | null,
    mode: "different" | "any",
    signal?: AbortSignal,
  ): Promise<boolean> {
    const started = this.now();
    let transitioned = baseline === null;
    while (this.now() - started < APP_CHANGE_TIMEOUT_MS) {
      signal?.throwIfAborted();
      const tree = await this.describeUi(udid).catch(() => null);
      const label = tree?.root.label?.trim();
      if (tree === null || !label || (baseline !== null && uiFingerprint(tree.root) !== baseline))
        transitioned = true;
      if (label && (mode === "different" ? label !== previous?.trim() : transitioned)) return true;
      await this.delay(DEVICE_SETTLE_DEFAULTS.pollMs, signal);
    }
    return false;
  }

  /**
   * Wait for an element to appear (or, with `gone`, to disappear) without
   * sending any input. Ambiguity proves presence, so it ends a presence wait.
   */
  async waitFor(
    udid: string,
    target: DeviceUiTarget,
    options: { readonly gone?: boolean; readonly timeoutMs: number; readonly signal?: AbortSignal },
  ): Promise<DeviceWaitOutcome> {
    const started = this.now();
    const timeoutMs = Math.min(options.timeoutMs, DEVICE_WAIT_MAX_MS);
    let root: DeviceUiNode | null = null;
    while (true) {
      options.signal?.throwIfAborted();
      const read = await this.describeUi(udid).catch(() => null);
      if (read !== null) {
        root = read.root;
        let match: DeviceUiTargetMatch | null = null;
        let ambiguous = false;
        try {
          const found = findTarget(read.root, target);
          match = found.onScreen ? found : null;
        } catch (error) {
          if (!(error instanceof DeviceUiTargetError)) throw error;
          ambiguous = !error.notFound;
        }
        const present = match !== null || ambiguous;
        if (options.gone === true ? !present : present) {
          return {
            status: ambiguous && options.gone !== true ? "ambiguous" : "ready",
            waitedMs: this.now() - started,
            root,
            match,
          };
        }
      }
      if (this.now() - started >= timeoutMs) {
        return { status: "timeout", waitedMs: this.now() - started, root, match: null };
      }
      await this.delay(200, options.signal);
    }
  }

  async keyEvent(udid: string, event: DeviceKeyEvent): Promise<void> {
    await this.withDeviceAction(udid, () => this.backend.keyEvent(udid, event));
  }

  async pressButton(udid: string, button: DeviceHardwareButton): Promise<void> {
    await this.withDeviceAction(udid, () => this.backend.pressButton(udid, button));
  }

  async install(udid: string, appPath: string): Promise<DeviceInstallAppResult> {
    return await this.withDeviceAction(udid, () => this.backend.install(udid, appPath));
  }

  async launch(
    udid: string,
    bundleId: string,
    launchArguments?: readonly string[],
    options?: DeviceLaunchOptions,
  ): Promise<DeviceLaunchAppResult> {
    return await this.withDeviceAction(udid, () =>
      this.backend.launch(udid, bundleId, launchArguments, options),
    );
  }

  async configure(udid: string, configuration: DeviceConfiguration): Promise<void> {
    await this.withDeviceAction(udid, () => this.backend.configure(udid, configuration));
  }

  async readLogs(udid: string, query: DeviceLogQuery): Promise<DeviceLogResult> {
    return await this.withDeviceAction(udid, () => this.backend.readLogs(udid, query));
  }

  async openUrl(udid: string, url: string): Promise<void> {
    await this.withDeviceAction(udid, () => this.backend.openUrl(udid, url));
  }

  async screenshot(
    udid: string,
    options: {
      readonly save?: boolean;
      readonly maxInlineBytes?: number;
      readonly resolution?: "pixels" | "points";
      readonly proof?: boolean;
    } = {},
  ): Promise<DeviceScreenshotCapture> {
    return await this.withDeviceAction(udid, () => this.backend.screenshot(udid, options));
  }

  async startRecording(udid: string): Promise<DeviceStartRecordingResult> {
    this.assertNotDisposed();
    const alreadyTracked = this.recording.has(udid);
    this.recording.add(udid);
    this.clearIdleTimer(udid);
    try {
      return await this.withDeviceAction(udid, () => this.backend.startRecording(udid));
    } catch (error) {
      if (!alreadyTracked) this.recording.delete(udid);
      this.updateIdleTimer(udid);
      throw error;
    }
  }

  async stopRecording(udid: string): Promise<DeviceStopRecordingResult> {
    const result = await this.backend.stopRecording(udid);
    this.recording.delete(udid);
    this.updateIdleTimer(udid);
    return result;
  }

  async describeUi(udid: string): Promise<DeviceDescribeUiResult> {
    return await this.withDeviceAction(udid, () => this.backend.describeUi(udid));
  }

  /** The screen in points: helper geometry when attached, else the tree's root. */
  async pointSize(
    udid: string,
  ): Promise<{ readonly width: number; readonly height: number } | null> {
    const geometry = this.backend.geometry(udid);
    if (geometry) return { width: geometry.pointWidth, height: geometry.pointHeight };
    const tree = await this.describeUi(udid).catch(() => null);
    if (tree === null || tree.root.frame.width <= 0 || tree.root.frame.height <= 0) return null;
    return { width: tree.root.frame.width, height: tree.root.frame.height };
  }

  // ── Agent integration ──────────────────────────────────────────────

  /**
   * Wrap one agent-driven action so the pane can show its "agent is using this
   * device" badge for exactly as long as the action runs. Nested calls are
   * counted, so overlapping tool calls do not clear the badge early.
   */
  async withAgentActivity<A>(
    threadId: string,
    action: () => Promise<A>,
    deviceUse?: { readonly udid: string; readonly turnId: string | null },
  ): Promise<A> {
    this.assertNotDisposed();
    const attachment = this.threadState(threadId);
    const udid = deviceUse?.udid;
    if (udid !== undefined) {
      this.clearIdleTimer(udid);
      this.activeDeviceActions.set(udid, (this.activeDeviceActions.get(udid) ?? 0) + 1);
      const turnId = deviceUse?.turnId ?? null;
      if (turnId !== null && !attachment.endedAgentTurns.has(turnId)) {
        const devices = attachment.agentDevicesByTurn.get(turnId) ?? new Set<string>();
        devices.add(udid);
        attachment.agentDevicesByTurn.set(turnId, devices);
      }
    }
    attachment.agentActiveCount += 1;
    try {
      if (udid !== undefined) await this.waitForIdleShutdown(udid);
      // Only the badge changes here; the device list the pane shows does not.
      if (attachment.agentActiveCount === 1) await this.publish(threadId, { reuseDiscovery: true });
      this.assertNotDisposed();
      return await action();
    } finally {
      attachment.agentActiveCount = Math.max(0, attachment.agentActiveCount - 1);
      if (udid !== undefined) {
        const remaining = (this.activeDeviceActions.get(udid) ?? 1) - 1;
        if (remaining === 0) this.activeDeviceActions.delete(udid);
        else this.activeDeviceActions.set(udid, remaining);
        this.updateIdleTimer(udid);
      }
      // Archive/disposal may finish while an admitted device call is settling.
      if (
        !this.disposed &&
        this.threads.get(threadId) === attachment &&
        attachment.agentActiveCount === 0
      )
        await this.publish(threadId, { reuseDiscovery: true });
    }
  }

  /** Release only the settled turn; delayed terminal events cannot evict newer work. */
  endAgentTurn(threadId: string, turnId?: string): void {
    const attachment = this.threads.get(threadId);
    if (!attachment || this.disposed) return;
    if (turnId === undefined && attachment.agentDevicesByTurn.size > 1) return;
    const devices = new Set<string>();
    for (const [heldTurn, used] of attachment.agentDevicesByTurn) {
      if (turnId !== undefined && heldTurn !== turnId) continue;
      for (const udid of used) devices.add(udid);
      attachment.agentDevicesByTurn.delete(heldTurn);
      attachment.endedAgentTurns.add(heldTurn);
    }
    if (turnId !== undefined) attachment.endedAgentTurns.add(turnId);
    // Bound replay guards while rejecting tool completions from recently settled turns.
    while (attachment.endedAgentTurns.size > 64)
      attachment.endedAgentTurns.delete(attachment.endedAgentTurns.values().next().value!);
    for (const udid of devices) this.updateIdleTimer(udid);
  }

  /** Auto-open the pane when an agent puts an app on a device. */
  requestOpenPane(threadId: string, udid: string, reason: DeviceOpenPaneReason): void {
    this.threadState(threadId).paneSurfacedUdid = udid;
    this.emit({
      type: "device.open-pane-requested",
      threadId: ThreadId.makeUnsafe(threadId),
      udid,
      reason,
    });
  }

  /**
   * Put the agent's device in front of the user: attach the thread to it so the
   * pane has something to stream, then ask the pane to open.
   *
   * Every device interaction calls this, not just install and launch. An agent
   * working on an app that is already running never installs or launches
   * anything, so gating on those left the user watching a blank right side for
   * the whole turn while the agent tapped through their app.
   *
   * Interactions arrive every few seconds, so this is a no-op once the pane has
   * been surfaced for that device on that thread: repeating the request would
   * emit an event per tap and could yank a user who navigated away back to the
   * pane. Attaching first means the open request lands on a state that already
   * names a device rather than the empty picker.
   */
  async surfaceDeviceForAgent(
    threadId: string,
    udid: string,
    reason: DeviceOpenPaneReason,
  ): Promise<void> {
    if (this.threadState(threadId).paneSurfacedUdid === udid) return;
    await this.ensureThreadAttached(threadId, udid).catch(() => undefined);
    this.requestOpenPane(threadId, udid, reason);
  }

  async recordThreadError(threadId: string, message: string): Promise<void> {
    this.threadState(threadId).lastError = message;
    await this.publish(threadId, { reuseDiscovery: true });
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  /**
   * App quit: shut down everything Synara booted, leave the user's devices
   * alone, and release the backend.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const [, timer] of this.idleTimers) this.cancel(timer);
    this.idleTimers.clear();
    await Promise.allSettled(this.idleShutdowns.values());
    // Snapshotted: both loops mutate the set they are walking.
    const recording = Array.from(this.recording);
    const booted = Array.from(this.synaraBooted);
    this.desiredStreamUdid = null;
    await this.queueStreamReconciliation().catch(() => undefined);
    for (const udid of recording) await this.stopRecordingIfActive(udid).catch(() => undefined);
    for (const udid of booted) {
      await this.backend.shutdown(udid).catch(() => undefined);
      this.synaraBooted.delete(udid);
    }
    // Nothing is ours any more, so a later start must not adopt these.
    await this.bootOwnership.clear().catch(() => undefined);
    this.listeners.clear();
    await this.backend.dispose().catch(() => undefined);
  }

  // ── Internals ──────────────────────────────────────────────────────

  private threadState(threadId: string): ThreadAttachment {
    let attachment = this.threads.get(threadId);
    if (!attachment) {
      attachment = {
        version: 0,
        attachedDeviceUdid: null,
        agentActiveCount: 0,
        attachmentSource: "user",
        agentDevicesByTurn: new Map(),
        endedAgentTurns: new Set(),
        lastError: null,
        attachPhase: null,
        attachToken: 0,
        paneSurfacedUdid: null,
      };
      this.threads.set(threadId, attachment);
    }
    return attachment;
  }

  /**
   * Fill in the fields discovery cannot know: who booted the device, and its
   * screen geometry. Every descriptor the manager hands out passes through
   * here, so the pane always sees geometry once the device has been attached.
   */
  private describe(device: DeviceDescriptor): DeviceDescriptor {
    const bootSource = this.synaraBooted.has(device.udid) ? "synara" : device.bootSource;
    const geometry = this.backend.geometry(device.udid) ?? device.geometry;
    if (bootSource === device.bootSource && geometry === device.geometry) return device;
    return { ...device, bootSource, ...(geometry ? { geometry } : {}) };
  }

  private isAttachedAnywhere(udid: string): boolean {
    for (const [, attachment] of this.threads) {
      if (attachment.attachedDeviceUdid === udid) return true;
    }
    return false;
  }

  /** Metadata-only agent attachments do not keep a simulator alive after work ends. */
  private isDeviceBusy(udid: string): boolean {
    if (
      this.bootsInFlight.has(udid) ||
      this.recording.has(udid) ||
      this.activeDeviceActions.has(udid) ||
      this.transport.deviceSubscriberCount(udid) > 0
    )
      return true;
    for (const attachment of this.threads.values()) {
      if (attachment.attachedDeviceUdid === udid && attachment.attachmentSource === "user")
        return true;
      for (const devices of attachment.agentDevicesByTurn.values())
        if (devices.has(udid)) return true;
    }
    return false;
  }

  /** Reuse the existing grace period whenever the last real consumer goes away. */
  private updateIdleTimer(udid: string): void {
    if (this.disposed || !this.synaraBooted.has(udid)) return;
    if (this.isDeviceBusy(udid)) {
      this.clearIdleTimer(udid);
      return;
    }
    if (this.idleTimers.has(udid)) return;
    const timer = this.schedule(() => {
      if (this.idleTimers.get(udid) !== timer) return;
      this.idleTimers.delete(udid);
      const shutdown = this.shutdownIfStillIdle(udid).finally(() => {
        if (this.idleShutdowns.get(udid) === shutdown) this.idleShutdowns.delete(udid);
      });
      this.idleShutdowns.set(udid, shutdown);
    }, this.idleShutdownMs);
    timer.unref?.();
    this.idleTimers.set(udid, timer);
  }

  /** Starting `udid` would end a stream someone is watching, for no viewer of its own. */
  private wouldStealStream(udid: string): boolean {
    const active = this.activeStreamUdid;
    return (
      active !== null &&
      active !== udid &&
      this.transport.deviceSubscriberCount(udid) === 0 &&
      this.transport.deviceSubscriberCount(active) > 0
    );
  }

  /**
   * The helper died under a live stream. Its frames simply stopped, so the
   * pane froze on the last one with nothing reporting it. The stream is
   * rebuilt on a fresh helper while anyone still needs it, and a failure is
   * shown on every thread watching the device.
   */
  private handleStreamInterrupted(udid: string, reason: string): void {
    const recovery = this.streamTransition.then(async () => {
      if (this.disposed || this.activeStreamUdid !== udid) return;
      this.activeStreamUdid = null;
      this.transport.resetDevice(udid);
      const needed =
        this.desiredStreamUdid === udid && this.transport.deviceSubscriberCount(udid) > 0;
      if (!needed) {
        if (this.desiredStreamUdid === udid) this.desiredStreamUdid = null;
        return;
      }
      this.desiredStreamUdid = udid;
      try {
        await this.reconcileStream();
      } catch (error) {
        const message = `The simulator helper stopped (${reason}) and could not be restarted: ${errorMessage(error)}`;
        for (const [threadId, attachment] of this.threads) {
          if (attachment.attachedDeviceUdid !== udid) continue;
          attachment.attachPhase = null;
          attachment.lastError = message;
          await this.publish(threadId);
        }
      }
    });
    this.streamTransition = recovery.catch(() => undefined);
  }

  private async startStream(udid: string): Promise<boolean> {
    if (this.disposed) return false;
    this.desiredStreamUdid = udid;
    await this.queueStreamReconciliation();
    return this.activeStreamUdid === udid;
  }

  /** Clear stale startup state from every thread now watching this device. */
  private async clearStreamStartupState(udid: string): Promise<void> {
    const cleared: string[] = [];
    for (const [threadId, attachment] of this.threads) {
      if (
        attachment.attachedDeviceUdid !== udid ||
        (attachment.lastError === null && attachment.attachPhase === null)
      ) {
        continue;
      }
      attachment.lastError = null;
      attachment.attachPhase = null;
      cleared.push(threadId);
    }
    for (const threadId of cleared) await this.publish(threadId);
  }

  /**
   * Force a fresh codec-config frame followed by a keyframe.
   *
   * There is no "emit an IDR now" call in the helper, and the encoder's natural
   * keyframe interval is seconds away, so a decoder that has lost sync would
   * otherwise sit frozen. Restarting the stream builds a new compression
   * session, which always emits parameter sets and an IDR as its first frames.
   *
   * Cached frames are dropped first so a late subscriber cannot be primed with
   * a keyframe from the previous generation.
   */
  async requestKeyframe(udid: string): Promise<void> {
    if (this.activeStreamUdid !== udid || this.disposed) return;
    this.desiredStreamUdid = null;
    await this.queueStreamReconciliation();
    if (
      this.disposed ||
      this.desiredStreamUdid !== null ||
      this.transport.deviceSubscriberCount(udid) === 0
    ) {
      return;
    }
    await this.startStream(udid);
  }

  private async stopStream(udid: string): Promise<void> {
    if (this.desiredStreamUdid === udid) {
      this.desiredStreamUdid = null;
    } else if (this.desiredStreamUdid !== null || this.activeStreamUdid !== udid) {
      return;
    }
    await this.queueStreamReconciliation();
  }

  private queueStreamReconciliation(): Promise<void> {
    const transition = this.streamTransition.then(() => this.reconcileStream());
    this.streamTransition = transition.catch(() => undefined);
    return transition;
  }

  private async reconcileStream(): Promise<void> {
    while (true) {
      const desired = this.disposed ? null : this.desiredStreamUdid;
      if (this.activeStreamUdid === desired) return;
      if (this.activeStreamUdid !== null) {
        const active = this.activeStreamUdid;
        this.activeStreamUdid = null;
        this.transport.resetDevice(active);
        await this.backend.detachStream(active);
        continue;
      }
      if (desired === null) return;

      try {
        await this.backend.attachStream(desired, (frame) => {
          if (this.desiredStreamUdid === desired || this.activeStreamUdid === desired) {
            this.transport.publish(desired, frame);
          }
        });
      } catch (error) {
        if (!this.disposed && this.desiredStreamUdid === desired) {
          this.desiredStreamUdid = null;
          throw error;
        }
        continue;
      }

      if (this.disposed || this.desiredStreamUdid !== desired) {
        this.transport.resetDevice(desired);
        await this.backend.detachStream(desired);
        continue;
      }
      this.activeStreamUdid = desired;
      await this.clearStreamStartupState(desired);
    }
  }

  /**
   * Nobody is watching this device any more. Stop the stream, and either shut
   * the device down or start the idle countdown if Synara booted it.
   *
   * A switch shuts down immediately rather than waiting out the idle window.
   * The cap is three Synara-booted devices, and each one costs a couple of GB
   * of RAM, so trying three simulators in a row filled every slot with devices
   * nobody was looking at and made the fourth pick prompt for a shutdown the
   * user had effectively already asked for. A plain detach still uses the idle
   * timer, because coming back to a device you just closed is common and
   * re-booting it costs a minute.
   *
   * User-booted devices are never touched by either path.
   */
  private async releaseDevice(
    udid: string,
    reason: "detached" | "switched" = "detached",
  ): Promise<void> {
    await this.stopRecordingIfActive(udid).catch(() => undefined);
    if (this.isAttachedAnywhere(udid) || this.isDeviceBusy(udid)) return;
    if (this.transport.deviceSubscriberCount(udid) === 0) {
      await this.stopStream(udid).catch(() => undefined);
    }
    if (!this.synaraBooted.has(udid)) return;
    if (reason === "switched") {
      this.clearIdleTimer(udid);
      // Failure here is not the switch's problem: the new device is already
      // attached, and the idle sweep at quit still cleans this one up.
      await this.shutdown(udid).catch(() => undefined);
      return;
    }
    this.updateIdleTimer(udid);
  }

  private async stopRecordingIfActive(udid: string): Promise<void> {
    if (!this.recording.has(udid)) return;
    await this.stopRecording(udid);
  }

  private async shutdownIfStillIdle(udid: string): Promise<void> {
    if (this.disposed) return;
    // Re-checked at fire time: a thread may have re-attached during the wait.
    if (this.isDeviceBusy(udid) || !this.synaraBooted.has(udid)) return;
    await this.shutdown(udid, true).catch(() => undefined);
  }

  /** Guard the shared native boundary, including pane RPCs that have no agent turn. */
  private async withDeviceAction<A>(udid: string, action: () => Promise<A>): Promise<A> {
    this.assertNotDisposed();
    this.clearIdleTimer(udid);
    this.activeDeviceActions.set(udid, (this.activeDeviceActions.get(udid) ?? 0) + 1);
    try {
      await this.waitForIdleShutdown(udid);
      this.assertNotDisposed();
      return await action();
    } finally {
      const remaining = (this.activeDeviceActions.get(udid) ?? 1) - 1;
      if (remaining === 0) this.activeDeviceActions.delete(udid);
      else this.activeDeviceActions.set(udid, remaining);
      this.updateIdleTimer(udid);
    }
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new DeviceBackendError("Device manager is disposed.");
  }

  /** An idle poweroff already sent to simctl cannot be cancelled; renew its owned boot first. */
  private async waitForIdleShutdown(udid: string): Promise<void> {
    const shutdown = this.idleShutdowns.get(udid);
    if (!shutdown) return;
    await shutdown;
    this.assertNotDisposed();
    const resuming = this.idleShutdowns.get(udid);
    if (resuming !== undefined && resuming !== shutdown) {
      await resuming;
      this.assertNotDisposed();
      return;
    }
    if (!this.synaraBooted.has(udid) && this.isDeviceBusy(udid)) {
      // Concurrent viewers/tools share the one restoration, including its boot-cap check.
      const restoration = this.boot(udid)
        .then((result) => {
          if (result.kind !== "booted")
            throw new DeviceBackendError(
              "The simulator boot limit was reached while resuming device use.",
            );
        })
        .finally(() => {
          if (this.idleShutdowns.get(udid) === restoration) this.idleShutdowns.delete(udid);
        });
      this.idleShutdowns.set(udid, restoration);
      await restoration;
      this.assertNotDisposed();
    }
  }

  private clearIdleTimer(udid: string): void {
    const timer = this.idleTimers.get(udid);
    if (!timer) return;
    this.cancel(timer);
    this.idleTimers.delete(udid);
  }

  /**
   * Build a thread's state. `reuseDiscovery` serves the last availability and
   * device list this manager already published instead of re-running the
   * subprocess-backed toolchain and simulator discovery; it is only used by
   * publishes that change nothing about the device list (the agent-activity
   * badge, a recorded error), which previously cost ~a dozen process spawns
   * per agent tool call. Boot, shutdown, attach and explicit reads keep
   * discovering fresh state, and the first publish always discovers.
   */
  private async snapshot(
    threadId: string,
    options: { readonly reuseDiscovery?: boolean } = {},
  ): Promise<ThreadDeviceState> {
    const attachment = this.threadState(threadId);
    let discovery = options.reuseDiscovery ? this.lastDiscovery : null;
    if (discovery === null) {
      const availability = await this.backend.availability();
      const devices = await this.discover(availability, { includeShutdown: true });
      discovery = { availability, devices };
      this.lastDiscovery = discovery;
    }
    const { availability, devices } = discovery;
    return {
      threadId: threadId as ThreadDeviceState["threadId"],
      version: attachment.version,
      attachedDeviceUdid: attachment.attachedDeviceUdid as ThreadDeviceState["attachedDeviceUdid"],
      devices: fitDeviceList(devices, attachment.attachedDeviceUdid),
      agentActive: attachment.agentActiveCount > 0,
      availability,
      lastError: attachment.lastError === null ? null : fitDeviceMessage(attachment.lastError),
      attachPhase: attachment.attachPhase,
    };
  }

  private async publish(
    threadId: string,
    options: { readonly reuseDiscovery?: boolean } = {},
  ): Promise<ThreadDeviceState> {
    const attachment = this.threadState(threadId);
    attachment.version += 1;
    const state = await this.snapshot(threadId, options);
    this.emit({ type: "device.thread-state", state });
    return state;
  }

  /** A boot or shutdown changes the device list every open pane is showing. */
  private async publishAllThreads(): Promise<void> {
    for (const [threadId] of this.threads) await this.publish(threadId);
  }

  private emit(event: DeviceEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // One bad listener must not stop the rest from seeing device events.
      }
    }
  }
}

/**
 * Keep a thread's device list within the contract's cap. A machine with every
 * runtime installed can have more simulators than that, and an over-long list
 * fails the RPC encode. The attached device and booted devices are kept first.
 */
function fitDeviceList(
  devices: readonly DeviceDescriptor[],
  attachedUdid: string | null,
): readonly DeviceDescriptor[] {
  if (devices.length <= DEVICE_THREAD_STATE_MAX_DEVICES) return devices;
  const rank = (device: DeviceDescriptor) =>
    device.udid === attachedUdid ? 0 : device.state === "shutdown" ? 2 : 1;
  return devices.toSorted((a, b) => rank(a) - rank(b)).slice(0, DEVICE_THREAD_STATE_MAX_DEVICES);
}

export function errorMessage(error: unknown): string {
  if (error instanceof DeviceBackendError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
