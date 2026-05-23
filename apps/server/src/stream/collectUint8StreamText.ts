import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

export interface CollectedUint8StreamText {
  readonly text: string;
  readonly truncated: boolean;
}

interface CollectState {
  readonly chunks: Uint8Array[];
  readonly byteLength: number;
  readonly truncated: boolean;
}

export function collectUint8StreamText<E>(input: {
  readonly stream: Stream.Stream<Uint8Array, E>;
  readonly maxBytes?: number;
}): Effect.Effect<CollectedUint8StreamText, E> {
  const maxBytes = input.maxBytes ?? Number.POSITIVE_INFINITY;
  return Stream.runFold(
    input.stream,
    (): CollectState => ({ chunks: [], byteLength: 0, truncated: false }),
    (state, chunk) => {
      if (state.truncated) {
        return state;
      }

      const remaining = maxBytes - state.byteLength;
      if (remaining <= 0) {
        return { ...state, truncated: true };
      }

      const nextChunk = chunk.byteLength <= remaining ? chunk : chunk.slice(0, remaining);
      state.chunks.push(nextChunk);
      return {
        chunks: state.chunks,
        byteLength: state.byteLength + nextChunk.byteLength,
        truncated: chunk.byteLength > remaining,
      };
    },
  ).pipe(
    Effect.map((state) => ({
      text: Buffer.concat(state.chunks, state.byteLength).toString("utf8"),
      truncated: state.truncated,
    })),
  );
}
