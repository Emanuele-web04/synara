// FILE: voiceTranscription.ts
// Purpose: Validates Remodex-style WAV payloads and proxies them to ChatGPT transcription.
// Layer: Server utility
// Exports: transcribeVoiceWithChatGptSession
// Depends on: ChatGPT session auth supplied by Codex app-server callers.

import { Buffer } from "node:buffer";

import type {
  ServerVoiceTranscriptionInput,
  ServerVoiceTranscriptionResult,
} from "@t3tools/contracts";

const CHATGPT_TRANSCRIPTIONS_URL = "https://chatgpt.com/backend-api/transcribe";
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_DURATION_MS = 120_000;

export interface ChatGptVoiceAuthContext {
  readonly token: string;
  readonly transcriptionUrl?: string;
}

// Validate the captured WAV clip and retry once if the ChatGPT session needs a refresh.
export async function transcribeVoiceWithChatGptSession(input: {
  readonly request: ServerVoiceTranscriptionInput;
  readonly resolveAuth: (refreshToken: boolean) => Promise<ChatGptVoiceAuthContext>;
  readonly fetchImpl?: typeof fetch;
}): Promise<ServerVoiceTranscriptionResult> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("Voice transcription is unavailable in this runtime.");
  }

  const audioBuffer = decodeVoiceAudio(input.request);
  let auth = await input.resolveAuth(false);
  let response = await requestTranscription({
    fetchImpl,
    audioBuffer,
    mimeType: input.request.mimeType,
    token: auth.token,
    ...(auth.transcriptionUrl ? { transcriptionUrl: auth.transcriptionUrl } : {}),
  });

  if (response.status === 401 || response.status === 403) {
    auth = await input.resolveAuth(true);
    response = await requestTranscription({
      fetchImpl,
      audioBuffer,
      mimeType: input.request.mimeType,
      token: auth.token,
      ...(auth.transcriptionUrl ? { transcriptionUrl: auth.transcriptionUrl } : {}),
    });
  }

  if (!response.ok) {
    throw new Error(await readTranscriptionErrorMessage(response));
  }

  const payload = (await response.json().catch(() => null)) as {
    text?: unknown;
    transcript?: unknown;
  } | null;
  const text = readString(payload?.text) ?? readString(payload?.transcript);
  if (!text) {
    throw new Error("The transcription response did not include any text.");
  }

  return { text };
}

// Keep the server-side contract strict so the private backend only sees normalized clips.
function decodeVoiceAudio(input: ServerVoiceTranscriptionInput): Buffer {
  if (input.mimeType !== "audio/wav") {
    throw new Error("Only WAV audio is supported for voice transcription.");
  }
  if (input.sampleRateHz !== 24_000) {
    throw new Error("Voice transcription requires 24 kHz mono WAV audio.");
  }
  if (input.durationMs <= 0) {
    throw new Error("Voice messages must include a positive duration.");
  }
  if (input.durationMs > MAX_DURATION_MS) {
    throw new Error("Voice messages are limited to 120 seconds.");
  }

  const normalizedBase64 = normalizeBase64(input.audioBase64);
  if (!normalizedBase64 || !isLikelyBase64(normalizedBase64)) {
    throw new Error("The recorded audio could not be decoded.");
  }

  const audioBuffer = Buffer.from(normalizedBase64, "base64");
  if (!audioBuffer.length || audioBuffer.toString("base64") !== normalizedBase64) {
    throw new Error("The recorded audio could not be decoded.");
  }
  if (audioBuffer.length > MAX_AUDIO_BYTES) {
    throw new Error("Voice messages are limited to 10 MB.");
  }
  if (!isLikelyWavBuffer(audioBuffer)) {
    throw new Error("The recorded audio is not a valid WAV file.");
  }

  return audioBuffer;
}

async function requestTranscription(input: {
  readonly fetchImpl: typeof fetch;
  readonly audioBuffer: Buffer;
  readonly mimeType: string;
  readonly token: string;
  readonly transcriptionUrl?: string;
}): Promise<Response> {
  const formData = new FormData();
  formData.append("file", new Blob([input.audioBuffer], { type: input.mimeType }), "voice.wav");

  return input.fetchImpl(input.transcriptionUrl ?? CHATGPT_TRANSCRIPTIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.token}`,
    },
    body: formData,
  });
}

async function readTranscriptionErrorMessage(response: Response): Promise<string> {
  let errorMessage = `Transcription failed with status ${response.status}.`;
  try {
    const payload = (await response.json()) as {
      error?: { message?: unknown };
      message?: unknown;
    } | null;
    const providerMessage =
      readString(payload?.error?.message) ?? readString(payload?.message) ?? null;
    if (providerMessage) {
      errorMessage = providerMessage;
    }
  } catch {
    // Keep the generic status-based message when the provider body is empty or invalid.
  }

  if (response.status === 401 || response.status === 403) {
    return "Your ChatGPT login has expired. Sign in again.";
  }

  return errorMessage;
}

function normalizeBase64(value: string): string | null {
  const normalized = value.trim().replace(/\s+/g, "");
  return normalized.length > 0 ? normalized : null;
}

function isLikelyBase64(value: string): boolean {
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function isLikelyWavBuffer(buffer: Buffer): boolean {
  return (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WAVE"
  );
}

function readString(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length > 0 ? normalized : null;
}
