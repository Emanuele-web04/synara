/** thread-scoped attachment; records Synara-booted devices (backend can't attribute boots) so only those are auto-shut-down; boot cap is refusable not fatal; shutdown triggers: quit, thread removal, idle timeout */
import {
  NULL_BOOT_OWNERSHIP,
  orphanedBootUdids,
  processIsAlive,
  type BootOwnershipStore,
} from "./bootOwnership.ts";
import {
  DEVICE_SYNARA_BOOT_LIMIT,
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
  type DeviceScreenshotResult,
  type DeviceStartRecordingResult,
  type DeviceStopRecordingResult,
  type DeviceUiNode,
  type ThreadDeviceState,
} from "@synara/contracts";

import {
  DeviceBackendError,
  type DeviceBackend,
  type DeviceKeyEvent,
  type DeviceSwipeGesture,
} from "./DeviceBackend.ts";
import { DeviceFrameTransport, type DeviceFrameSink } from "./deviceFrameTransport.ts";
import {
  DeviceUiTargetError,
  SCROLL_SWIPE_DURATION_MS,
  findTarget,
  planScrollStep,
  visibleLabels,
  type DeviceUiTarget,
  type DeviceUiTargetMatch,
} from "./uiTreeTargeting.ts";

export const DEVICE_IDLE_SHUTDOWN_MS = 10 * 60 * 1000;

export const DEVICE_ATTACH_DEADLINE_MS = 60_000;

export const DEVICE_ATTACH_RETRY_MS = 750;

/** names the one action that actually fixes it — retrying is what just failed */
const DISPLAY_TIMEOUT_MESSAGE =
  "The simulator booted but never published a screen to capture. Shut it down and start it again; " +
  "if that keeps happening, the runtime may need reinstalling from Xcode's Platforms settings.";

/** failures meaning "not ready yet", not "will never work" — anything else is reported immediately rather than retried for a minute */
export function isTransientAttachFailure(error: unknown): boolean {
  if (error instanceof DeviceBackendError && error.retryable) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /framebuffer surface|display has no|is not booted|not attached|no display/iu.test(message);
}

/** remembers Synara's boots across a crash; defaults to remembering nothing */
export const DEVICE_DEFAULT_MAX_SCROLLS = 8;

export type DeviceEventListener = (event: DeviceEvent) => void;

