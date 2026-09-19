import { decodeFrameEnvelope, encodeFrameEnvelope, FrameEncodeError } from "./frameEnvelope";

/**
 * One frame codec per stream family, built from the shared binary envelope.
 *
 * Device frames and computer frames are the same envelope with a different
 * magic and a different name for the stream id (`deviceId` / `computerId`).
 * Each family used to spell out its own encode wrapper, decode wrapper and
 * reason mapping, and the second copy was a rename of the first: this factory
 * is that copy said once, so a third stream family is a handful of constants.
 *
 * @module frameCodec
 */

/** The header fields every envelope carries beside its stream id. */
export interface FrameCodecHeaderFields {
  readonly sequence: number;
  readonly timestampMs: number;
  readonly keyframe: boolean;
  readonly codecConfig: boolean;
}

/** A header whose stream id lives under the family's own key. */
export type FrameCodecHeader<K extends string> = FrameCodecHeaderFields & {
  readonly [P in K]: string;
};

export interface FrameCodecFrame<K extends string> {
  readonly header: FrameCodecHeader<K>;
  readonly payload: Uint8Array;
}

/** The envelope's own reasons, before the family names its stream-id ones. */
export type FrameCodecSharedDecodeReason = "too-short" | "bad-magic" | "unsupported-version";

export type FrameCodecDecodeResult<K extends string, R extends string> =
  | { readonly ok: true; readonly frame: FrameCodecFrame<K> }
  | { readonly ok: false; readonly reason: FrameCodecSharedDecodeReason | R };

export interface FrameCodecSpec<K extends string, R extends string, E extends Error> {
  readonly magic: number;
  readonly version: number;
  /** The header key the stream id travels under: `deviceId`, `computerId`. */
  readonly streamIdKey: K;
  /** Capitalised family name for error text: "Device", "Computer". */
  readonly frameLabel: string;
  readonly maxStreamIdBytes: number;
  /** The family's names for the two stream-id decode failures. */
  readonly decodeReasons: {
    readonly truncatedStreamId: R;
    readonly invalidStreamId: R;
  };
  /** The family's own encode error, so callers keep catching what they always did. */
  readonly encodeError: new (message: string) => E;
}

export interface FrameCodec<K extends string, R extends string> {
  readonly encode: (frame: FrameCodecFrame<K>) => Uint8Array;
  readonly decode: (bytes: Uint8Array) => FrameCodecDecodeResult<K, R>;
}

export function makeFrameCodec<K extends string, R extends string, E extends Error>(
  spec: FrameCodecSpec<K, R, E>,
): FrameCodec<K, R> {
  const config = {
    magic: spec.magic,
    version: spec.version,
    streamIdLabel: spec.streamIdKey,
    frameLabel: spec.frameLabel,
    maxStreamIdBytes: spec.maxStreamIdBytes,
  } as const;
  return {
    encode: (frame) => {
      try {
        return encodeFrameEnvelope(config, {
          header: {
            streamId: frame.header[spec.streamIdKey],
            sequence: frame.header.sequence,
            timestampMs: frame.header.timestampMs,
            keyframe: frame.header.keyframe,
            codecConfig: frame.header.codecConfig,
          },
          payload: frame.payload,
        });
      } catch (error) {
        if (error instanceof FrameEncodeError) throw new spec.encodeError(error.message);
        throw error;
      }
    },
    decode: (bytes) => {
      const result = decodeFrameEnvelope(config, bytes);
      if (!result.ok) {
        return {
          ok: false,
          reason:
            result.reason === "truncated-stream-id"
              ? spec.decodeReasons.truncatedStreamId
              : result.reason === "invalid-stream-id"
                ? spec.decodeReasons.invalidStreamId
                : result.reason,
        };
      }
      const { streamId, ...fields } = result.frame.header;
      return {
        ok: true,
        frame: {
          header: { ...fields, [spec.streamIdKey]: streamId } as FrameCodecHeader<K>,
          payload: result.frame.payload,
        },
      };
    },
  };
}
