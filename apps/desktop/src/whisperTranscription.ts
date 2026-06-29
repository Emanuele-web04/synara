// FILE: whisperTranscription.ts
// Purpose: Local whisper.cpp sidecar for offline voice transcription.
// Layer: Desktop IPC helper (spawned per-request, no persistent process)
// Why: Non-Codex providers need voice dictation without ChatGPT. whisper-cli
//      runs locally, audio never leaves the machine. Per-request spawn keeps
//      this simple — no zombie guards, no idle timeouts, no cross-window mutex.

import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as Fs from "node:fs";
import * as Path from "node:path";
import { app } from "electron";

const WHISPER_TRANSCRIPTION_TIMEOUT_MS = 60_000;
const MODEL_DIR_NAME = "whisper-models";

// SHA256 hashes for verified models. These are the trust anchor — hardcoded
// in source, not downloadable config. If a model fails verification, refuse it.
// Hashes from HuggingFace LFS metadata for ggerganov/whisper.cpp.
const MODEL_SHA256: Record<string, string> = {
  "base-q5_1": "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898",
  "base.en-q5_1": "4baf70dd0d7c4247ba2b81fafd9c01005ac77c2f9ef064e00dcf195d0e2fdd2f",
};

const MODEL_URLS: Record<string, string> = {
  "base-q5_1": "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin",
  "base.en-q5_1": "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en-q5_1.bin",
};

const MODEL_FILENAMES: Record<string, string> = {
  "base-q5_1": "ggml-base-q5_1.bin",
  "base.en-q5_1": "ggml-base.en-q5_1.bin",
};

function modelsDir(): string {
  return Path.join(app.getPath("userData"), MODEL_DIR_NAME);
}

function modelPath(modelName: string): string {
  return Path.join(modelsDir(), MODEL_FILENAMES[modelName] ?? `${modelName}.bin`);
}

// Resolve the whisper-cli binary path.
// Mac: detect in PATH (Homebrew `brew install whisper-cpp` → /opt/homebrew/bin/whisper-cli).
// Windows/Linux: bundled via extraResources at apps/desktop/resources/whisper/<platform>/.
function resolveWhisperCliBinary(): string | null {
  if (process.platform === "darwin") {
    // Check common Homebrew paths, then PATH.
    const homebrewPaths = ["/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli"];
    for (const p of homebrewPaths) {
      try {
        if (Fs.existsSync(p)) return p;
      } catch {
        // ignore
      }
    }
    // Fallback: assume it's in PATH (will be resolved by execFile).
    return "whisper-cli";
  }

  // Windows + Linux: bundled via extraResources.
  const resourcesDir = Path.join(process.resourcesPath ?? "", "whisper");
  const binaryName = process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli";
  const binaryPath = Path.join(resourcesDir, binaryName);
  try {
    if (Fs.existsSync(binaryPath)) return binaryPath;
  } catch {
    // ignore
  }
  return null;
}

// Verify SHA256 of a downloaded model. Refuse if hash doesn't match.
export function verifyModelSha256(filePath: string, expectedHash: string): boolean {
  try {
    const hash = Crypto.createHash("sha256");
    const data = Fs.readFileSync(filePath);
    hash.update(data);
    return hash.digest("hex") === expectedHash;
  } catch {
    return false;
  }
}

