// FILE: voiceTranscription.ts
// Purpose: Owns the desktop-specific voice transcription flow for Electron builds.
// Layer: Desktop IPC + ChatGPT upload bridge
// Depends on: Codex auth discovery, Electron net uploads, and the shared server voice contract.

import * as ChildProcess from "node:child_process";

import { app, ipcMain } from "electron";
import type {
  ServerVoiceTranscriptionInput,
  ServerVoiceTranscriptionResult,
} from "@synara/contracts";
import { SERVER_VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES } from "@synara/contracts";
import {
  CHATGPT_VOICE_TRANSCRIPTION_URL,
  requestChatGptVoiceTranscription,
} from "@synara/shared/chatGptVoiceTranscription";
import {
  decodeOutboundJson,
  decodeOutboundText,
  type OutboundHttpResponse,
} from "@synara/shared/outboundHttp";
import { prepareWindowsSafeProcess } from "@synara/shared/windowsProcess";
import { SERVER_TRANSCRIBE_VOICE_CHANNEL } from "./ipcChannels";
import { transcribeViaWhisper } from "./whisperTranscription";

const MAX_VOICE_DURATION_MS = 120_000;

// --- Input validation ------------------------------------------------------

function normalizeVoiceBase64(value: string): string | null {
  const normalized = value.trim().replace(/\s+/g, "");
  return normalized.length > 0 ? normalized : null;
}

function isLikelyVoiceBase64(value: string): boolean {
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function isValidVoiceWavBuffer(buffer: Buffer): boolean {
  return (
    buffer.length >= 44 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.readUInt32LE(4) === buffer.length - 8 &&
    buffer.toString("ascii", 8, 12) === "WAVE" &&
    buffer.toString("ascii", 12, 16) === "fmt " &&
    buffer.readUInt32LE(16) === 16 &&
    buffer.readUInt16LE(20) === 1 &&
    buffer.readUInt16LE(22) === 1 &&
    buffer.readUInt32LE(24) === 24_000 &&
    buffer.readUInt32LE(28) === 48_000 &&
    buffer.readUInt16LE(32) === 2 &&
    buffer.readUInt16LE(34) === 16 &&
    buffer.toString("ascii", 36, 40) === "data" &&
    buffer.readUInt32LE(40) === buffer.length - 44 &&
    (buffer.length - 44) % 2 === 0
  );
}

export function decodeDesktopVoiceAudio(input: ServerVoiceTranscriptionInput): Buffer {
  if (input.mimeType !== "audio/wav") {
    throw new Error("Only WAV audio is supported for voice transcription.");
  }
  if (input.sampleRateHz !== 24_000) {
    throw new Error("Voice transcription requires 24 kHz mono WAV audio.");
  }
  if (input.durationMs <= 0) {
    throw new Error("Voice messages must include a positive duration.");
  }
  if (input.durationMs > MAX_VOICE_DURATION_MS) {
    throw new Error("Voice messages are limited to 120 seconds.");
  }

  const normalizedBase64 = normalizeVoiceBase64(input.audioBase64);
  if (
    !normalizedBase64 ||
    !isLikelyVoiceBase64(normalizedBase64) ||
    normalizedBase64.length % 4 !== 0
  ) {
    throw new Error("The recorded audio could not be decoded.");
  }

  const paddingBytes = normalizedBase64.endsWith("==") ? 2 : normalizedBase64.endsWith("=") ? 1 : 0;
  const decodedByteLength = (normalizedBase64.length / 4) * 3 - paddingBytes;
  if (decodedByteLength > SERVER_VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES) {
    throw new Error("Voice messages are limited to 10 MB.");
  }

  const audioBuffer = Buffer.from(normalizedBase64, "base64");
  if (!audioBuffer.length || audioBuffer.toString("base64") !== normalizedBase64) {
    throw new Error("The recorded audio could not be decoded.");
  }
  if (audioBuffer.length > SERVER_VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES) {
    throw new Error("Voice messages are limited to 10 MB.");
  }
  if (!isValidVoiceWavBuffer(audioBuffer)) {
    throw new Error("The recorded audio is not a valid WAV file.");
  }
  const audioDurationMs = (audioBuffer.readUInt32LE(40) / 48_000) * 1_000;
  if (audioDurationMs > MAX_VOICE_DURATION_MS) {
    throw new Error("Voice messages are limited to 120 seconds.");
  }

  return audioBuffer;
}

function readNonEmptyString(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length > 0 ? normalized : null;
}

// --- Auth discovery --------------------------------------------------------

async function resolveDesktopVoiceAuth(
  cwd: string,
): Promise<{ token: string; transcriptionUrl: string }> {
  return new Promise((resolve, reject) => {
    const prepared = prepareWindowsSafeProcess("codex", ["app-server"], {
      cwd,
      env: process.env,
    });
    const child = ChildProcess.spawn(prepared.command, prepared.args, {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: prepared.shell,
      windowsHide: prepared.windowsHide,
      windowsVerbatimArguments: prepared.windowsVerbatimArguments,
    });

    let settled = false;
    let stdoutBuffer = "";
    const rejectOnce = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      reject(error);
    };
    const resolveOnce = (value: { token: string; transcriptionUrl: string }) => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      resolve(value);
    };
    const send = (payload: Record<string, unknown>) => {
      child.stdin.write(`${JSON.stringify(payload)}\n`);
    };

    child.once("error", (error) => {
      rejectOnce(new Error(`Could not start Codex auth discovery: ${error.message}`));
    });
    child.stderr.on("data", () => {
      // Ignore stderr noise from the discovery process; the JSON-RPC result is authoritative.
    });
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }

        if (message.id === 1) {
          send({ jsonrpc: "2.0", method: "initialized", params: {} });
          send({
            jsonrpc: "2.0",
            id: 2,
            method: "getAuthStatus",
            params: { includeToken: true, refreshToken: true },
          });
          continue;
        }

        if (message.id !== 2) {
          continue;
        }

        const result =
          typeof message.result === "object" && message.result !== null
            ? (message.result as Record<string, unknown>)
            : null;
        const authMethod = readNonEmptyString(result?.authMethod);
        const token = readNonEmptyString(result?.authToken);
        if (!token) {
          rejectOnce(
            new Error("No ChatGPT session token is available. Sign in to ChatGPT in Codex."),
          );
          return;
        }
        if (authMethod !== "chatgpt" && authMethod !== "chatgptAuthTokens") {
          rejectOnce(
            new Error("Voice transcription requires a ChatGPT-authenticated Codex session."),
          );
          return;
        }

        resolveOnce({
          token,
          transcriptionUrl:
            readNonEmptyString(result?.transcriptionUrl) ?? CHATGPT_VOICE_TRANSCRIPTION_URL,
        });
      }
    });

    setTimeout(() => {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          clientInfo: {
            name: "synara-desktop",
            title: "Synara Desktop",
            version: app.getVersion(),
          },
          capabilities: { experimentalApi: true },
        },
      });
    }, 100);

    setTimeout(() => {
      rejectOnce(new Error("Timed out while reading ChatGPT auth from Codex."));
    }, 10_000).unref();
  });
}

