/**
 * The still-frame stream every Tier-1 desktop backend publishes.
 *
 * A Tier-1 backend has no video encoder: it pulls one still on a timer and
 * pushes it at whoever is watching the pane. The still is always scoped to the
 * thing the agent is using — one exact window, or one browser tab — and never
 * the whole desktop: a capture with no such target returns `undefined` and
 * nothing is published. The loop around that is identical on every display
 * server — one interval, one capture in flight at a time, a byte-identity
 * dedupe (`StillFrameDedupe`), and the `force` bookkeeping that guarantees a
 * receiver with nothing to draw gets a picture even when the target has not
 * changed.
 *
 * The part worth stating is the failure bound. An earlier version re-armed the
 * deferred force whenever a forced capture threw, and the `finally` block then
 * immediately republished because a force was pending — so a target whose
 * captures kept failing (a revoked Screen Recording grant, a window that moved
 * off the current Space) spun in a tight recursive retry loop for as long as
 * anyone watched the pane, with no delay between attempts. Here a failed force
 * buys exactly one immediate retry; after that the request is dropped and the
 * ordinary timer cadence takes over, so a persistent failure costs two captures
 * per interval instead of an unbounded recursion.
 *
 * @module computer/stillFramePublisher
 */
import type { ComputerFrameMimeType } from "@synara/contracts";
import type { ComputerFrameListener, ComputerStreamFrame } from "./ComputerBackend.ts";
import { createHash } from "node:crypto";

/**
 * Immediate retries a failed forced publish may buy before the request is
 * dropped. One, because the point of a retry here is to ride out a single
 * transient capture failure; anything past that is a broken capture path, and
 * the timer will ask again in a moment anyway.
 */
const MAX_FORCE_RETRIES = 1;

/**
 * How often a Tier-1 backend pulls a still when nobody asked for a faster one.
 * Twice a second: fast enough that the pane reads as live, slow enough that a
 * window PNG encode is not the machine's busiest job.
 */
export const DEFAULT_STILL_INTERVAL_MS = 500;

/**
 * The floor a caller-supplied interval is clamped to. Below this the capture
 * for one tick has not finished before the next is due, so the loop only ever
 * queues work it cannot do.
 */
export const MIN_STILL_INTERVAL_MS = 100;

/**
 * How often a paused publisher looks again. Only a flag is read per look; the
 * point is that the still after a desktop operation lands right after it, not
 * a whole interval later.
 */
const PAUSE_POLL_MS = 50;

/** The one clamp both Tier-1 backends apply to their configured interval. */
export function resolveStillIntervalMs(intervalMs: number | undefined): number {
  return Math.max(MIN_STILL_INTERVAL_MS, intervalMs ?? DEFAULT_STILL_INTERVAL_MS);
}
/**
 * Byte-identity key for a captured still. Length first so two frames of
 * different sizes never even reach the hash, then a digest of the pixels —
 * cheap next to the PNG encode that produced them.
 */
export function frameDigest(bytes: Uint8Array): string {
  return `${bytes.byteLength}:${createHash("sha1").update(bytes).digest("hex")}`;
}

/**
 * Suppresses still frames that carry no new picture. Owned by the ticker in
 * this file: one interval, one capture in flight, one digest memory. A
 * receiver with nothing to draw still gets a picture via `force`, including
 * a force that arrives mid-capture.
 */
export class StillFrameDedupe {
  #publishedDigest: string | undefined;
  #pendingForce = false;

  /**
   * Records a keyframe request that could not be served now. The next publish
   * consumes it, so a request arriving mid-capture is not lost.
   */
  deferForce(): void {
    this.#pendingForce = true;
  }

  /**
   * Whether this publish must go out regardless of the digest, consuming any
   * deferred request. Call once per publish attempt, before capturing.
   */
  takeForce(explicit: boolean): boolean {
    const force = explicit || this.#pendingForce;
    this.#pendingForce = false;
    return force;
  }

  /** True when a deferred keyframe is still owed to the receiver. */
  get forcePending(): boolean {
    return this.#pendingForce;
  }