// Download a model with progress callback. Deletes partial file on interruption.
// ponytail: no resumable downloads (v1 — restart from 0 on interruption).
async function downloadModel(
  modelName: string,
  onProgress?: (downloaded: number, total: number | null) => void,
): Promise<void> {
  const url = MODEL_URLS[modelName];
  if (!url) throw new Error(`Unknown whisper model: ${modelName}`);

  const dest = modelPath(modelName);
  const expectedHash = MODEL_SHA256[modelName];
  if (!expectedHash) throw new Error(`No SHA256 hash for model: ${modelName}`);

  Fs.mkdirSync(modelsDir(), { recursive: true });

  // If already downloaded and verified, skip.
  if (Fs.existsSync(dest) && verifyModelSha256(dest, expectedHash)) {
    return;
  }

  const { net } = await import("electron");
  return new Promise<void>((resolve, reject) => {
    const request = net.request({ method: "GET", url });
    const fileStream = Fs.createWriteStream(dest);
    let downloaded = 0;
    let total: number | null = null;
    let settled = false;

    const cleanup = () => {
      try {
        Fs.unlinkSync(dest);
      } catch {
        // ignore
      }
    };

    request.on("response", (response) => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        cleanup();
        reject(new Error(`Model download failed with status ${response.statusCode}`));
        return;
      }
      const contentLength = response.headers["content-length"];
      if (typeof contentLength === "string") total = parseInt(contentLength, 10);

      response.on("data", (chunk: Buffer) => {
        downloaded += chunk.length;
        fileStream.write(chunk);
        onProgress?.(downloaded, total);
      });
      response.once("end", () => {
        fileStream.end(() => {
          if (settled) return;
          settled = true;
          if (!verifyModelSha256(dest, expectedHash)) {
            cleanup();
            reject(new Error("Model SHA256 verification failed. The download may be corrupted."));
            return;
          }
          resolve();
        });
      });
      response.once("error", (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`Model download failed: ${err.message}`));
      });
    });

    request.once("error", (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Model download request failed: ${err.message}`));
    });

    request.end();
  });
}

// Shared download promise: concurrent voice requests before model is downloaded
// both wait on the same download.
let activeDownload: Promise<void> | null = null;

export async function ensureWhisperModel(
  modelName: string,
  onProgress?: (downloaded: number, total: number | null) => void,
): Promise<void> {
  const dest = modelPath(modelName);
  const expectedHash = MODEL_SHA256[modelName];
  if (!expectedHash) throw new Error(`Unknown whisper model: ${modelName}`);

  // Already downloaded and verified.
  if (Fs.existsSync(dest) && verifyModelSha256(dest, expectedHash)) {
    return;
  }

  // Dedupe concurrent downloads.
  if (activeDownload) {
    await activeDownload;
    return;
  }

  activeDownload = downloadModel(modelName, onProgress).finally(() => {
    activeDownload = null;
  });
  await activeDownload;
}

// Resample 24kHz 16-bit mono WAV to 16kHz 16-bit mono WAV.
// Linear interpolation. ~30 lines. Recorder stays at 24kHz for both paths
// (ChatGPT requires 24kHz, whisper requires 16kHz).
export function resampleWav24kTo16k(inputBuffer: Buffer): Buffer {
  // Parse WAV header to find data start.
  if (inputBuffer.length < 44) throw new Error("Invalid WAV: too short");
  const sampleRate = inputBuffer.readUInt32LE(24);
  if (sampleRate !== 24_000) throw new Error(`Expected 24kHz WAV, got ${sampleRate}Hz`);
  const dataChunkId = inputBuffer.toString("ascii", 36, 40);
  if (dataChunkId !== "data") throw new Error("Invalid WAV: expected data chunk");

  const dataSize = inputBuffer.readUInt32LE(40);
  const dataStart = 44;
  const samplesIn = Math.floor(dataSize / 2); // 16-bit = 2 bytes per sample
  const samplesOut = Math.floor((samplesIn * 16_000) / 24_000);

  // Linear interpolation resampling.
  const outputData = Buffer.alloc(samplesOut * 2);
  for (let i = 0; i < samplesOut; i++) {
    const srcIndex = (i * 24_000) / 16_000;
    const srcIndexFloor = Math.floor(srcIndex);
    const frac = srcIndex - srcIndexFloor;
    const sample1 = inputBuffer.readInt16LE(dataStart + srcIndexFloor * 2);
    const sample2 =
      srcIndexFloor + 1 < samplesIn
        ? inputBuffer.readInt16LE(dataStart + (srcIndexFloor + 1) * 2)
        : sample1;
    const interpolated = Math.round(sample1 + (sample2 - sample1) * frac);
    outputData.writeInt16LE(interpolated, i * 2);
  }

  // Build 16kHz WAV header.
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + outputData.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(16_000, 24); // sample rate
  header.writeUInt32LE(16_000 * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(outputData.length, 40);

  return Buffer.concat([header, outputData]);
}

export interface WhisperTranscribeOptions {
  readonly audioBuffer: Buffer; // 24kHz 16-bit mono WAV
  readonly modelName: string;
  readonly dictionary?: ReadonlyArray<string>;
}

// Transcribe audio via whisper-cli, spawned per-request.
// stdin receives 16kHz WAV (resampled from 24kHz). stdout returns text.
// 60s timeout kills hung processes. No persistent process, no cleanup needed.
export async function transcribeViaWhisper(options: WhisperTranscribeOptions): Promise<string> {
  const binary = resolveWhisperCliBinary();
  if (!binary) {
    throw new Error(
      process.platform === "darwin"
        ? "Voice dictation needs whisper-cli. Install via Homebrew: brew install whisper-cpp"
        : "Voice setup incomplete — whisper-cli binary not found. Reinstall Synara.",
    );
  }

  await ensureWhisperModel(options.modelName);
  const model = modelPath(options.modelName);
  const wav16k = resampleWav24kTo16k(options.audioBuffer);

  // Build prompt from custom dictionary for accuracy biasing.
  const prompt =
    options.dictionary && options.dictionary.length > 0
      ? options.dictionary.slice(0, 200).join(", ")
      : undefined;

  const args = [
    "-f",
    "-", // read WAV from stdin
    "-m",
    model,
    "-l",
    "auto", // auto language detection
    "-nt", // no timestamps
    "-np", // no progress
    ...(prompt ? ["--prompt", prompt] : []),
  ];

  return new Promise<string>((resolve, reject) => {
    const child = ChildProcess.execFile(
      binary,
      args,
      {
        timeout: WHISPER_TRANSCRIPTION_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, _stderr) => {
        if (error) {
          const message = error.message.includes("TIMED_OUT")
            ? "Transcription timed out. Please try again."
            : `Transcription failed: ${error.message}`;
          reject(new Error(message));
          return;
        }
        const text = stdout.trim();
        if (!text) {
          reject(new Error("Nothing heard. Please try recording again."));
          return;
        }
        resolve(text);
      },
    );

    // Pipe 16kHz WAV to stdin.
    child.stdin?.write(wav16k);
    child.stdin?.end();
  });
}
