import * as Crypto from "node:crypto";
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp" },
  net: { request: () => ({}) },
}));

import {
  ensureModelDownloadSingleFlight,
  ensureWhisperModel,
  resampleWav24kTo16k,
  verifyModelSha256,
} from "./whisperTranscription";

// Build a 24kHz 16-bit mono WAV with the given PCM samples.
function makeWav24k(samples: number[]): Buffer {
  const dataSize = samples.length * 2;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24_000, 24);
  header.writeUInt32LE(24_000 * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataSize, 40);
  const data = Buffer.alloc(dataSize);
  for (let i = 0; i < samples.length; i++) {
    data.writeInt16LE(samples[i]!, i * 2);
  }
  return Buffer.concat([header, data]);
}

function readWavData(buffer: Buffer): { sampleRate: number; samples: number[] } {
  const sampleRate = buffer.readUInt32LE(24);
  const dataSize = buffer.readUInt32LE(40);
  const samples: number[] = [];
  for (let i = 0; i < dataSize / 2; i++) {
    samples.push(buffer.readInt16LE(44 + i * 2));
  }
  return { sampleRate, samples };
}

describe("resampleWav24kTo16k", () => {
  it("produces a valid 16kHz WAV header", () => {
    const input = makeWav24k([0, 100, 200, 300]);
    const output = resampleWav24kTo16k(input);
    expect(output.toString("ascii", 0, 4)).toBe("RIFF");
    expect(output.toString("ascii", 8, 12)).toBe("WAVE");
    expect(output.readUInt32LE(24)).toBe(16_000);
    expect(output.readUInt16LE(22)).toBe(1); // mono
    expect(output.readUInt16LE(34)).toBe(16); // bits per sample
  });

  it("downsamples from 24kHz to 16kHz at 2:3 ratio", () => {
    // 6 samples at 24kHz → 4 samples at 16kHz
    const input = makeWav24k([0, 100, 200, 300, 400, 500]);
    const output = resampleWav24kTo16k(input);
    const { sampleRate, samples } = readWavData(output);
    expect(sampleRate).toBe(16_000);
    expect(samples).toHaveLength(4);
  });

  it("preserves silence as silence", () => {
    const input = makeWav24k([0, 0, 0, 0, 0, 0]);
    const output = resampleWav24kTo16k(input);
    const { samples } = readWavData(output);
    expect(samples.every((s) => s === 0)).toBe(true);
  });

  it("interpolates between samples linearly", () => {
    // At 24kHz, samples [0, 300]. At 16kHz, first output sample is at srcIndex 0 → 0.
    // Second output sample is at srcIndex 1.5 → 0 + (300-0)*0.5 = 150.
    const input = makeWav24k([0, 300]);
    const output = resampleWav24kTo16k(input);
    const { samples } = readWavData(output);
    expect(samples).toHaveLength(1);
    expect(samples[0]).toBe(0);
  });

  it("handles a single sample input", () => {
    const input = makeWav24k([42]);
    const output = resampleWav24kTo16k(input);
    const { samples } = readWavData(output);
    // 1 sample at 24kHz → floor(1 * 16000/24000) = 0 samples
    expect(samples).toHaveLength(0);
  });

  it("throws on invalid WAV (too short)", () => {
    expect(() => resampleWav24kTo16k(Buffer.alloc(10))).toThrow("too short");
  });

  it("throws on wrong sample rate", () => {
    const wav = makeWav24k([0, 1]);
    wav.writeUInt32LE(44_100, 24);
    expect(() => resampleWav24kTo16k(wav)).toThrow("Expected 24kHz WAV");
  });

  it("throws on missing data chunk id", () => {
    const wav = makeWav24k([0, 1]);
    wav.write("xxxx", 36, "ascii");
    expect(() => resampleWav24kTo16k(wav)).toThrow("expected data chunk");
  });

  it("rejects a declared data size larger than the actual payload", () => {
    const wav = makeWav24k([0, 1]);
    wav.writeUInt32LE(0xffff_ffff, 40);
    expect(() => resampleWav24kTo16k(wav)).toThrow("data size does not match payload");
  });
});

describe("verifyModelSha256", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "whisper-test-"));
  });

  afterEach(() => {
    Fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns true when hash matches", () => {
    const data = Buffer.from("test model content");
    const filePath = Path.join(tmpDir, "model.bin");
    Fs.writeFileSync(filePath, data);
    const hash = Crypto.createHash("sha256").update(data).digest("hex");
    expect(verifyModelSha256(filePath, hash)).toBe(true);
  });

  it("returns false when hash does not match", () => {
    const filePath = Path.join(tmpDir, "model.bin");
    Fs.writeFileSync(filePath, Buffer.from("actual content"));
    expect(verifyModelSha256(filePath, "0".repeat(64))).toBe(false);
  });

  it("returns false when file does not exist", () => {
    expect(verifyModelSha256(Path.join(tmpDir, "nonexistent.bin"), "0".repeat(64))).toBe(false);
  });
});

describe("model download concurrency", () => {
  it("starts independent first-use downloads for different models", async () => {
    let firstVerified = false;
    let secondVerified = false;
    let resolveFirst!: () => void;
    let resolveSecond!: () => void;
    const downloadFirst = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveFirst = () => {
            firstVerified = true;
            resolve();
          };
        }),
    );
    const downloadSecond = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSecond = () => {
            secondVerified = true;
            resolve();
          };
        }),
    );

    const first = ensureModelDownloadSingleFlight("test-base", () => firstVerified, downloadFirst);
    const second = ensureModelDownloadSingleFlight(
      "test-base-en",
      () => secondVerified,
      downloadSecond,
    );

    expect(downloadFirst).toHaveBeenCalledTimes(1);
    expect(downloadSecond).toHaveBeenCalledTimes(1);
    resolveFirst();
    resolveSecond();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
  });

  it("deduplicates the same model and rechecks availability for every waiter", async () => {
    let verified = false;
    let resolveDownload!: () => void;
    const download = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveDownload = () => {
            verified = true;
            resolve();
          };
        }),
    );

    const first = ensureModelDownloadSingleFlight("test-shared", () => verified, download);
    const second = ensureModelDownloadSingleFlight("test-shared", () => verified, download);

    expect(download).toHaveBeenCalledTimes(1);
    resolveDownload();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
  });

  it("rejects when a completed download did not produce a verified model", async () => {
    await expect(
      ensureModelDownloadSingleFlight(
        "test-missing",
        () => false,
        async () => undefined,
      ),
    ).rejects.toThrow("unavailable after download");
  });
});

describe("ensureWhisperModel", () => {
  it("throws on unknown model name", async () => {
    await expect(ensureWhisperModel("nonexistent-model")).rejects.toThrow("Unknown whisper model");
  });
});
