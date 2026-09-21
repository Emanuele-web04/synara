/** a slow client must never hurt anything else: bounded queue + byte budget per subscriber, drops are keyframe-aligned (P-frames referencing a dropped frame decode to garbage), a subscriber behind on bufferedAmount isn't written to; new subscribers primed with cached codec-config + last keyframe */
import { encodeDeviceFrame } from "@synara/shared/deviceFrame";

import type { DeviceStreamFrame } from "./DeviceBackend.ts";

/** frames queued per subscriber before drop-until-keyframe engages */
export const DEVICE_FRAME_QUEUE_LIMIT = 8;
/** socket backlog above which a subscriber is too slow to write to */
export const DEVICE_FRAME_SOCKET_BUDGET_BYTES = 2 * 1024 * 1024;

export interface DeviceFrameSink {
  readonly send: (bytes: Uint8Array) => void;
  /** bytes already queued on the underlying socket, if known */
  readonly bufferedAmount: () => number;
  /** false once the connection is gone; the subscriber is then dropped */
  readonly isOpen: () => boolean;
}

export interface DeviceFrameSubscriberStats {
  readonly sent: number;
  readonly dropped: number;
  readonly awaitingKeyframe: boolean;
  readonly queued: number;
}

interface Subscriber {
  readonly id: string;
  readonly deviceId: string;
  readonly sink: DeviceFrameSink;
  readonly queue: Uint8Array[];
  queuedBytes: number;
  awaitingKeyframe: boolean;
  sent: number;
  dropped: number;
}

export interface DeviceFrameTransportOptions {
  readonly queueLimit?: number;
  readonly socketBudgetBytes?: number;
}

/** routes frames for many devices to many subscribers; one instance per server */
export class DeviceFrameTransport {
  private readonly subscribers = new Map<string, Subscriber>();
  private readonly subscribersByDevice = new Map<string, Set<Subscriber>>();
  private readonly latestKeyframe = new Map<string, Uint8Array>();
  private readonly codecConfig = new Map<string, Uint8Array>();
  private readonly queueLimit: number;
  private readonly socketBudgetBytes: number;
  private nextSubscriberId = 1;

  constructor(options: DeviceFrameTransportOptions = {}) {
    this.queueLimit = options.queueLimit ?? DEVICE_FRAME_QUEUE_LIMIT;
    this.socketBudgetBytes = options.socketBudgetBytes ?? DEVICE_FRAME_SOCKET_BUDGET_BYTES;
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  deviceSubscriberCount(deviceId: string): number {
    return this.subscribersByDevice.get(deviceId)?.size ?? 0;
  }

  /** immediately primed with codec config and the last keyframe when the stream already produced them */
  subscribe(deviceId: string, sink: DeviceFrameSink): () => void {
    const subscriber: Subscriber = {
      id: `device-frame-subscriber:${this.nextSubscriberId++}`,
      deviceId,
      sink,
      queue: [],
      queuedBytes: 0,
      // priming below clears this when a keyframe is available — otherwise the subscriber waits for the encoder's next one
      awaitingKeyframe: true,
      sent: 0,
      dropped: 0,
    };
    this.subscribers.set(subscriber.id, subscriber);
    let deviceSubscribers = this.subscribersByDevice.get(deviceId);
    if (!deviceSubscribers) {
      deviceSubscribers = new Set();
      this.subscribersByDevice.set(deviceId, deviceSubscribers);
    }
    deviceSubscribers.add(subscriber);

    const config = this.codecConfig.get(deviceId);
    if (config) this.deliver(subscriber, config);
    const keyframe = this.latestKeyframe.get(deviceId);
    if (keyframe) {
      subscriber.awaitingKeyframe = false;
      this.deliver(subscriber, keyframe);
    }

    return () => this.removeSubscriber(subscriber);
  }

  /** encode one frame and fan it out to every subscriber of that device */
  publish(deviceId: string, frame: DeviceStreamFrame): void {
    const encoded = encodeDeviceFrame({
      header: {
        deviceId,
        sequence: frame.sequence,
        timestampMs: frame.timestampMs,
        keyframe: frame.keyframe,
        codecConfig: frame.codecConfig,
      },
      payload: frame.data,
    });

    // cached for late subscribers — codec config and keyframes are the only records a decoder needs to start
    if (frame.codecConfig) this.codecConfig.set(deviceId, encoded);
    else if (frame.keyframe) this.latestKeyframe.set(deviceId, encoded);

    const deviceSubscribers = this.subscribersByDevice.get(deviceId);
    if (!deviceSubscribers || deviceSubscribers.size === 0) return;

    // snapshotted — a closed sink is removed from the set during the walk
    for (const subscriber of Array.from(deviceSubscribers)) {
      if (!subscriber.sink.isOpen()) {
        this.removeSubscriber(subscriber);
        continue;
      }
      // codec config is never dropped — without it nothing downstream decodes
      if (frame.codecConfig) {
        this.deliver(subscriber, encoded);
        continue;
      }
      if (subscriber.awaitingKeyframe) {
        if (!frame.keyframe) {
          subscriber.dropped += 1;
          continue;
        }
        subscriber.awaitingKeyframe = false;
      }
      this.deliver(subscriber, encoded);
    }
  }

  /** forget cached keyframes for a device whose stream ended */
  resetDevice(deviceId: string): void {
    this.latestKeyframe.delete(deviceId);
    this.codecConfig.delete(deviceId);
    for (const subscriber of this.subscribersByDevice.get(deviceId) ?? []) {
      subscriber.queue.length = 0;
      subscriber.queuedBytes = 0;
      subscriber.awaitingKeyframe = true;
    }
  }

  statsFor(deviceId: string): readonly DeviceFrameSubscriberStats[] {
    return [...(this.subscribersByDevice.get(deviceId) ?? [])].map((subscriber) => ({
      sent: subscriber.sent,
      dropped: subscriber.dropped,
      awaitingKeyframe: subscriber.awaitingKeyframe,
      queued: subscriber.queue.length,
    }));
  }

  /** write when the socket has room, else queue; a full queue discards the backlog and waits for the next keyframe rather than shipping frames whose references are gone */
  private deliver(subscriber: Subscriber, encoded: Uint8Array): void {
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

    if (subscriber.queue.length >= this.queueLimit) {
      subscriber.dropped += subscriber.queue.length + 1;
      subscriber.queue.length = 0;
      subscriber.queuedBytes = 0;
      subscriber.awaitingKeyframe = true;
      return;
    }
    subscriber.queue.push(encoded);
    subscriber.queuedBytes += encoded.byteLength;
  }

  private flush(subscriber: Subscriber): void {
    if (subscriber.queue.length === 0) return;
    for (const queued of subscriber.queue) {
      subscriber.sink.send(queued);
      subscriber.sent += 1;
    }
    subscriber.queue.length = 0;
    subscriber.queuedBytes = 0;
  }

  private removeSubscriber(subscriber: Subscriber): void {
    this.subscribers.delete(subscriber.id);
    const deviceSubscribers = this.subscribersByDevice.get(subscriber.deviceId);
    deviceSubscribers?.delete(subscriber);
    if (deviceSubscribers && deviceSubscribers.size === 0) {
      this.subscribersByDevice.delete(subscriber.deviceId);
    }
    subscriber.queue.length = 0;
    subscriber.queuedBytes = 0;
  }
}
