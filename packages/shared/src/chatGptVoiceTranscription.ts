// FILE: chatGptVoiceTranscription.ts
// Purpose: Owns the exact ChatGPT voice-upload origin, multipart, and resource policy.
// Layer: Shared Node/Electron provider transport

import { SERVER_VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES } from "@synara/contracts";

import {
  encodeOutboundMultipart,
  outboundHttp,
  type OutboundHttpResponse,
} from "./outboundHttp.ts";

export const CHATGPT_VOICE_TRANSCRIPTION_URL =
  "https://chatgpt.com/backend-api/transcribe";

const MAX_MULTIPART_BYTES = SERVER_VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES + 64 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export function requestChatGptVoiceTranscription(input: {
  readonly audio: Uint8Array;
  readonly mimeType: string;
  readonly token: string;
  readonly transcriptionUrl?: string;
  readonly signal?: AbortSignal;
}): Promise<OutboundHttpResponse> {
  const multipart = encodeOutboundMultipart(
    [
      {
        name: "file",
        filename: "voice.wav",
        contentType: input.mimeType,
        body: input.audio,
      },
    ],
    { maxBytes: MAX_MULTIPART_BYTES },
  );

  return outboundHttp.request({
    policy: {
      service: "chatgpt-voice-transcription",
      allowedOrigins: [new URL(CHATGPT_VOICE_TRANSCRIPTION_URL).origin],
      timeoutMs: 30_000,
      maxRequestBytes: MAX_MULTIPART_BYTES,
      maxResponseBytes: MAX_RESPONSE_BYTES,
      maxRedirects: 0,
      maxConcurrent: 2,
      maxQueued: 4,
      requirePublicAddress: true,
    },
    url: input.transcriptionUrl?.trim() || CHATGPT_VOICE_TRANSCRIPTION_URL,
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.token}`,
      "Content-Type": multipart.contentType,
    },
    body: multipart.body,
    ...(input.signal ? { signal: input.signal } : {}),
  });
}