  /**
   * Whether `bytes` should go on the wire, recording it as published when so.
   * `force` comes from `takeForce`.
   */
  shouldPublish(bytes: Uint8Array, force: boolean): boolean {
    const digest = frameDigest(bytes);
    if (!force && digest === this.#publishedDigest) return false;
    this.#publishedDigest = digest;
    return true;
  }

  /**
   * Forgets what was published. Called whenever the receiver changes or goes
   * away: a re-attached pane has seen nothing, so the memory of what the last
   * one saw must not suppress its first frame.
   */
  reset(): void {
    this.#publishedDigest = undefined;
    this.#pendingForce = false;
  }
}

/**
 * One encoded still with its image type, for a backend whose preview stills
 * are not PNG (a JPEG preview encodes an order of magnitude faster). A bare
 * byte array is a PNG.
 */
export interface StillFrameCapture {
  readonly data: Uint8Array;
  readonly mimeType: ComputerFrameMimeType;
}

export interface StillFramePublisherOptions {
  /**
   * Captures one still of the current target — the exact window the task is
   * using, or one browser tab — as raw PNG bytes, or as a `StillFrameCapture`
   * naming another image type.
   *
   * `undefined` means "skip this frame without treating it as a failure": there
   * is no target to capture, or the backend noticed mid-capture that publishing
   * is no longer appropriate. A throw is a real failure and is what the retry
   * bound applies to.
   */
  readonly capture: (force: boolean) => Promise<Uint8Array | StillFrameCapture | undefined>;
  /**
   * Whether a capture could succeed at all right now. Checked before every
   * publish so a backend whose capture grant is missing never spends a round
   * trip discovering that twice a second.
   */
  readonly isCaptureAvailable: () => boolean;
  /** Brought up before the first frame: the helper spawn, the plugin connect. */
  readonly prepare?: () => Promise<void>;
  /**
   * Broadcasts one frame to the backend's event observers. The attached
   * listener is served by the publisher itself; this is the extra hop the
   * backends make so the pane and the event stream see the same still.
   */
  readonly emit: (frame: ComputerStreamFrame) => void;
  readonly now: () => number;
  readonly intervalMs: number;
  /**
   * The slower cadence a still target that stopped changing drops to: after
   * `idleAfterUnchanged` consecutive captures identical to the one the pane
   * already has, ticks come every `idleIntervalMs` instead of every
   * `intervalMs`, until a capture differs or `wake()` is called. Both unset
   * keeps one fixed cadence.
   */
  readonly idleIntervalMs?: number;
  readonly idleAfterUnchanged?: number;
  /**
   * Whether stills should wait right now, typically because a desktop
   * operation is running and a still would only queue in front of its own
   * capture. Checked on every tick; the first tick after it clears publishes
   * at once and returns to the fast cadence.
   */
  readonly paused?: () => boolean;
}

export class StillFramePublisher {
  private readonly options: StillFramePublisherOptions;
  /** Suppresses stills identical to the one the pane already has. */
  private readonly dedupe = new StillFrameDedupe();

  private listener: ComputerFrameListener | undefined;
  private attachmentGeneration = 0;
  /** A fixed cadence's interval, or an adaptive one's next tick. */
  private timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval> | undefined;
  /** When the scheduled tick is due, for `wake()` to pull it forward. */
  private dueAt = 0;
  private inFlight = false;
  private nextSequence = 1;
  private forceRetries = 0;
  /** Consecutive captures identical to the published still; see `idleIntervalMs`. */
  private unchangedCaptures = 0;
  /** Whether the last tick found the publisher paused; see `paused`. */
  private wasPaused = false;

  constructor(options: StillFramePublisherOptions) {
    this.options = options;
  }

  async attach(listener: ComputerFrameListener): Promise<void> {
    const generation = ++this.attachmentGeneration;
    this.listener = undefined;
    this.clearTimer();
    this.dedupe.reset();
    await this.options.prepare?.();
    // A detach or newer attach supersedes this preparation, even when callers
    // reuse the same callback or preparations finish out of order.
    if (this.attachmentGeneration !== generation) return;
    this.listener = listener;
    this.unchangedCaptures = 0;
    this.wasPaused = false;
    await this.publish({ force: true });
    if (this.attachmentGeneration !== generation) return;
    if (this.adaptive()) {
      this.schedule(this.options.intervalMs);
      return;
    }
    this.timer = setInterval(() => {
      void this.publish();
    }, this.options.intervalMs);
    this.timer.unref?.();
  }

  /** Whether the cadence moves at all: a backoff or a pause was configured. */
  private adaptive(): boolean {
    return (
      this.options.paused !== undefined ||
      (this.options.idleIntervalMs !== undefined && this.options.idleAfterUnchanged !== undefined)
    );
  }

  /**
   * Something on the desktop changed (an action ran, a window moved): back to
   * the fast cadence, with the next tick no further away than one interval.
   */
  wake(): void {
    this.unchangedCaptures = 0;
    if (this.timer === undefined || !this.adaptive()) return;
    if (this.dueAt - this.options.now() > this.options.intervalMs) {
      this.schedule(this.options.intervalMs);
    }
  }

