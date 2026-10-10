// FILE: chatGptVoiceTranscription.test.ts
// Purpose: Verifies the voice transport warms the provider connection safely.

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CHATGPT_VOICE_TRANSCRIPTION_URL,
  requestChatGptVoiceTranscription,
} from "./chatGptVoiceTranscription";
import { outboundHttp } from "./outboundHttp";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("requestChatGptVoiceTranscription", () => {
  it("uses the accepted browser identity for transcription uploads", async () => {
    const request = vi.spyOn(outboundHttp, "request").mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: new Uint8Array(),
      url: CHATGPT_VOICE_TRANSCRIPTION_URL,
    });

    await requestChatGptVoiceTranscription({
      audio: Uint8Array.from([1, 2, 3]),
      mimeType: "audio/wav",
      token: "test-token",
    });

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-token",
          "User-Agent": expect.stringContaining("Mozilla/5.0"),
        }),
      }),
    );
  });
});
