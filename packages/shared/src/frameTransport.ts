/**
 * Bounded, keyframe-aware fan-out of encoded frames to WebSocket-shaped sinks.
 *
 * Server-only: it parses client control messages through `Buffer`. The wire
 * codec it fans out lives in `./frameEnvelope`, which the browser also imports.
 */
export interface FrameSink {
  readonly send: (bytes: Uint8Array) => void;
  readonly bufferedAmount: () => number;
  readonly isOpen: () => boolean;
}

export interface FrameSubscriberStats {
  readonly sent: number;
  readonly dropped: number;
  readonly awaitingKeyframe: boolean;
  readonly queued: number;
}

/** How a frame is primed and gated, decided by the stream's own frame type. */
export interface FrameClassification {
  readonly keyframe: boolean;
  readonly codecConfig: boolean;
}

export interface FrameTransportOptions<TStreamId extends string, TFrame> {
  readonly encode: (streamId: TStreamId, frame: TFrame) => Uint8Array;
  /**
   * Keyframe/codec-config classification. Supplied by the owner of `TFrame`
   * rather than sniffed here: duck-typing a generic parameter at runtime reads
   * `undefined` as `false`, so a stream whose frames spell those flags
   * differently silently loses every keyframe gate.
   */
  readonly classify: (frame: TFrame) => FrameClassification;
  readonly queueLimit?: number;
  readonly socketBudgetBytes?: number;
}

interface Subscriber<TStreamId extends string> {
  readonly streamId: TStreamId;
  readonly sink: FrameSink;
  readonly queue: Uint8Array[];
  queuedBytes: number;
  awaitingKeyframe: boolean;
  sent: number;
  dropped: number;
}

/**
 * Bounded, keyframe-aware fan-out for any encoded frame stream.
 *
 * The transport retains only the latest codec-config and keyframe for late
 * subscribers. Slow subscribers drop their backlog and wait for a clean
 * keyframe rather than receiving undecodable delta frames.
 */
export class FrameTransport<TStreamId extends string, TFrame> {
  private readonly subscribersByStream = new Map<string, Set<Subscriber<TStreamId>>>();
  private readonly latestKeyframe = new Map<string, Uint8Array>();
  private readonly codecConfig = new Map<string, Uint8Array>();
  private readonly queueLimit: number;
  private readonly socketBudgetBytes: number;
  private readonly encode: (streamId: TStreamId, frame: TFrame) => Uint8Array;
  private readonly classify: (frame: TFrame) => FrameClassification;

