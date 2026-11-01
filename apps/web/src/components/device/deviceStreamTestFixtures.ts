// Shared device-stream regression fixtures.
//
// Frame cadence recorded from the real device helper (Synara 1.0.3, iOS 26.5
// simulator, animated page, 20 s at ~60 fps, 1216 records with contiguous
// sequences). The helper sends a codec-config record immediately before every
// keyframe (17 of 17), forces a keyframe about every 2 s while the screen
// changes, and the encoder's own MaxKeyFrameInterval=120 often lands on the
// same boundary, so config+keyframe pairs frequently arrive twice ~20 ms apart.

/** Sequences of the codec-config records; each is followed by a keyframe at `sequence + 1`. */
export const RECORDED_DEVICE_CODEC_CONFIG_SEQUENCES = [
  1, 121, 123, 244, 246, 367, 488, 490, 611, 613, 733, 736, 857, 977, 980, 1100, 1102,
] as const;

export const RECORDED_DEVICE_LAST_SEQUENCE = 1216;

export interface RecordedDeviceFrameShape {
  readonly sequence: number;
  readonly keyframe: boolean;
  readonly codecConfig: boolean;
}

/** The recorded stream as `[config, key, delta×~118, config, key, config, key, delta…]`. */
export function recordedDeviceStreamShape(): RecordedDeviceFrameShape[] {
  const configs = new Set<number>(RECORDED_DEVICE_CODEC_CONFIG_SEQUENCES);
  const frames: RecordedDeviceFrameShape[] = [];
  for (let sequence = 1; sequence <= RECORDED_DEVICE_LAST_SEQUENCE; sequence += 1) {
    frames.push({
      sequence,
      codecConfig: configs.has(sequence),
      keyframe: configs.has(sequence - 1),
    });
  }
  return frames;
}
