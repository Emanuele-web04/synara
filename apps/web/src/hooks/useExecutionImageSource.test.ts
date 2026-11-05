import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import { readExecutionImageBlob } from "./useExecutionImageSource";

describe("bounded remote image reads", () => {
  it("preserves exact image bytes and MIME", async () => {
    const bytes = new Uint8Array([255, 216, 255, 217]);
    const image = await readExecutionImageBlob(
      new Response(bytes, { headers: { "Content-Type": "image/jpeg; charset=binary" } }),
      new AbortController().signal,
    );
    expect(image.type).toBe("image/jpeg");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(bytes);
  });

  it.each([
    { status: 404, type: "image/png", length: "4" },
    { status: 200, type: "text/html", length: "4" },
    { status: 200, type: "application/json", length: "4" },
    { status: 200, type: "image/png", length: String(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1) },
  ])(
    "cancels rejected metadata without reading the body (%j)",
    async ({ status, type, length }) => {
      const cancel = vi.fn();
      const stream = new ReadableStream({ cancel });
      await expect(
        readExecutionImageBlob(
          new Response(stream, {
            status,
            headers: { "Content-Type": type, "Content-Length": length },
          }),
          new AbortController().signal,
        ),
      ).rejects.toThrow();
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("cancels a streaming image that exceeds the limit even with a misleading Content-Length", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES));
        controller.enqueue(new Uint8Array([1]));
      },
      cancel,
    });
    await expect(
      readExecutionImageBlob(
        new Response(stream, { headers: { "Content-Type": "image/png", "Content-Length": "1" } }),
        new AbortController().signal,
      ),
    ).rejects.toThrow("permitted size");
    expect(cancel).toHaveBeenCalledOnce();
  });
});
