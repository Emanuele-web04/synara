// FILE: voiceTranscription.ts
// Purpose: Owns the desktop-specific voice transcription flow for Electron builds.
// Layer: Desktop IPC + ChatGPT upload bridge
// Depends on: Codex auth discovery, Electron net uploads, and the shared server voice contract.

import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";

import { app, ipcMain } from "electron";
import type {
  ServerVoiceTranscriptionInput,
  ServerVoiceTranscriptionResult,
} from "@synara/contracts";
import { encodeOutboundMultipart, outboundHttp } from "@synara/shared/outboundHttp";
import type { OutboundHttpResponse } from "@synara/shared/outboundHttp";
import { prepareWindowsSafeProcess } from "@synara/shared/windowsProcess";
import { transcribeViaWhisper } from "./whisperTranscription";

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
  return buffer.length > 44 && buffer.toString("ascii", 0, 4) === "RIFF";
}

function decodeDesktopVoiceAudio(input: ServerVoiceTranscriptionInput): Buffer {
  const base64 = normalizeVoiceBase64(input.audio);
  if (!base64) {
    throw new Error("No voice audio was provided.");
  }
  if (!isLikelyVoiceBase64(base64)) {
    throw new Error("Voice audio is not valid base64.");
  }
  const buffer = Buffer.from(base64, "base64");
  if (!isLikelyWavBuffer(buffer)) {
    throw new Error("Decoded voice audio does not appear to be a WAV file.");
  }
  return buffer;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// --- Auth discovery --------------------------------------------------------

async function resolveDesktopVoiceAuth(
  cwd: string,
): Promise<{ token: string; transcriptionUrl: string }> {
  return new Promise((resolve, reject) => {
    const child = ChildProcess.spawn(
      ...prepareWindowsSafeProcess("codex", ["mcp", "get-auth"], { cwd }),
      {
        cwd,
        stdio: ["pipe", "pipe", "inherit"],
      },
    );
    let stdout = "";
    let resolved = false;
    let rejected = false;
    const resolveOnce = (value: { token: string; transcriptionUrl: string }) => {
      if (!resolved) {
        resolved = true;
        resolve(value);
        destroy();
      }
    };
    const rejectOnce = (error: Error) => {
      if (!rejected) {
        rejected = true;
        reject(error);
        destroy();
      }
    };
    const destroy = () => {
      child.stdout?.removeAllListeners("data");
      child.removeAllListeners("close");
      child.kill();
    };

    child.on("close", (exitCode) => {
      if (!resolved && !rejected) {
        rejectOnce(
          new Error(
            exitCode === 0
              ? "Codex MCP auth command exited without returning auth data."
              : `Codex MCP auth command exited with code ${String(exitCode)}.`,
          ),
        );
      }
    });

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        let message: Record<string, unknown> | null = null;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (message?.jsonrpc !== "2.0") continue;
        if (typeof message?.id !== "number") continue;
        if (message?.id !== 1) continue;
        if (!("result" in message)) continue;
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
      child.stdin?.end(
        JSON.stringify({
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
        }) + "\n",
      );
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
  const multipart = encodeOutboundMultipart(
    [
      {
        name: "file",
        filename: "voice.wav",
        contentType: input.mimeType,
        body: new Uint8Array(input.audioBuffer),
      },
    ],
    { maxBytes: MAX_VOICE_AUDIO_BYTES + 64 * 1024 },
  );

  const response = await outboundHttp.request({
    policy: {
      service: "chatgpt-voice-transcription",
      allowedOrigins: [new URL(CHATGPT_TRANSCRIPTIONS_URL).origin],
      timeoutMs: 30_000,
      maxRequestBytes: MAX_VOICE_AUDIO_BYTES + 64 * 1024,
      maxResponseBytes: 1024 * 1024,
      maxRedirects: 0,
      maxConcurrent: 2,
      maxQueued: 4,
      requirePublicAddress: true,
    },
    url: input.transcriptionUrl.trim() || CHATGPT_TRANSCRIPTIONS_URL,
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.token}`,
      "Content-Type": multipart.contentType,
    },
    body: multipart.body,
  });

  return response;
}

function readVoiceResponseErrorMessage(statusCode: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (typeof parsed.error === "string") return parsed.error;
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    // fall through
  }
  return `Voice transcription failed with status ${String(statusCode)}.`;
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
  const body = new TextDecoder().decode(response.body);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(readVoiceResponseErrorMessage(response.status, body));
  }

  const payload = JSON.parse(body) as { text?: unknown; transcript?: unknown };
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
