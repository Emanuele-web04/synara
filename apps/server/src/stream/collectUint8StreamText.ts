import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

export interface CollectedUint8StreamText {
  readonly text: string;
  readonly truncated: boolean;
}

export function collectUint8StreamText<E>(input: {
  readonly stream: Stream.Stream<Uint8Array, E>;
  readonly maxBytes?: number;
}): Effect.Effect<CollectedUint8StreamText, E> {
  const maxBytes = input.maxBytes ?? Number.POSITIVE_INFINITY;
  const decoder = new TextDecoder();
  return Stream.runFold(
    input.stream,
    () => ({ chunks: [] as Uint8Array[], byteLength: 0, truncated: false }),
    (state, chunk) => {
      if (state.truncated || state.byteLength >= maxBytes) {
        return { ...state, truncated: true };
      }
      const remaining = maxBytes - state.byteLength;
      const nextChunk = chunk.byteLength <= remaining ? chunk : chunk.slice(0, remaining);
      return {
        chunks: [...state.chunks, nextChunk],
        byteLength: state.byteLength + nextChunk.byteLength,
        truncated: chunk.byteLength > remaining,
      };
    },
  ).pipe(
    Effect.map((state) => ({
      text:
        state.chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join("") +
        decoder.decode(),
      truncated: state.truncated,
    })),
  );
}
