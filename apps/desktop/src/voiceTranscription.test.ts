import { outboundHttp, type OutboundHttpResponse } from "@synara/shared/outboundHttp";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getVersion: () => "0.0.0-test" },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
}));

import { requestDesktopVoiceTranscription } from "./voiceTranscription";

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
