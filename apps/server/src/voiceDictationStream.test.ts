// FILE: voiceDictationStream.test.ts
// Purpose: Verifies the live dictation relay against a scripted socket without contacting OpenAI.
// Layer: Server test
// Exports: Vitest cases
// Depends on: voiceDictationStream utility.

import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import type { VoiceDictationHandlers } from "./provider/Services/ProviderAdapter.ts";
import {
  ChatGptDictationStreamError,
  openChatGptDictationStream,
  type CreateDictationSocket,
  type DictationSocket,
} from "./voiceDictationStream";

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  readonly sent: Array<Record<string, unknown>> = [];
  terminated = false;

  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close() {
    this.terminate();
  }

  terminate() {
    this.terminated = true;
    this.readyState = WebSocket.CLOSED;
  }

  open() {
    this.readyState = WebSocket.OPEN;
    this.emit("open");
  }

  receive(event: Record<string, unknown>) {
    this.emit("message", Buffer.from(JSON.stringify(event)), false);
  }

  sentTypes() {
    return this.sent.map((message) => message.type);
  }
}

function makeHandlers() {
  return {
    onTranscript: vi.fn<VoiceDictationHandlers["onTranscript"]>(),
    onCompleted: vi.fn<VoiceDictationHandlers["onCompleted"]>(),
    onFailure: vi.fn<VoiceDictationHandlers["onFailure"]>(),
  };
}

function openWithFakeSocket(handlers = makeHandlers()) {
  const socket = new FakeSocket();
  const createSocket = vi.fn<CreateDictationSocket>(() => socket as unknown as DictationSocket);
  const opened = openChatGptDictationStream({
    token: "test-token",
    sampleRateHz: 24_000,
    handlers,
    createSocket,
  });
  return { socket, createSocket, opened, handlers };
}

async function openStartedSession() {
  const harness = openWithFakeSocket();
  harness.socket.open();
  harness.socket.receive({ type: "session.started", sequence_no: 1, session: {} });
  const session = await harness.opened;
  return { ...harness, session };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("openChatGptDictationStream", () => {
  it("starts a streaming session once the socket opens", async () => {
    const { socket, createSocket, session } = await openStartedSession();

    expect(createSocket).toHaveBeenCalledWith({
      url: "wss://chatgpt.com/backend-api/dictation/stream?dictation_surface=composer",
      token: "test-token",
    });
    expect(socket.sent[0]).toMatchObject({
      type: "session.start",
      config: {
        input_audio_format: "pcm16",
        sample_rate_hz: 24_000,
        num_channels: 1,
        provider_mode: "streaming_sse",
        transcript_delivery_mode: "segment",
      },
    });

    session.appendAudio(Uint8Array.from([1, 0, 2, 0]));
    expect(socket.sent[1]).toEqual({ type: "audio.append", audio: "AQACAA==" });
  });

  it("reports the whole transcript as utterances are revised and finalized", async () => {
    const { socket, session, handlers } = await openStartedSession();

    socket.receive({ type: "transcript.segment", utterance_id: "u1", revision: 1, text: " Hola" });
    socket.receive({
      type: "transcript.segment",
      utterance_id: "u1",
      revision: 2,
      text: " Hola, esto",
    });
    // A stale revision must not roll the text back.
    socket.receive({ type: "transcript.segment", utterance_id: "u1", revision: 1, text: " Hola" });
    socket.receive({
      type: "transcript.final",
      utterance_id: "u1",
      revision: 3,
      text: "Hola, esto.",
    });
    socket.receive({ type: "transcript.segment", utterance_id: "u2", revision: 1, text: " Otra" });

    expect(handlers.onTranscript.mock.calls.map(([text]) => text)).toEqual([
      "Hola",
      "Hola, esto",
      "Hola, esto.",
      "Hola, esto. Otra",
    ]);

    session.finish();
    expect(socket.sentTypes()).toContain("session.close");
    socket.receive({
      type: "transcript.final",
      utterance_id: "u2",
      revision: 2,
      text: "Otra frase.",
    });
    socket.receive({ type: "session.updated", session: { status: "closed" } });

    expect(handlers.onCompleted).toHaveBeenCalledWith("Hola, esto. Otra frase.");
    expect(handlers.onFailure).not.toHaveBeenCalled();
    expect(socket.terminated).toBe(true);
  });

  it("fails when the session closes before every utterance is final", async () => {
    const { socket, session, handlers } = await openStartedSession();

    socket.receive({ type: "transcript.segment", utterance_id: "u1", revision: 1, text: "Hola" });
    session.finish();
    socket.receive({ type: "session.updated", session: { status: "closed" } });

    expect(handlers.onCompleted).not.toHaveBeenCalled();
    expect(handlers.onFailure).toHaveBeenCalledWith(
      expect.objectContaining({ code: "closed" } satisfies Partial<ChatGptDictationStreamError>),
    );
  });

  it("reports provider failures and unexpected disconnects once", async () => {
    const { socket, handlers } = await openStartedSession();

    socket.receive({
      type: "session.error",
      fatal: false,
      error: { code: "slow", message: "Slow down" },
    });
    expect(handlers.onFailure).not.toHaveBeenCalled();

    socket.receive({
      type: "transcript.failed",
      error: { code: "bad_audio", message: "Audio unreadable" },
    });
    socket.emit("close", 1006);

    expect(handlers.onFailure).toHaveBeenCalledTimes(1);
    expect(handlers.onFailure.mock.calls[0]?.[0]).toMatchObject({
      code: "provider",
      message: "Audio unreadable",
    });
  });

  it("rejects the open when ChatGPT refuses the handshake", async () => {
    const challenged = openWithFakeSocket();
    challenged.socket.emit(
      "unexpected-response",
      { destroy: vi.fn() },
      Object.assign(new EventEmitter(), {
        statusCode: 403,
        headers: { "cf-mitigated": "challenge" },
        resume: vi.fn(),
      }) as unknown as IncomingMessage,
    );
    await expect(challenged.opened).rejects.toMatchObject({ code: "blocked" });

    const expired = openWithFakeSocket();
    expired.socket.emit(
      "unexpected-response",
      { destroy: vi.fn() },
      Object.assign(new EventEmitter(), {
        statusCode: 401,
        headers: {},
        resume: vi.fn(),
      }) as unknown as IncomingMessage,
    );
    await expect(expired.opened).rejects.toMatchObject({ code: "auth" });
    expect(expired.handlers.onFailure).not.toHaveBeenCalled();
  });

  it("times out a session that never starts and a finish that never completes", async () => {
    vi.useFakeTimers();
    const pending = openWithFakeSocket();
    pending.socket.open();
    const rejection = expect(pending.opened).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
    expect(pending.socket.terminated).toBe(true);

    const { session, handlers } = await openStartedSession();
    session.finish();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(handlers.onFailure).toHaveBeenCalledWith(
      expect.objectContaining({ code: "timeout" } satisfies Partial<ChatGptDictationStreamError>),
    );
  });

  it("stays silent after close", async () => {
    const { socket, session, handlers } = await openStartedSession();

    session.close();
    socket.receive({ type: "transcript.segment", utterance_id: "u1", revision: 1, text: "Hola" });
    socket.emit("close", 1000);
    session.appendAudio(Uint8Array.from([1, 0]));

    expect(handlers.onTranscript).not.toHaveBeenCalled();
    expect(handlers.onFailure).not.toHaveBeenCalled();
    expect(socket.sentTypes()).toEqual(["session.start"]);
  });
});
