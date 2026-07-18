import {
  SERVER_VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES,
  type ServerVoiceTranscriptionInput,
} from "@synara/contracts";
import { outboundHttp, type OutboundHttpResponse } from "@synara/shared/outboundHttp";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getVersion: () => "0.0.0-test" },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
}));

import { decodeDesktopVoiceAudio, requestDesktopVoiceTranscription } from "./voiceTranscription";

function makeWav24k(dataBytes = 2): Buffer {
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24_000, 24);
  wav.writeUInt32LE(48_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataBytes, 40);
  return wav;
}

const validWav = makeWav24k();

function makeVoiceInput(
  overrides: Partial<ServerVoiceTranscriptionInput> = {},
): ServerVoiceTranscriptionInput {
  return {
    provider: "opencode",
    cwd: "/tmp",
    mimeType: "audio/wav",
    sampleRateHz: 24_000,
    durationMs: 1_000,
    audioBase64: validWav.toString("base64"),
    ...overrides,
  } as ServerVoiceTranscriptionInput;
}

const successResponse: OutboundHttpResponse = {
  status: 200,
  headers: new Headers({ "content-type": "application/json" }),
  body: new TextEncoder().encode(JSON.stringify({ text: "hello" })),
  url: "https://chatgpt.com/backend-api/transcribe",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("desktop voice outbound policy", () => {
  it("uses the shared bounded multipart transport", async () => {
    const request = vi.spyOn(outboundHttp, "request").mockResolvedValue(successResponse);

    await requestDesktopVoiceTranscription({
      audioBuffer: Buffer.from("RIFF0000WAVE", "ascii"),
      mimeType: "audio/wav",
      token: "chatgpt-token",
      transcriptionUrl: "https://chatgpt.com/backend-api/transcribe",
    });

    const outbound = request.mock.calls[0]?.[0];
    expect(outbound?.policy.allowedOrigins).toEqual(["https://chatgpt.com"]);
    expect(new Headers(outbound?.headers).get("authorization")).toBe("Bearer chatgpt-token");
    expect(outbound?.body).toBeInstanceOf(Uint8Array);
  });

  it("rejects a provider-returned origin before forwarding the bearer", async () => {
    await expect(
      requestDesktopVoiceTranscription({
        audioBuffer: Buffer.from("RIFF0000WAVE", "ascii"),
        mimeType: "audio/wav",
        token: "chatgpt-token",
        transcriptionUrl: "https://attacker.example/transcribe",
      }),
    ).rejects.toThrow(/not allowed/u);
  });
});

describe("desktop voice IPC validation", () => {
  it("accepts a canonical 24 kHz WAV within the duration and size limits", () => {
    expect(decodeDesktopVoiceAudio(makeVoiceInput())).toEqual(validWav);
  });

  it("rejects non-WAV MIME types", () => {
    expect(() => decodeDesktopVoiceAudio(makeVoiceInput({ mimeType: "audio/webm" }))).toThrow(
      "Only WAV audio is supported",
    );
  });

  it("rejects unsupported sample rates", () => {
    expect(() => decodeDesktopVoiceAudio(makeVoiceInput({ sampleRateHz: 44_100 }))).toThrow(
      "requires 24 kHz mono WAV audio",
    );
  });

  it("rejects zero and over-limit durations", () => {
    expect(() => decodeDesktopVoiceAudio(makeVoiceInput({ durationMs: 0 }))).toThrow(
      "positive duration",
    );
    expect(() => decodeDesktopVoiceAudio(makeVoiceInput({ durationMs: 120_001 }))).toThrow(
      "limited to 120 seconds",
    );
  });

  it("rejects non-canonical base64", () => {
    expect(() =>
      decodeDesktopVoiceAudio(
        makeVoiceInput({
          audioBase64: `${validWav.toString("base64")}=`,
        }),
      ),
    ).toThrow("could not be decoded");
  });

  it("rejects encoded payloads over 10 MB before accepting the WAV", () => {
    const oversizedWav = Buffer.alloc(SERVER_VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES + 1);
    validWav.copy(oversizedWav);
    expect(() =>
      decodeDesktopVoiceAudio(
        makeVoiceInput({
          audioBase64: oversizedWav.toString("base64"),
        }),
      ),
    ).toThrow("limited to 10 MB");
  });

  it("requires both RIFF and WAVE signatures", () => {
    const invalidWav = Buffer.from(validWav);
    invalidWav.write("NOPE", 8, "ascii");
    expect(() =>
      decodeDesktopVoiceAudio(
        makeVoiceInput({
          audioBase64: invalidWav.toString("base64"),
        }),
      ),
    ).toThrow("not a valid WAV file");
  });

  it("rejects malformed PCM metadata and declared data sizes", () => {
    const wrongRate = Buffer.from(validWav);
    wrongRate.writeUInt32LE(16_000, 24);
    expect(() =>
      decodeDesktopVoiceAudio(makeVoiceInput({ audioBase64: wrongRate.toString("base64") })),
    ).toThrow("not a valid WAV file");

    const oversizedDeclaration = Buffer.from(validWav);
    oversizedDeclaration.writeUInt32LE(0xffff_ffff, 40);
    expect(() =>
      decodeDesktopVoiceAudio(
        makeVoiceInput({ audioBase64: oversizedDeclaration.toString("base64") }),
      ),
    ).toThrow("not a valid WAV file");
  });

  it("enforces the duration encoded in the WAV, not only client metadata", () => {
    const overDurationWav = makeWav24k(48_000 * 120 + 2);
    expect(() =>
      decodeDesktopVoiceAudio(
        makeVoiceInput({
          durationMs: 1,
          audioBase64: overDurationWav.toString("base64"),
        }),
      ),
    ).toThrow("limited to 120 seconds");
  });
});
