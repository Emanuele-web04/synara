/**
 * Device-specific adapter for the shared bounded frame fan-out transport.
 * Keeping this small wrapper preserves the old device names and API while
 * allowing computer and future display streams to use the same backpressure
 * and keyframe rules.
 */
import { encodeDeviceFrame } from "@synara/shared/deviceFrame";
import {
  FrameTransport,
  type FrameSink,
  type FrameSubscriberStats,
} from "@synara/shared/frameTransport";

import type { DeviceStreamFrame } from "./DeviceBackend.ts";

export const DEVICE_FRAME_QUEUE_LIMIT = 8;
export const DEVICE_FRAME_SOCKET_BUDGET_BYTES = 2 * 1024 * 1024;

export type DeviceFrameSink = FrameSink;
export type DeviceFrameSubscriberStats = FrameSubscriberStats;

export interface DeviceFrameTransportOptions {
  readonly queueLimit?: number;
  readonly socketBudgetBytes?: number;
}

export class DeviceFrameTransport extends FrameTransport<string, DeviceStreamFrame> {
  constructor(options: DeviceFrameTransportOptions = {}) {
    super({
      encode: (deviceId, frame) =>
        encodeDeviceFrame({
          header: {
            deviceId,
            sequence: frame.sequence,
            timestampMs: frame.timestampMs,
            keyframe: frame.keyframe,
            codecConfig: frame.codecConfig,
          },
          payload: frame.data,
        }),
      classify: (frame) => ({ keyframe: frame.keyframe, codecConfig: frame.codecConfig }),
      queueLimit: options.queueLimit ?? DEVICE_FRAME_QUEUE_LIMIT,
      socketBudgetBytes: options.socketBudgetBytes ?? DEVICE_FRAME_SOCKET_BUDGET_BYTES,
    });
  }

  deviceSubscriberCount(deviceId: string): number {
    return this.streamSubscriberCount(deviceId);
  }

  /**
   * The capture session for this device was torn down. Everything retained for
   * it belongs to that session, so it all goes: a later generation brings its
   * own parameter sets and its own IDR.
   */
  resetDevice(deviceId: string): void {
    this.endStream(deviceId);
  }
}