  constructor(options: FrameTransportOptions<TStreamId, TFrame>) {
    this.encode = options.encode;
    this.classify = options.classify;
    this.queueLimit = options.queueLimit ?? 8;
    this.socketBudgetBytes = options.socketBudgetBytes ?? 2 * 1024 * 1024;
    if (!Number.isSafeInteger(this.queueLimit) || this.queueLimit <= 0) {
      throw new RangeError("Frame queue limit must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.socketBudgetBytes) || this.socketBudgetBytes < 0) {
      throw new RangeError("Frame socket budget must be a non-negative safe integer");
    }
  }

  get subscriberCount(): number {
    let total = 0;
    for (const streamSubscribers of this.subscribersByStream.values()) {
      total += streamSubscribers.size;
    }
    return total;
  }

  streamSubscriberCount(streamId: TStreamId): number {
    return this.subscribersByStream.get(streamId)?.size ?? 0;
  }

  subscribe(streamId: TStreamId, sink: FrameSink): () => void {
    const subscriber: Subscriber<TStreamId> = {
      streamId,
      sink,
      queue: [],
      queuedBytes: 0,
      awaitingKeyframe: true,
      sent: 0,
      dropped: 0,
    };
    let streamSubscribers = this.subscribersByStream.get(streamId);
    if (!streamSubscribers) {
      streamSubscribers = new Set();
      this.subscribersByStream.set(streamId, streamSubscribers);
    }
    streamSubscribers.add(subscriber);

    const config = this.codecConfig.get(streamId);
    if (config) this.deliver(subscriber, config, true);
    const keyframe = this.latestKeyframe.get(streamId);
    if (keyframe) {
      subscriber.awaitingKeyframe = false;
      this.deliver(subscriber, keyframe);
    }

    return () => this.removeSubscriber(subscriber);
  }

  publish(streamId: TStreamId, frame: TFrame): void {
    const encoded = this.encode(streamId, frame);
    const { keyframe: isKeyframe, codecConfig: isCodecConfig } = this.classify(frame);

    if (isCodecConfig) {
      this.codecConfig.set(streamId, encoded);
      // The cached keyframe was produced under the previous config and cannot
      // be decoded under this one. Dropping it keeps a subscriber that arrives
      // between this config and the keyframe that follows it from being primed
      // with a mismatched pair it can never render.
      this.latestKeyframe.delete(streamId);
    } else if (isKeyframe) {
      this.latestKeyframe.set(streamId, encoded);
    }

    const streamSubscribers = this.subscribersByStream.get(streamId);
    if (!streamSubscribers || streamSubscribers.size === 0) return;

    // Iterated live: `Set` iteration tolerates removal, and copying the set for
    // every frame of every stream is pure garbage on the hot path.
    for (const subscriber of streamSubscribers) {
      if (!subscriber.sink.isOpen()) {
        this.removeSubscriber(subscriber);
        continue;
      }
      if (isCodecConfig) {
        this.deliver(subscriber, encoded, true);
        continue;
      }
      if (subscriber.awaitingKeyframe) {
        if (!isKeyframe) {
          subscriber.dropped += 1;
          continue;
        }
        subscriber.awaitingKeyframe = false;
      }
      this.deliver(subscriber, encoded);
    }
  }

  /**
   * Restart a stream generation: the cached primer is dropped and every
   * subscriber is parked until the producer's next keyframe.
   *
   * Subscribers stay attached, because the stream is expected to resume.
   */
  reset(streamId: TStreamId): void {
    this.releaseStream(streamId);
  }

  /**
   * The producer stopped. Same release as `reset`, and the stream's own
   * bookkeeping goes with it: nothing else evicts these caches, so a server
   * that cycles through stream ids would otherwise retain one codec config and
   * one keyframe per id it ever saw.
   */
  endStream(streamId: TStreamId): void {
    this.releaseStream(streamId);
    const streamSubscribers = this.subscribersByStream.get(streamId);
    if (streamSubscribers && streamSubscribers.size === 0) {
      this.subscribersByStream.delete(streamId);
    }
  }

  statsFor(streamId: TStreamId): readonly FrameSubscriberStats[] {
    return [...(this.subscribersByStream.get(streamId) ?? [])].map((subscriber) => ({
      sent: subscriber.sent,
      dropped: subscriber.dropped,
      awaitingKeyframe: subscriber.awaitingKeyframe,
      queued: subscriber.queue.length,
    }));
  }

  private releaseStream(streamId: TStreamId): void {
    this.latestKeyframe.delete(streamId);
    this.codecConfig.delete(streamId);
    for (const subscriber of this.subscribersByStream.get(streamId) ?? []) {
      subscriber.queue.length = 0;
      subscriber.queuedBytes = 0;
      subscriber.awaitingKeyframe = true;
    }
  }

  private deliver(
    subscriber: Subscriber<TStreamId>,
    encoded: Uint8Array,
    /**
     * Codec config is never dropped outright (nothing decodes without it), but
     * it does not ride past the caps either: a stalled subscriber keeps exactly
     * one, the latest, in place of whatever backlog preceded it.
     */
    essential = false,
  ): void {
    if (!subscriber.sink.isOpen()) {
      this.removeSubscriber(subscriber);
      return;
    }

    if (subscriber.sink.bufferedAmount() <= this.socketBudgetBytes) {
      this.flush(subscriber);
      subscriber.sink.send(encoded);
      subscriber.sent += 1;
      return;
    }

    if (essential) {
      // A new config makes the queued frames moot: they belong to the old
      // config, and the decoder needs the keyframe that follows the new one.
      // Replacing the backlog also bounds a stall that sees config after
      // config, which would otherwise grow the queue without limit.
      subscriber.dropped += subscriber.queue.length;
      subscriber.queue.length = 0;
      subscriber.queue.push(encoded);
      subscriber.queuedBytes = encoded.byteLength;
      subscriber.awaitingKeyframe = true;
      return;
    }

    // The count cap alone let a backlog of huge keyframes grow unbounded
    // (eight frames x whatever a frame weighs), so the queue is bounded in
    // bytes too: whichever ceiling trips first drops the backlog.
    if (
      subscriber.queue.length >= this.queueLimit ||
      subscriber.queuedBytes + encoded.byteLength > this.socketBudgetBytes
    ) {
      const config = this.codecConfig.get(subscriber.streamId);
      const retainedConfig = config && subscriber.queue.includes(config) ? config : undefined;
      subscriber.dropped += subscriber.queue.length + 1 - (retainedConfig ? 1 : 0);
      subscriber.queue.length = 0;
      if (retainedConfig) subscriber.queue.push(retainedConfig);
      subscriber.queuedBytes = retainedConfig?.byteLength ?? 0;
      subscriber.awaitingKeyframe = true;
      return;
    }
    subscriber.queue.push(encoded);
    subscriber.queuedBytes += encoded.byteLength;
  }

  private flush(subscriber: Subscriber<TStreamId>): void {
    if (subscriber.queue.length === 0) return;
    for (const queued of subscriber.queue) {
      subscriber.sink.send(queued);
      subscriber.sent += 1;
    }
    subscriber.queue.length = 0;
    subscriber.queuedBytes = 0;
  }

  private removeSubscriber(subscriber: Subscriber<TStreamId>): void {
    const streamSubscribers = this.subscribersByStream.get(subscriber.streamId);
    if (!streamSubscribers?.delete(subscriber)) return;
    subscriber.queue.length = 0;
    subscriber.queuedBytes = 0;
    if (streamSubscribers.size > 0) return;
    // Last watcher gone: the retained primer has no one left to prime, and the
    // producer is about to be stopped by the caller that owns it.
    this.subscribersByStream.delete(subscriber.streamId);
    this.latestKeyframe.delete(subscriber.streamId);
    this.codecConfig.delete(subscriber.streamId);
  }
}

export const decodeFrameResyncRequest = (
  message: string | Uint8Array,
  resyncMessage: string,
  maxBytes = 1_024,
): "resync" | null => {
  const text = typeof message === "string" ? message : Buffer.from(message).toString("utf8");
  if (text.length > maxBytes) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { type?: unknown }).type === resyncMessage
      ? "resync"
      : null;
  } catch {
    return null;
  }
};

export const makeFrameSink = (options: {
  readonly send: (bytes: Uint8Array) => Promise<void> | void;
  readonly isOpen: () => boolean;
}): FrameSink => {
  let inFlightBytes = 0;
  return {
    send: (bytes) => {
      inFlightBytes += bytes.byteLength;
      const settle = () => {
        inFlightBytes = Math.max(0, inFlightBytes - bytes.byteLength);
      };
      const result = options.send(bytes);
      if (result instanceof Promise) result.then(settle, settle);
      else settle();
    },
    bufferedAmount: () => inFlightBytes,
    isOpen: options.isOpen,
  };
};