export interface DeviceManagerOptions {
  readonly backend: DeviceBackend;
  readonly transport?: DeviceFrameTransport;
  readonly idleShutdownMs?: number;
  readonly bootLimit?: number;
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
  lastError: string | null;
  attachPhase: DeviceAttachPhase | null;
  /** a retry loop finding a different token has been superseded and stops without touching the newer attempt's state */
  attachToken: number;
  /** an agent calls a tool every few seconds — this makes the second and later open requests a no-op */
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
  private readonly synaraBooted = new Set<string>();
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  private activeStreamUdid: string | null = null;
  private desiredStreamUdid: string | null = null;
  /** serializes the helper's single stream while allowing the desired device to change */
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
  }

  private async recordBootOwnership(): Promise<void> {
    await this.bootOwnership.write([...this.synaraBooted]).catch(() => undefined);
  }

  /** reclaim simulators a crashed run booted — a clean quit leaves an empty record; without this they linger forever as "user"-booted, outside cap/idle-sweep/quit shutdown; returns udids so the caller can log the kills */
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
    // cleared even when nothing was shut down — the record described a dead process
    if (!isProcessAlive(recorded.pid)) await this.bootOwnership.clear().catch(() => undefined);
    return orphans;
  }

  /** waits without holding the process open, and shares the injected scheduler */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = this.schedule(() => resolve(), ms);
      timer.unref?.();
    });
  }

  onEvent(listener: DeviceEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async availability(): Promise<DeviceAvailability> {
    return await this.backend.availability();
  }

  async list(options: { readonly includeShutdown?: boolean } = {}): Promise<DeviceListResult> {
    const availability = await this.backend.availability();
    const devices = await this.discover(availability, options);
    return { devices, availability };
  }

  /** gated only on platform, never on availability — listing runs on simctl which works long before the helper exists; requiring `available` deadlocked a fresh machine (empty picker ⇐ unbuilt helper ⇐ no udid) */
  private async discover(
    availability: DeviceAvailability,
    options: { readonly includeShutdown?: boolean } = {},
  ): Promise<readonly DeviceDescriptor[]> {
    if (availability.kind === "unsupported-platform") return [];
    // already reported through `availability` — an empty list is the honest answer when simctl can't run
    const devices = await this.backend.listDevices(options).catch(() => []);
    return devices.map((device) => this.describe(device));
  }

  async getThreadState(threadId: string): Promise<ThreadDeviceState> {
    return await this.snapshot(threadId);
  }

  async synaraBootedDevices(): Promise<readonly DeviceDescriptor[]> {
    const devices = await this.backend.listDevices({ includeShutdown: true }).catch(() => []);
    this.reconcileSynaraBooted(devices);
    return devices
      .filter((device) => this.synaraBooted.has(device.udid))
      .map((device) => this.describe(device));
  }

  /** reconcile bookkeeping against the listing: devices stopped behind our back (simctl shutdown, Simulator.app quit, crashed runtime) left phantoms holding slots; reconciled from the listing every caller already has rather than polling */
  private reconcileSynaraBooted(devices: readonly DeviceDescriptor[]): void {
    const running = new Set(
      devices
        .filter((device) => device.state === "booted" || device.state === "booting")
        .map((device) => device.udid),
    );
    for (const udid of this.synaraBooted) {
      if (running.has(udid)) continue;
      this.synaraBooted.delete(udid);
      this.clearIdleTimer(udid);
    }
  }

  async boot(udid: string): Promise<DeviceBootResult> {
    const devices = await this.backend.listDevices({ includeShutdown: true }).catch(() => []);
    // devices stopped without Synara still held their slots — three shell shutdowns refused every later boot
    this.reconcileSynaraBooted(devices);
    const known = devices.find((device) => device.udid === udid) ?? null;
    // viewing an already-booted device is uncapped — the cap stops Synara accumulating simulators, not what the user watches
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

    // the slot is taken before the await — a boot runs ~a minute and two concurrent requests would both read under the limit
    this.synaraBooted.add(udid);
    let device: DeviceDescriptor;
    try {
      device = await this.backend.boot(udid);
    } catch (cause) {
      // a reservation only stands for a boot that happened — holding it after failure leaks the slot for the process lifetime
      this.synaraBooted.delete(udid);
      throw cause;
    }
    // persisted before the caller is told the boot succeeded — a crash still leaves a record to reclaim
    await this.recordBootOwnership();
    this.clearIdleTimer(udid);
    await this.publishAllThreads();
    return { kind: "booted", device: { ...device, bootSource: "synara" } };
  }

  async shutdown(udid: string): Promise<void> {
    await this.stopRecordingIfActive(udid).catch(() => undefined);
    await this.stopStream(udid);
    await this.backend.shutdown(udid);
    this.synaraBooted.delete(udid);
    await this.recordBootOwnership();
    this.clearIdleTimer(udid);
    // any thread watching this device loses its attachment rather than pointing at a shut-down simulator
    for (const [threadId, attachment] of this.threads) {
      if (attachment.attachedDeviceUdid !== udid) continue;
      attachment.attachedDeviceUdid = null;
      attachment.attachPhase = null;
      // stops a retry loop still waiting on this device's display — it is not coming
      attachment.attachToken += 1;
      await this.publish(threadId);
    }
    await this.publishAllThreads();
  }

  /** resolves once the attachment is recorded, not when the picture arrives — a cold boot publishes its display seconds after reporting booted; the stream comes up in the background pushing a phase per stage */
  async attach(threadId: string, udid: string): Promise<ThreadDeviceState> {
    const attachment = this.threadState(threadId);
    const previous = attachment.attachedDeviceUdid;
    // cleared before releasing — this thread must no longer count as a holder
    attachment.attachedDeviceUdid = udid;
    attachment.lastError = null;
    attachment.attachPhase = "connecting";
    const token = (attachment.attachToken += 1);
    if (previous !== null && previous !== udid) await this.releaseDevice(previous, "switched");
    this.clearIdleTimer(udid);

    // already streaming — nothing to wait for, so the phase clears without a round trip
    if (this.activeStreamUdid === udid || this.desiredStreamUdid === udid) {
      attachment.attachPhase = null;
      return await this.publish(threadId);
    }

    const state = await this.publish(threadId);
    void this.bringStreamUp(threadId, udid, token);
    return state;
  }

  /** the retry is the whole point: attaching before the display is published fails every time; bounded so a device that never comes up ends in a message naming what to do */
  private async bringStreamUp(threadId: string, udid: string, token: number): Promise<void> {
    const deadline = this.now() + this.attachDeadlineMs;
    let sawTransientFailure = false;

    while (!this.disposed) {
      const attachment = this.threads.get(threadId);
      // superseded or gone — another attach owns this thread's state now
      if (!attachment || attachment.attachToken !== token) return;

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
    // only the display-wait deadline gets the tailored message — a disposal or shutdown mid-wait is not the user's problem
    if (sawTransientFailure && !this.disposed) attachment.lastError = DISPLAY_TIMEOUT_MESSAGE;
    await this.publish(threadId);
  }

  /** never steals a deliberate attachment; idempotent so repeated launches cost nothing; attaching first means the open request lands on a state already naming a device */
  async ensureThreadAttached(threadId: string, udid: string): Promise<void> {
    const attached = this.threadState(threadId).attachedDeviceUdid;
    if (attached === udid) return;
    if (attached !== null) return;
    await this.attach(threadId, udid);
  }

  async detach(threadId: string): Promise<ThreadDeviceState> {
    const attachment = this.threadState(threadId);
    const udid = attachment.attachedDeviceUdid;
    attachment.attachedDeviceUdid = null;
    attachment.attachPhase = null;
    // abandons any attach still retrying in the background so it can't resurrect a phase on a thread no longer watching
    attachment.attachToken += 1;
    if (udid !== null) await this.releaseDevice(udid);
    return await this.publish(threadId);
  }

  /** thread archive or deletion is terminal for its attachment — treat as a detach */
  async handleThreadRemoved(threadId: string): Promise<void> {
    if (!this.threads.has(threadId)) return;
    await this.detach(threadId);
    this.threads.delete(threadId);
  }

  /** the stream starts lazily and stops when the last subscriber and attachment go away */
  subscribeFrames(udid: string, sink: DeviceFrameSink): () => void {
    const unsubscribe = this.transport.subscribe(udid, sink);
    void this.startStream(udid).catch(() => undefined);
    return () => {
      unsubscribe();
      // capture stops when the last viewer goes — gating on the attachment meant the helper encoded H.264 for nobody, indefinitely; the attachment is metadata and survives, only the encode stops
      if (this.transport.deviceSubscriberCount(udid) === 0) {
        void this.stopStream(udid).catch(() => undefined);
      }
    };
  }

  async tap(udid: string, x: number, y: number): Promise<void> {
    await this.backend.tap(udid, x, y);
  }

  /** the tree is read fresh rather than cached — a stale frame is how a tap lands on whatever scrolled into that position */
  async tapElement(
    udid: string,
    target: DeviceUiTarget,
    options: { readonly maxScrolls?: number | undefined } = {},
  ): Promise<DeviceUiTargetMatch> {
    const match = await this.scrollToElement(udid, target, options);
    await this.backend.tap(udid, match.point.x, match.point.y);
    return match;
  }

  /** the swipe-describe-check loop lives here, not in the agent — it is motor control, not judgement; a label absent from the tree is "not reached yet" because long lists are virtualized, reported missing only once the list stops moving */
  async scrollToElement(
    udid: string,
    target: DeviceUiTarget,
    options: { readonly maxScrolls?: number | undefined } = {},
  ): Promise<DeviceUiTargetMatch> {
    const maxScrolls = options.maxScrolls ?? DEVICE_DEFAULT_MAX_SCROLLS;
    let tree = await this.describeUi(udid);
    let match = this.locate(tree.root, target);
    let previousPosition: string | null = null;

    for (let scrolls = 0; scrolls < maxScrolls; scrolls += 1) {
      // nothing to aim at yet — page down a screenful to materialize more of the list
      const step =
        match === null ? this.pageDownStep(tree.root) : planScrollStep(match.node, tree.root);
      if (step === null) return match as DeviceUiTargetMatch;

      await this.backend.swipe(udid, step);
      tree = await this.describeUi(udid);
      match = this.locate(tree.root, target);

      // a list at its end keeps rendering the same thing — swiping again would burn the budget
      const position = match === null ? this.treeFingerprint(tree.root) : `y:${match.node.frame.y}`;
      if (previousPosition !== null && position === previousPosition) {
        throw new DeviceUiTargetError(
          match === null
            ? `No element labelled ${JSON.stringify(target.label)} appeared after scrolling to the end of the screen.`
            : `Scrolling stopped moving ${JSON.stringify(target.label)} after ${scrolls + 1} ` +
                `swipe${scrolls === 0 ? "" : "s"}; the list appears to be at its end and the element is still out of reach.`,
          match === null ? visibleLabels(tree.root) : [],
          match === null,
        );
      }
      previousPosition = position;
    }

    if (match !== null && planScrollStep(match.node, tree.root) === null) return match;
    throw new DeviceUiTargetError(
      `Could not bring ${JSON.stringify(target.label)} into view within ${maxScrolls} swipes. ` +
        `Raise maxSwipes, or scroll manually with device_swipe if it sits in a nested scroll area.`,
      match === null ? visibleLabels(tree.root) : [],
      match === null,
    );
  }

  /** the match, or null when the label has not been rendered into the tree yet */
  private locate(root: DeviceUiNode, target: DeviceUiTarget): DeviceUiTargetMatch | null {
    try {
      return findTarget(root, target);
    } catch (error) {
      // only absence means "keep scrolling" — an ambiguous label is a real answer that propagates
      if (error instanceof DeviceUiTargetError && error.notFound) return null;
      throw error;
    }
  }

  /** a blind screenful downward, for when the target has not appeared yet */
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

  /** what is on screen now, to tell a moving list from a stuck one */
  private treeFingerprint(root: DeviceUiNode): string {
    return visibleLabels(root).join("|");
  }

  async swipe(udid: string, gesture: DeviceSwipeGesture): Promise<void> {
    await this.backend.swipe(udid, gesture);
  }

  async typeText(udid: string, text: string): Promise<void> {
    await this.backend.typeText(udid, text);
  }

  async keyEvent(udid: string, event: DeviceKeyEvent): Promise<void> {
    await this.backend.keyEvent(udid, event);
  }

  async pressButton(udid: string, button: DeviceHardwareButton): Promise<void> {
    await this.backend.pressButton(udid, button);
  }

  async install(udid: string, appPath: string): Promise<DeviceInstallAppResult> {
    return await this.backend.install(udid, appPath);
  }

  async launch(
    udid: string,
    bundleId: string,
    launchArguments?: readonly string[],
  ): Promise<DeviceLaunchAppResult> {
    return await this.backend.launch(udid, bundleId, launchArguments);
  }

  async openUrl(udid: string, url: string): Promise<void> {
    await this.backend.openUrl(udid, url);
  }

  async screenshot(
    udid: string,
    options: { readonly save?: boolean } = {},
  ): Promise<DeviceScreenshotResult> {
    return await this.backend.screenshot(udid, options);
  }

  async startRecording(udid: string): Promise<DeviceStartRecordingResult> {
    const alreadyTracked = this.recording.has(udid);
    this.recording.add(udid);
    try {
      return await this.backend.startRecording(udid);
    } catch (error) {
      if (!alreadyTracked) this.recording.delete(udid);
      throw error;
    }
  }

  async stopRecording(udid: string): Promise<DeviceStopRecordingResult> {
    const result = await this.backend.stopRecording(udid);
    this.recording.delete(udid);
    return result;
  }

  async describeUi(udid: string): Promise<DeviceDescribeUiResult> {
    return await this.backend.describeUi(udid);
  }

  /** nested calls counted so overlapping tool calls do not clear the badge early */
  async withAgentActivity<A>(threadId: string, action: () => Promise<A>): Promise<A> {
    const attachment = this.threadState(threadId);
    attachment.agentActiveCount += 1;
    if (attachment.agentActiveCount === 1) await this.publish(threadId);
    try {
      return await action();
    } finally {
      attachment.agentActiveCount = Math.max(0, attachment.agentActiveCount - 1);
      if (attachment.agentActiveCount === 0) await this.publish(threadId);
    }
  }

  /** auto-open the pane when an agent puts an app on a device */
  requestOpenPane(threadId: string, udid: string, reason: DeviceOpenPaneReason): void {
    this.threadState(threadId).paneSurfacedUdid = udid;
    this.emit({
      type: "device.open-pane-requested",
      threadId: ThreadId.makeUnsafe(threadId),
      udid,
      reason,
    });
  }

  /** called on every device interaction, not just install/launch — gating on those left the user watching a blank pane; a no-op once surfaced so taps don't emit an event each or yank a navigated-away user back */
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
    await this.publish(threadId);
  }

  /** quit: shut down everything Synara booted, leave the user's devices alone, release the backend */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const [, timer] of this.idleTimers) this.cancel(timer);
    this.idleTimers.clear();
    // snapshotted — both loops mutate the set they are walking
    const recording = Array.from(this.recording);
    const booted = Array.from(this.synaraBooted);
    this.desiredStreamUdid = null;
    await this.queueStreamReconciliation().catch(() => undefined);
    for (const udid of recording) await this.stopRecordingIfActive(udid).catch(() => undefined);
    for (const udid of booted) {
      await this.backend.shutdown(udid).catch(() => undefined);
      this.synaraBooted.delete(udid);
    }
    // nothing is ours any more — a later start must not adopt these
    await this.bootOwnership.clear().catch(() => undefined);
    this.listeners.clear();
    await this.backend.dispose().catch(() => undefined);
  }

  private threadState(threadId: string): ThreadAttachment {
    let attachment = this.threads.get(threadId);
    if (!attachment) {
      attachment = {
        version: 0,
        attachedDeviceUdid: null,
        agentActiveCount: 0,
        lastError: null,
        attachPhase: null,
        attachToken: 0,
        paneSurfacedUdid: null,
      };
      this.threads.set(threadId, attachment);
    }
    return attachment;
  }

  /** fills the fields discovery cannot know (boot source, screen geometry); every descriptor the manager hands out passes through here */
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

  private async startStream(udid: string): Promise<boolean> {
    if (this.disposed) return false;
    this.desiredStreamUdid = udid;
    await this.queueStreamReconciliation();
    return this.activeStreamUdid === udid;
  }

  /** clear stale startup state from every thread watching this device */
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

  /** no "emit IDR now" call exists and the natural keyframe interval is seconds away — restarting the stream rebuilds the compression session, which always emits config+IDR first; cached frames dropped so a late subscriber isn't primed with a keyframe from the previous generation */
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

  /** a switch shuts down immediately rather than idling — the cap is three and each simulator costs ~GBs of RAM; a plain detach still uses the idle timer since coming back is common; user-booted devices never touched */
  private async releaseDevice(
    udid: string,
    reason: "detached" | "switched" = "detached",
  ): Promise<void> {
    await this.stopRecordingIfActive(udid).catch(() => undefined);
    if (this.isAttachedAnywhere(udid)) return;
    if (this.transport.deviceSubscriberCount(udid) === 0) {
      await this.stopStream(udid).catch(() => undefined);
    }
    if (!this.synaraBooted.has(udid)) return;
    if (reason === "switched") {
      this.clearIdleTimer(udid);
      // failure here is not the switch's problem — the new device is already attached and the quit-time sweep cleans this one
      await this.shutdown(udid).catch(() => undefined);
      return;
    }
    this.clearIdleTimer(udid);
    const timer = this.schedule(() => {
      this.idleTimers.delete(udid);
      void this.shutdownIfStillIdle(udid);
    }, this.idleShutdownMs);
    // a pending idle shutdown must not keep the process alive at exit
    timer.unref?.();
    this.idleTimers.set(udid, timer);
  }

  private async stopRecordingIfActive(udid: string): Promise<void> {
    if (!this.recording.has(udid)) return;
    await this.stopRecording(udid);
  }

  private async shutdownIfStillIdle(udid: string): Promise<void> {
    if (this.disposed) return;
    // re-checked at fire time — a thread may have re-attached during the wait
    if (this.isAttachedAnywhere(udid) || !this.synaraBooted.has(udid)) return;
    await this.shutdown(udid).catch(() => undefined);
  }

  private clearIdleTimer(udid: string): void {
    const timer = this.idleTimers.get(udid);
    if (!timer) return;
    this.cancel(timer);
    this.idleTimers.delete(udid);
  }

  private async snapshot(threadId: string): Promise<ThreadDeviceState> {
    const attachment = this.threadState(threadId);
    const availability = await this.backend.availability();
    const devices = await this.discover(availability, { includeShutdown: true });
    return {
      threadId: threadId as ThreadDeviceState["threadId"],
      version: attachment.version,
      attachedDeviceUdid: attachment.attachedDeviceUdid as ThreadDeviceState["attachedDeviceUdid"],
      devices,
      agentActive: attachment.agentActiveCount > 0,
      availability,
      lastError: attachment.lastError,
      attachPhase: attachment.attachPhase,
    };
  }

  private async publish(threadId: string): Promise<ThreadDeviceState> {
    const attachment = this.threadState(threadId);
    attachment.version += 1;
    const state = await this.snapshot(threadId);
    this.emit({ type: "device.thread-state", state });
    return state;
  }

  /** a boot or shutdown changes the device list every open pane is showing */
  private async publishAllThreads(): Promise<void> {
    for (const [threadId] of this.threads) await this.publish(threadId);
  }

  private emit(event: DeviceEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // one bad listener must not stop the rest seeing device events
      }
    }
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof DeviceBackendError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
