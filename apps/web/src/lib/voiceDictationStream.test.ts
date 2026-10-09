import type {
  ServerVoiceDictationAudioInput,
  ServerVoiceDictationEvent,
  ServerVoiceDictationFinishInput,
  ServerVoiceDictationStreamInput,
} from "@synara/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startVoiceDictationStream } from "./voiceDictationStream";

// 100 ms of audio at 24 kHz; two of them reach the ~200 ms send threshold.
const CHUNK = new Float32Array(2_400).fill(0.25);

function makeServer() {
  let emit: (event: ServerVoiceDictationEvent) => void = () => undefined;
  let endStream: () => void = () => undefined;
  let failStream: (error: unknown) => void = () => undefined;
  let streamSignal: AbortSignal | null = null;
  const appended: ServerVoiceDictationAudioInput[] = [];
  let releaseAppend: (() => void) | null = null;
  let holdAppends = false;

  const api = {
    streamVoiceDictation: vi.fn(
      (
        _input: ServerVoiceDictationStreamInput,
        options: { onEvent: (event: ServerVoiceDictationEvent) => void; signal: AbortSignal },
      ) =>
        new Promise<void>((resolve, reject) => {
          emit = options.onEvent;
          endStream = resolve;
          failStream = reject;
          streamSignal = options.signal;
          options.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    ),
    appendVoiceDictationAudio: vi.fn((input: ServerVoiceDictationAudioInput) => {
      appended.push(input);
      if (!holdAppends) return Promise.resolve();
      return new Promise<void>((resolve) => {
        releaseAppend = resolve;
      });
    }),
    finishVoiceDictation: vi.fn((_input: ServerVoiceDictationFinishInput) => Promise.resolve()),
  };

  return {
    api,
    appended,
    emit: (event: ServerVoiceDictationEvent) => emit(event),
    endStream: () => endStream(),
    failStream: (error: unknown) => failStream(error),
    signal: () => streamSignal,
    holdAppends: () => {
      holdAppends = true;
    },
    releaseAppend: () => {
      holdAppends = false;
      releaseAppend?.();
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const REQUEST = { provider: "codex" as const, cwd: "/workspace/project" };

afterEach(() => {
  vi.useRealTimers();
});

describe("startVoiceDictationStream", () => {
  it("returns null when the server cannot stream dictation", () => {
    expect(
      startVoiceDictationStream({ api: {}, request: REQUEST, onTranscript: vi.fn() }),
    ).toBeNull();
  });

  it("buffers audio until the session is ready, then sends it in order", async () => {
    const server = makeServer();
    const stream = startVoiceDictationStream({
      api: server.api,
      request: REQUEST,
      onTranscript: vi.fn(),
    });

    stream?.pushAudio(CHUNK, 24_000);
    stream?.pushAudio(CHUNK, 24_000);
    expect(server.api.streamVoiceDictation).toHaveBeenCalledWith(
      { ...REQUEST, sampleRateHz: 24_000 },
      expect.anything(),
    );
    expect(server.appended).toHaveLength(0);

    server.emit({ type: "ready", sessionId: "session-1" });
    await flush();

    expect(server.appended).toHaveLength(1);
    expect(server.appended[0]?.sessionId).toBe("session-1");
    // 4 800 samples × 2 bytes, base64-encoded.
    expect(atob(server.appended[0]?.audioBase64 ?? "")).toHaveLength(9_600);
  });

  it("keeps one append in flight and batches audio that arrives meanwhile", async () => {
    const server = makeServer();
    const stream = startVoiceDictationStream({
      api: server.api,
      request: REQUEST,
      onTranscript: vi.fn(),
    });
    server.emit({ type: "ready", sessionId: "session-1" });
    server.holdAppends();

    stream?.pushAudio(CHUNK, 24_000);
    stream?.pushAudio(CHUNK, 24_000);
    stream?.pushAudio(CHUNK, 24_000);
    stream?.pushAudio(CHUNK, 24_000);
    expect(server.appended).toHaveLength(1);

    server.releaseAppend();
    await flush();
    expect(server.appended).toHaveLength(2);
    expect(atob(server.appended[1]?.audioBase64 ?? "")).toHaveLength(9_600);
  });

  it("forwards live transcripts and resolves finish with the final text", async () => {
    const server = makeServer();
    const onTranscript = vi.fn();
    const stream = startVoiceDictationStream({ api: server.api, request: REQUEST, onTranscript });
    server.emit({ type: "ready", sessionId: "session-1" });
    stream?.pushAudio(CHUNK, 24_000);
    server.emit({ type: "transcript", text: "Hola" });

    const finished = stream?.finish();
    await flush();
    // The short tail below the batching threshold is flushed before finishing.
    expect(server.appended).toHaveLength(1);
    expect(server.api.finishVoiceDictation).toHaveBeenCalledWith({ sessionId: "session-1" });

    server.emit({ type: "completed", text: "Hola, mundo." });
    server.endStream();

    await expect(finished).resolves.toBe("Hola, mundo.");
    expect(onTranscript).toHaveBeenCalledWith("Hola");
  });

  it("rejects finish when the stream fails, so the caller can upload the clip", async () => {
    const server = makeServer();
    const stream = startVoiceDictationStream({
      api: server.api,
      request: REQUEST,
      onTranscript: vi.fn(),
    });
    server.emit({ type: "ready", sessionId: "session-1" });
    server.failStream(new Error("socket closed"));
    await flush();

    stream?.pushAudio(CHUNK, 24_000);
    await expect(stream?.finish()).rejects.toThrow("socket closed");
    expect(server.appended).toHaveLength(0);
  });

  it("times out when the session never becomes ready", async () => {
    vi.useFakeTimers();
    const server = makeServer();
    const stream = startVoiceDictationStream({
      api: server.api,
      request: REQUEST,
      onTranscript: vi.fn(),
    });

    const finished = expect(stream?.finish()).rejects.toThrow("Timed out");
    await vi.advanceTimersByTimeAsync(15_000);
    await finished;
    expect(server.signal()?.aborted).toBe(true);
  });

  it("aborts the server stream on cancel", () => {
    const server = makeServer();
    const stream = startVoiceDictationStream({
      api: server.api,
      request: REQUEST,
      onTranscript: vi.fn(),
    });

    stream?.cancel();

    expect(server.signal()?.aborted).toBe(true);
  });
});
