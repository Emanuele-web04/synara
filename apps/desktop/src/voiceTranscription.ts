// FILE: voiceTranscription.ts
// Purpose: Owns the desktop-specific voice transcription flow for Electron builds.
// Layer: Desktop IPC + ChatGPT upload bridge
// Depends on: Codex auth discovery, Electron net uploads, and the shared server voice contract.

import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";

import { app, ipcMain, net } from "electron";
import type {
  ServerVoiceTranscriptionInput,
  ServerVoiceTranscriptionResult,
} from "@t3tools/contracts";

export const SERVER_TRANSCRIBE_VOICE_CHANNEL = "desktop:server-transcribe-voice";

const CHATGPT_TRANSCRIPTIONS_URL = "https://chatgpt.com/backend-api/transcribe";
const MAX_VOICE_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_VOICE_DURATION_MS = 120_000;

// --- Input validation ------------------------------------------------------

function normalizeVoiceBase64(value: string): string | null {
  const normalized = value.trim().replace(/\s+/g, "");
  return normalized.length > 0 ? normalized : null;
}

function isLikelyVoiceBase64(value: string): boolean {
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function isLikelyWavBuffer(buffer: Buffer): boolean {
  return (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WAVE"
  );
}

function decodeDesktopVoiceAudio(input: ServerVoiceTranscriptionInput): Buffer {
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
  if (!normalizedBase64 || !isLikelyVoiceBase64(normalizedBase64)) {
    throw new Error("The recorded audio could not be decoded.");
  }

  const audioBuffer = Buffer.from(normalizedBase64, "base64");
  if (!audioBuffer.length || audioBuffer.toString("base64") !== normalizedBase64) {
    throw new Error("The recorded audio could not be decoded.");
  }
  if (audioBuffer.length > MAX_VOICE_AUDIO_BYTES) {
    throw new Error("Voice messages are limited to 10 MB.");
  }
  if (!isLikelyWavBuffer(audioBuffer)) {
    throw new Error("The recorded audio is not a valid WAV file.");
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
    const child = ChildProcess.spawn("codex", ["app-server"], {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
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
            readNonEmptyString(result?.transcriptionUrl) ?? CHATGPT_TRANSCRIPTIONS_URL,
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
            name: "dp-code-desktop",
            title: "DP Code Desktop",
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

async function requestDesktopVoiceTranscription(input: {
  readonly audioBuffer: Buffer;
  readonly mimeType: string;
  readonly token: string;
  readonly transcriptionUrl: string;
}): Promise<{ statusCode: number; body: string }> {
  const boundary = `DPCodeVoice-${Crypto.randomUUID()}`;
  const preamble = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="voice.wav"\r\nContent-Type: ${input.mimeType}\r\n\r\n`,
    "utf8",
  );
  const closing = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  const body = Buffer.concat([preamble, input.audioBuffer, closing]);

  return new Promise((resolve, reject) => {
    const requestUrl = readNonEmptyString(input.transcriptionUrl) ?? CHATGPT_TRANSCRIPTIONS_URL;
    const request = net.request({
      method: "POST",
      url: requestUrl,
    });
    request.setHeader("Authorization", `Bearer ${input.token}`);
    request.setHeader("Content-Type", `multipart/form-data; boundary=${boundary}`);

    request.once("error", (error) => {
      reject(new Error(`Voice transcription request failed: ${error.message}`));
    });
    request.on("response", (response) => {
      let responseBody = "";
      response.on("data", (chunk) => {
        responseBody += chunk.toString();
      });
      response.once("end", () => {
        resolve({
          statusCode: response.statusCode,
          body: responseBody,
        });
      });
      response.once("error", (error) => {
        reject(new Error(`Voice transcription response failed: ${error.message}`));
      });
    });

    request.write(body);
    request.end();
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
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(readVoiceResponseErrorMessage(response.statusCode, response.body));
  }

  const payload = JSON.parse(response.body) as { text?: unknown; transcript?: unknown };
  const text = readNonEmptyString(payload.text) ?? readNonEmptyString(payload.transcript);
  if (!text) {
    throw new Error("The transcription response did not include any text.");
  }

  return { text };
}

export function registerDesktopVoiceTranscriptionHandler(): void {
  ipcMain.removeHandler(SERVER_TRANSCRIBE_VOICE_CHANNEL);
  ipcMain.handle(
    SERVER_TRANSCRIBE_VOICE_CHANNEL,
    async (_event, input: ServerVoiceTranscriptionInput) => transcribeVoiceViaDesktopBridge(input),
  );
}
