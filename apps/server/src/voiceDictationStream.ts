// FILE: voiceDictationStream.ts
// Purpose: Relays live dictation audio to ChatGPT's streaming transcription socket.
// Layer: Server utility
// Exports: openChatGptDictationStream, ChatGptDictationStreamError
// Depends on: ws, ChatGPT session auth supplied by Codex app-server callers.

import { randomUUID } from "node:crypto";
import * as Dns from "node:dns";
import type { IncomingMessage } from "node:http";

import { assertPublicIpAddress } from "@synara/shared/outboundHttpPolicy";
import {
  CHATGPT_DICTATION_STREAM_URL,
  CHATGPT_DICTATION_STREAM_USER_AGENT,
} from "@synara/shared/chatGptVoiceTranscription";
import WebSocket from "ws";

import type {
  VoiceDictationHandlers,
  VoiceDictationSession,
} from "./provider/Services/ProviderAdapter.ts";

const DICTATION_SUBPROTOCOL = "chatgpt-dictation";
const CONNECT_TIMEOUT_MS = 10_000;
const FINISH_TIMEOUT_MS = 10_000;
const MAX_MESSAGE_BYTES = 1024 * 1024;
// The provider expires sessions after five minutes; stop accepting audio there too.
const SESSION_TTL_MS = 300_000;

export type ChatGptDictationStreamErrorCode =
  | "auth"
  | "blocked"
  | "unavailable"
  | "timeout"
  | "closed"
  | "provider"
  | "protocol";

export class ChatGptDictationStreamError extends Error {
  override readonly name = "ChatGptDictationStreamError";

  constructor(
    message: string,
    readonly code: ChatGptDictationStreamErrorCode,
  ) {
    super(message);
  }
}

/** The subset of `ws` the relay uses, so tests can drive a fake socket. */
export interface DictationSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number): void;
  terminate(): void;
  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: WebSocket.RawData, isBinary: boolean) => void): this;
  on(event: "close", listener: (code: number) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(
    event: "unexpected-response",
    listener: (request: { destroy(): void }, response: IncomingMessage) => void,
  ): this;
}

export type CreateDictationSocket = (input: {
  readonly url: string;
  readonly token: string;
}) => DictationSocket;

interface UtteranceText {
  partial: { readonly revision: number; readonly text: string } | null;
  final: { readonly revision: number; readonly text: string } | null;
}

// Resolves the provider host like the outbound HTTP policy does: only public
// addresses, so a poisoned resolver cannot point the relay at the local network.
function publicAddressLookup(
  hostname: string,
  options: Dns.LookupOptions,
  callback: (
    error: NodeJS.ErrnoException | null,
    address: string | Dns.LookupAddress[],
    family?: number,
  ) => void,
): void {
  Dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) {
      callback(error, []);
      return;
    }
    try {
      if (addresses.length === 0) throw new Error("DNS lookup returned no addresses.");
      for (const result of addresses) assertPublicIpAddress(result.address);
    } catch (cause) {
      callback(cause as NodeJS.ErrnoException, []);
      return;
    }
    if (options.all) {
      callback(null, addresses);
      return;
    }
    const [first] = addresses;
    callback(null, first?.address ?? "", first?.family);
  });
}

const createChatGptDictationSocket: CreateDictationSocket = ({ url, token }) =>
  new WebSocket(url, [DICTATION_SUBPROTOCOL], {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": CHATGPT_DICTATION_STREAM_USER_AGENT,
    },
    followRedirects: false,
    handshakeTimeout: CONNECT_TIMEOUT_MS,
    maxPayload: MAX_MESSAGE_BYTES,
    lookup: publicAddressLookup,
  });

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function readProviderErrorMessage(value: unknown, fallback: string): string {
  return readString(readRecord(value)?.message)?.trim() || fallback;
}

