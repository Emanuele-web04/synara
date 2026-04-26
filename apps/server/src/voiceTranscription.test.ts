// FILE: voiceTranscription.test.ts
// Purpose: Verifies voice transcription backend selection without contacting OpenAI.
// Layer: Server test
// Exports: Vitest cases
// Depends on: voiceTranscription utility and mocked fetch responses.

import type { ServerVoiceTranscriptionInput } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

import { transcribeVoiceWithChatGptSession } from "./voiceTranscription";

const WAV_BASE64 = Buffer.from("RIFF0000WAVE", "ascii").toString("base64");

const baseRequest: ServerVoiceTranscriptionInput = {
  provider: "codex",
  cwd: "/tmp/project",
  mimeType: "audio/wav",
  sampleRateHz: 24_000,
  durationMs: 1_000,
  audioBase64: WAV_BASE64,
};

function okFetch(): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify({ text: "hello" }), { status: 200 }));
}

describe("transcribeVoiceWithChatGptSession", () => {
  it("uses the ChatGPT transcription backend for ChatGPT auth", async () => {
    const fetchImpl = okFetch();

    await transcribeVoiceWithChatGptSession({
      request: baseRequest,
      resolveAuth: async () => ({ token: "chatgpt-token", authMethod: "chatgpt" }),
      fetchImpl,
    });

    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] ?? [];
    expect(url).toBe("https://chatgpt.com/backend-api/transcribe");
    expect((init?.body as FormData).get("model")).toBeNull();
  });

  it("uses the official audio transcription API for API key auth", async () => {
    const fetchImpl = okFetch();

    await transcribeVoiceWithChatGptSession({
      request: baseRequest,
      resolveAuth: async () => ({ token: "sk-test", authMethod: "apikey" }),
      fetchImpl,
    });

    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] ?? [];
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect((init?.body as FormData).get("model")).toBe("gpt-4o-transcribe");
  });
});