// --- Network upload --------------------------------------------------------

export async function requestDesktopVoiceTranscription(input: {
  readonly audioBuffer: Buffer;
  readonly mimeType: string;
  readonly token: string;
  readonly transcriptionUrl: string;
}): Promise<OutboundHttpResponse> {
  return requestChatGptVoiceTranscription({
    audio: input.audioBuffer,
    mimeType: input.mimeType,
    token: input.token,
    transcriptionUrl: input.transcriptionUrl,
  });
}

function readVoiceResponseErrorMessage(statusCode: number, body: string): string {
  try {
    const payload = JSON.parse(body) as { error?: { message?: unknown }; message?: unknown };
    const providerMessage =
      readNonEmptyString(payload.error?.message) ?? readNonEmptyString(payload.message);
    if (providerMessage) {
      return providerMessage;
    }
  } catch {
    // Fall back to a status-based message when the upstream body is not JSON.
  }

  if (statusCode === 401) {
    return "Your ChatGPT login has expired. Sign in again.";
  }
  if (statusCode === 403) {
    return "ChatGPT rejected the transcription request. Your Codex login is present, but this desktop upload was forbidden.";
  }

  return `Transcription failed with status ${statusCode}.`;
}

// --- IPC entrypoint --------------------------------------------------------

async function transcribeVoiceViaDesktopBridge(
  input: ServerVoiceTranscriptionInput,
): Promise<ServerVoiceTranscriptionResult> {
  const audioBuffer = decodeDesktopVoiceAudio(input);
  const auth = await resolveDesktopVoiceAuth(input.cwd?.trim() || process.cwd());
  const response = await requestDesktopVoiceTranscription({
    audioBuffer,
    mimeType: input.mimeType,
    token: auth.token,
    transcriptionUrl: auth.transcriptionUrl,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(readVoiceResponseErrorMessage(response.status, decodeOutboundText(response)));
  }

  const payload = decodeOutboundJson(response, { maxDepth: 16, maxNodes: 1_000 }) as {
    text?: unknown;
    transcript?: unknown;
  };
  const text = readNonEmptyString(payload.text) ?? readNonEmptyString(payload.transcript);
  if (!text) {
    throw new Error("The transcription response did not include any text.");
  }

  return { text };
}

// Provider routing: Codex uses the existing ChatGPT transcription endpoint
// (requires ChatGPT-authenticated Codex session). All other providers route
// through the local whisper.cpp sidecar (offline, no auth needed). The web app
// passes voiceDictationModel and voiceDictionary in the input — no desktop-side
// settings store needed.
async function transcribeVoiceWithRouting(
  input: ServerVoiceTranscriptionInput,
): Promise<ServerVoiceTranscriptionResult> {
  // Codex provider: existing ChatGPT path (unchanged).
  if (input.provider === "codex") {
    return transcribeVoiceViaDesktopBridge(input);
  }

  // Non-Codex providers: local whisper.cpp sidecar.
  const audioBuffer = decodeDesktopVoiceAudio(input);
  const text = await transcribeViaWhisper({
    audioBuffer,
    modelName: input.voiceDictationModel ?? "base-q5_1",
    dictionary: input.voiceDictionary ?? [],
  });

  return { text };
}

export function registerDesktopVoiceTranscriptionHandler(): void {
  ipcMain.removeHandler(SERVER_TRANSCRIBE_VOICE_CHANNEL);
  ipcMain.handle(
    SERVER_TRANSCRIBE_VOICE_CHANNEL,
    async (_event, input: ServerVoiceTranscriptionInput) => transcribeVoiceWithRouting(input),
  );
}