  async detach(): Promise<void> {
    this.attachmentGeneration += 1;
    this.listener = undefined;
    this.clearTimer();
    this.dedupe.reset();
  }

  async requestKeyframe(): Promise<void> {
    if (!this.listener) return;
    // A keyframe is asked for because the receiver has nothing to draw, so it
    // publishes even when the target is byte-identical to the last frame.
    await this.publish({ force: true });
  }

  async publish(options: { readonly force?: boolean } = {}): Promise<void> {
    const listener = this.listener;
    const generation = this.attachmentGeneration;
    if (!listener || !this.options.isCaptureAvailable()) return;
    if (this.inFlight) {
      // A keyframe asked for while a still is already in flight used to be
      // dropped outright. The in-flight capture then deduped against the digest
      // it had just published and sent nothing, so the receiver that asked
      // precisely because it had no picture stayed blank until the target
      // happened to change. The request is remembered instead.
      if (options.force) {
        this.forceRetries = 0;
        this.dedupe.deferForce();
      }
      return;
    }
    this.inFlight = true;
    // A fresh explicit request gets its own retry budget: the previous
    // receiver's exhausted one says nothing about this one.
    if (options.force === true) this.forceRetries = 0;
    const force = this.dedupe.takeForce(options.force === true);
    try {
      const captured = await this.options.capture(force);
      if (captured === undefined) return;
      const bytes = captured instanceof Uint8Array ? captured : captured.data;
      const mimeType = captured instanceof Uint8Array ? undefined : captured.mimeType;
      if (this.attachmentGeneration !== generation) return;
      // An idle target encodes the same bytes every tick; republishing them
      // spends about a megabyte of socket to convey nothing.
      if (!this.dedupe.shouldPublish(bytes, force)) {
        this.unchangedCaptures += 1;
        return;
      }
      this.unchangedCaptures = 0;
      this.forceRetries = 0;
      const frame: ComputerStreamFrame = {
        sequence: this.nextSequence++,
        timestampMs: this.options.now(),
        // Every frame is a complete still. There is no H.264 codec config or
        // delta frame in Tier 1, so the envelope stays keyframe-only.
        keyframe: true,
        codecConfig: false,
        data: bytes,
        ...(mimeType !== undefined && mimeType !== "image/png" ? { mimeType } : {}),
      };
      listener(frame);
      this.options.emit(frame);
    } catch {
      // A transient capture failure must not tear down a subscribed stream, and
      // a bounded number of retries must not become an unbounded one: past the
      // budget the force is dropped and the timer cadence takes over.
      if (
        this.attachmentGeneration === generation &&
        force &&
        this.forceRetries < MAX_FORCE_RETRIES
      ) {
        this.forceRetries += 1;
        this.dedupe.deferForce();
      }
    } finally {
      this.inFlight = false;
      // A forced request that arrived mid-flight is served now rather than
      // waiting for the next timer tick.
      // A replacement attachment can be waiting on this capture slot too.
      if (this.dedupe.forcePending && this.listener) {
        void this.publish();
      }
    }
  }

  /** One tick of the loop: wait out a pause, then publish on the cadence. */
  private tick(): void {
    this.timer = undefined;
    if (!this.listener) return;
    if (this.options.paused?.() === true) {
      this.wasPaused = true;
      this.schedule(PAUSE_POLL_MS);
      return;
    }
    if (this.wasPaused) {
      // The still right after an operation is the one worth having.
      this.wasPaused = false;
      this.unchangedCaptures = 0;
    }
    // The fast cadence by default; once this tick's capture turns out to be
    // one more unchanged still past the threshold, the next tick moves out to
    // the idle interval, measured from this tick.
    const startedAt = this.options.now();
    this.schedule(this.options.intervalMs);
    const timer = this.timer;
    void this.publish().then(() => {
      const idleIntervalMs = this.options.idleIntervalMs;
      const threshold = this.options.idleAfterUnchanged;
      if (this.timer !== timer || idleIntervalMs === undefined || threshold === undefined) return;
      if (this.unchangedCaptures < threshold) return;
      this.schedule(Math.max(0, startedAt + idleIntervalMs - this.options.now()));
    });
  }

  private schedule(delayMs: number): void {
    this.clearTimer();
    this.dueAt = this.options.now() + delayMs;
    this.timer = setTimeout(() => this.tick(), delayMs);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    // One handle type in Node; clearInterval clears either.
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}