function handshakeError(response: IncomingMessage): ChatGptDictationStreamError {
  const status = response.statusCode ?? 0;
  if (response.headers["cf-mitigated"]) {
    return new ChatGptDictationStreamError("ChatGPT blocked the dictation connection.", "blocked");
  }
  if (status === 401 || status === 403) {
    return new ChatGptDictationStreamError(
      "Your ChatGPT login has expired. Sign in again.",
      "auth",
    );
  }
  return new ChatGptDictationStreamError(
    `ChatGPT dictation is unavailable (status ${status}).`,
    "unavailable",
  );
}

/**
 * Opens one ChatGPT dictation session and resolves once the provider accepted
 * it. Transcript updates, the final text, or a failure then reach `handlers`.
 */
export function openChatGptDictationStream(input: {
  readonly token: string;
  readonly sampleRateHz: number;
  readonly handlers: VoiceDictationHandlers;
  readonly createSocket?: CreateDictationSocket;
}): Promise<VoiceDictationSession> {
  const { handlers } = input;
  const createSocket = input.createSocket ?? createChatGptDictationSocket;
  const url = new URL(CHATGPT_DICTATION_STREAM_URL);
  url.searchParams.set("dictation_surface", "composer");

  return new Promise<VoiceDictationSession>((resolve, reject) => {
    const utterances = new Map<string, UtteranceText>();
    let phase: "connecting" | "streaming" | "finishing" | "done" = "connecting";
    let finishTimer: ReturnType<typeof setTimeout> | null = null;
    let sessionTimer: ReturnType<typeof setTimeout> | null = null;
    let lastTranscript = "";
    const connectTimer = setTimeout(() => {
      fail(
        new ChatGptDictationStreamError("Timed out connecting to ChatGPT dictation.", "timeout"),
      );
    }, CONNECT_TIMEOUT_MS);

    let socket: DictationSocket;
    try {
      socket = createSocket({ url: url.toString(), token: input.token });
    } catch (cause) {
      clearTimeout(connectTimer);
      phase = "done";
      reject(cause);
      return;
    }

    const clearTimers = () => {
      clearTimeout(connectTimer);
      if (finishTimer) clearTimeout(finishTimer);
      if (sessionTimer) clearTimeout(sessionTimer);
      finishTimer = null;
      sessionTimer = null;
    };

    const shutdown = () => {
      phase = "done";
      clearTimers();
      try {
        socket.terminate();
      } catch {
        // The socket may already be gone; there is nothing left to release.
      }
    };

    // Before the session starts every failure rejects the open; afterwards it
    // reaches the handler exactly once.
    const fail = (error: ChatGptDictationStreamError) => {
      if (phase === "done") return;
      const wasConnecting = phase === "connecting";
      shutdown();
      if (wasConnecting) reject(error);
      else handlers.onFailure(error);
    };

    const transcriptText = (includePartial: boolean) =>
      Array.from(utterances.values(), (utterance) =>
        (utterance.final?.text ?? (includePartial ? utterance.partial?.text : null) ?? "").trim(),
      )
        .filter((text) => text.length > 0)
        .join(" ");

    const recordTranscript = (event: Record<string, unknown>, isFinal: boolean) => {
      const utteranceId = readString(event.utterance_id);
      const text = readString(event.text);
      if (!utteranceId || text === null) return;
      const revision = readNumber(event.revision);
      let utterance = utterances.get(utteranceId);
      if (!utterance) {
        utterance = { partial: null, final: null };
        utterances.set(utteranceId, utterance);
      }
      if (isFinal) {
        if (revision >= (utterance.final?.revision ?? 0)) {
          utterance.final = { revision, text };
          utterance.partial = null;
        }
      } else if (utterance.final === null && revision >= (utterance.partial?.revision ?? 0)) {
        utterance.partial = { revision, text };
      }
      const nextTranscript = transcriptText(true);
      if (nextTranscript !== lastTranscript && phase !== "done") {
        lastTranscript = nextTranscript;
        handlers.onTranscript(nextTranscript);
      }
    };

    const completeSession = () => {
      if (phase !== "finishing") {
        fail(new ChatGptDictationStreamError("ChatGPT ended the dictation session.", "closed"));
        return;
      }
      for (const utterance of utterances.values()) {
        if (utterance.final === null) {
          fail(
            new ChatGptDictationStreamError(
              "The dictation session closed before all speech was finalized.",
              "closed",
            ),
          );
          return;
        }
      }
      const text = transcriptText(false);
      shutdown();
      handlers.onCompleted(text);
    };

    const send = (message: Record<string, unknown>) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify(message));
    };

    const session: VoiceDictationSession = {
      appendAudio: (pcm16) => {
        if (phase !== "streaming" || pcm16.byteLength === 0) return;
        send({ type: "audio.append", audio: Buffer.from(pcm16).toString("base64") });
      },
      finish: () => {
        if (phase !== "streaming") return;
        phase = "finishing";
        finishTimer = setTimeout(() => {
          fail(
            new ChatGptDictationStreamError(
              "Timed out waiting for the final dictation transcript.",
              "timeout",
            ),
          );
        }, FINISH_TIMEOUT_MS);
        send({ type: "session.close" });
      },
      close: () => {
        if (phase === "done") return;
        shutdown();
      },
    };

    socket.on("unexpected-response", (request, response) => {
      response.resume();
      request.destroy();
      fail(handshakeError(response));
    });

    socket.on("open", () => {
      if (phase !== "connecting") return;
      send({
        type: "session.start",
        dictation_session_id: randomUUID(),
        attempt_id: randomUUID(),
        config: {
          input_audio_format: "pcm16",
          sample_rate_hz: input.sampleRateHz,
          num_channels: 1,
          max_buffer_size_bytes: 4_194_304,
          max_utterance_duration_ms: 30_000,
          session_ttl_ms: SESSION_TTL_MS,
          provider_mode: "streaming_sse",
          transcript_delivery_mode: "segment",
          vad: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500,
          },
        },
      });
    });

    socket.on("message", (data, isBinary) => {
      if (phase === "done") return;
      if (isBinary) {
        fail(
          new ChatGptDictationStreamError("ChatGPT sent an unexpected binary frame.", "protocol"),
        );
        return;
      }
      let event: Record<string, unknown> | null;
      try {
        event = readRecord(JSON.parse(String(data)));
      } catch {
        event = null;
      }
      const type = readString(event?.type);
      if (!event || !type) {
        fail(
          new ChatGptDictationStreamError("ChatGPT sent an invalid dictation event.", "protocol"),
        );
        return;
      }
      switch (type) {
        case "session.started":
          if (phase !== "connecting") return;
          phase = "streaming";
          clearTimeout(connectTimer);
          sessionTimer = setTimeout(() => {
            fail(new ChatGptDictationStreamError("The dictation session expired.", "timeout"));
          }, SESSION_TTL_MS);
          resolve(session);
          return;
        case "transcript.segment":
          recordTranscript(event, false);
          return;
        case "transcript.final":
          recordTranscript(event, true);
          return;
        case "session.updated":
          if (readString(readRecord(event.session)?.status) === "closed") completeSession();
          return;
        case "transcript.failed":
          fail(
            new ChatGptDictationStreamError(
              readProviderErrorMessage(event.error, "ChatGPT could not transcribe the dictation."),
              "provider",
            ),
          );
          return;
        case "session.error":
          if (event.fatal === true) {
            fail(
              new ChatGptDictationStreamError(
                readProviderErrorMessage(event.error, "ChatGPT dictation failed."),
                "provider",
              ),
            );
          }
          return;
        default:
          // Speech markers, frame acknowledgements, and recording assets are not needed here.
          return;
      }
    });

    socket.on("error", () => {
      fail(new ChatGptDictationStreamError("The ChatGPT dictation connection failed.", "closed"));
    });

    socket.on("close", (code) => {
      fail(
        new ChatGptDictationStreamError(
          `The ChatGPT dictation connection closed unexpectedly (code ${code}).`,
          "closed",
        ),
      );
    });
  });
}
