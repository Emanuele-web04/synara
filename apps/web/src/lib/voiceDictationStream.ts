// FILE: voiceDictationStream.ts
// Purpose: Streams microphone audio to the server's live dictation relay while a voice note records.
// Layer: Client audio utility
// Exports: startVoiceDictationStream, VoiceDictationStream
// Depends on: the native API dictation methods and the PCM16 stream encoder.

import {
  SERVER_VOICE_DICTATION_MAX_CHUNK_BYTES,
  SERVER_VOICE_DICTATION_SAMPLE_RATE_HZ,
  type NativeApi,
  type ServerVoiceDictationStreamInput,
} from "@synara/contracts";

import { createPcm16StreamEncoder, encodeBytesBase64 } from "./voiceRecorderEncoding";

// ~200 ms per request keeps the transcript close to the speaker without
// turning every audio callback into its own RPC.
const MIN_SEND_BYTES = (SERVER_VOICE_DICTATION_SAMPLE_RATE_HZ * 2) / 5;
// Audio held while the session connects or a send is in flight (10 s).
const MAX_PENDING_BYTES = SERVER_VOICE_DICTATION_SAMPLE_RATE_HZ * 2 * 10;
const FINISH_TIMEOUT_MS = 15_000;

type DictationServerApi = Pick<
  NativeApi["server"],
  "streamVoiceDictation" | "appendVoiceDictationAudio" | "finishVoiceDictation"
>;

export interface VoiceDictationStream {
  /** Feeds one microphone chunk. Ignored once the stream failed or is finishing. */
  pushAudio: (samples: Float32Array, sampleRateHz: number) => void;
  /** Sends the remaining audio and resolves with the final transcript; rejects if the stream failed. */
  finish: () => Promise<string>;
  /** Closes the stream without waiting for a transcript. */
  cancel: () => void;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  // Callers may never await a branch (cancel, failure before finish).
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

/**
 * Opens a live dictation stream, or returns null when the connected server
 * cannot stream. Failures never surface here: `finish` rejects instead, so the
 * caller can fall back to the recorded clip.
 */
export function startVoiceDictationStream(input: {
  readonly api: DictationServerApi;
  readonly request: Omit<ServerVoiceDictationStreamInput, "sampleRateHz">;
  readonly onTranscript: (text: string) => void;
}): VoiceDictationStream | null {
  const { api } = input;
  const { streamVoiceDictation, appendVoiceDictationAudio, finishVoiceDictation } = api;
  if (!streamVoiceDictation || !appendVoiceDictationAudio || !finishVoiceDictation) {
    return null;
  }

  const abortController = new AbortController();
  const ready = createDeferred<string>();
  const drained = createDeferred<void>();
  const completed = createDeferred<string>();
  let sessionId: string | null = null;
  let failure: unknown = null;
  let finishing = false;
  let sending = false;
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let encoder: ((chunk: Float32Array) => Uint8Array) | null = null;
  let encoderSampleRateHz = 0;

  const fail = (error: unknown) => {
    if (failure !== null) return;
    failure = error ?? new Error("Live dictation failed.");
    pending = [];
    pendingBytes = 0;
    abortController.abort();
    ready.reject(failure);
    drained.reject(failure);
    completed.reject(failure);
  };

  const takePending = (maxBytes: number): Uint8Array => {
    const size = Math.min(pendingBytes, maxBytes);
    const bytes = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
      const head = pending[0];
      if (!head) break;
      const take = Math.min(head.byteLength, size - offset);
      bytes.set(head.subarray(0, take), offset);
      offset += take;
      if (take === head.byteLength) pending.shift();
      else pending[0] = head.subarray(take);
    }
    pendingBytes -= size;
    return bytes;
  };

  // One append in flight at a time keeps chunks in order on the server.
  const pump = () => {
    if (failure !== null || sending || sessionId === null) return;
    if (pendingBytes === 0 || (!finishing && pendingBytes < MIN_SEND_BYTES)) {
      if (finishing && pendingBytes === 0) drained.resolve();
      return;
    }
    // Whole samples only: an odd split would misalign every later chunk.
    const bytes = takePending(SERVER_VOICE_DICTATION_MAX_CHUNK_BYTES);
    sending = true;
    appendVoiceDictationAudio({ sessionId, audioBase64: encodeBytesBase64(bytes) }).then(() => {
      sending = false;
      pump();
    }, fail);
  };

  void streamVoiceDictation(
    { ...input.request, sampleRateHz: SERVER_VOICE_DICTATION_SAMPLE_RATE_HZ },
    {
      signal: abortController.signal,
      onEvent: (event) => {
        if (failure !== null) return;
        switch (event.type) {
          case "ready":
            sessionId = event.sessionId;
            ready.resolve(event.sessionId);
            pump();
            return;
          case "transcript":
            input.onTranscript(event.text);
            return;
          case "completed":
            completed.resolve(event.text);
            return;
        }
      },
    },
  ).then(() => fail(new Error("The dictation stream ended without a final transcript.")), fail);

  return {
    pushAudio: (samples, sampleRateHz) => {
      if (failure !== null || finishing) return;
      if (!encoder || encoderSampleRateHz !== sampleRateHz) {
        encoder = createPcm16StreamEncoder(sampleRateHz, SERVER_VOICE_DICTATION_SAMPLE_RATE_HZ);
        encoderSampleRateHz = sampleRateHz;
      }
      const bytes = encoder(samples);
      if (bytes.byteLength === 0) return;
      pending.push(bytes);
      pendingBytes += bytes.byteLength;
      if (pendingBytes > MAX_PENDING_BYTES) {
        fail(new Error("Live dictation fell too far behind the recording."));
        return;
      }
      pump();
    },
    finish: async () => {
      finishing = true;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const timedOut = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error("Timed out waiting for the live dictation transcript."));
        }, FINISH_TIMEOUT_MS);
      });
      try {
        const readySessionId = await Promise.race([ready.promise, timedOut]);
        pump();
        await Promise.race([drained.promise, timedOut]);
        await Promise.race([finishVoiceDictation({ sessionId: readySessionId }), timedOut]);
        return await Promise.race([completed.promise, timedOut]);
      } catch (error) {
        fail(error);
        throw error;
      } finally {
        if (timeout !== null) clearTimeout(timeout);
        abortController.abort();
      }
    },
    cancel: () => {
      fail(new DOMException("Live dictation was cancelled.", "AbortError"));
    },
  };
}
