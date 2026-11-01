import { ThreadId } from "@synara/contracts";
import type { WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";

import type { BrowserAutomationVisibleRuntime } from "../browserManager";
import { captureBrowserScreenshot } from "./screenshotCapture";

const THREAD_ID = ThreadId.makeUnsafe("thread-screenshot");
const TAB_ID = "b5f2ebcf-6b4b-409f-b6bd-408a5fb19d3b";

const png = (width: number, height: number, extraBytes = 0): Buffer => {
  const value = Buffer.alloc(24 + extraBytes);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(value, 0);
  value.write("IHDR", 12, "ascii");
  value.writeUInt32BE(width, 16);
  value.writeUInt32BE(height, 20);
  return value;
};

const createRuntime = (
  options: {
    readonly viewportPng?: Buffer;
    readonly fullPagePng?: Buffer;
    readonly contentWidth?: number;
    readonly contentHeight?: number;
  } = {},
) => {
  const viewportPng = options.viewportPng ?? png(1_024, 768);
  const fullPagePng = options.fullPagePng ?? png(1_500, 4_000);
  const capturePage = vi.fn(async () => ({
    toPNG: () => viewportPng,
    getSize: () => ({ width: 1_024, height: 768 }),
    resize: vi.fn(),
  }));
  const sendCommand = vi.fn(async (method: string) => {
    if (method === "Page.getLayoutMetrics") {
      return {
        cssContentSize: {
          width: options.contentWidth ?? 1_500,
          height: options.contentHeight ?? 4_000,
        },
        contentSize: { width: 3_000, height: 8_000 },
      };
    }
    if (method === "Page.captureScreenshot") {
      return { data: fullPagePng.toString("base64") };
    }
    return {};
  });
  const webContents = {
    isDestroyed: vi.fn(() => false),
    getType: vi.fn(() => "browserView"),
    beginFrameSubscription: vi.fn(),
    endFrameSubscription: vi.fn(),
    getURL: () => "https://example.test/page",
    capturePage,
    debugger: { isAttached: () => true, attach: vi.fn(), sendCommand },
  } as unknown as WebContents;
  return {
    runtime: {
      threadId: THREAD_ID,
      tabId: TAB_ID,
      webContents,
    } satisfies BrowserAutomationVisibleRuntime,
    sendCommand,
    beginFrameSubscription: webContents.beginFrameSubscription,
    endFrameSubscription: webContents.endFrameSubscription,
  };
};

describe("browser screenshot capture", () => {
  it("returns a bounded viewport PNG sidecar from the exact guest", async () => {
    const { runtime, beginFrameSubscription, endFrameSubscription } = createRuntime();

    await expect(captureBrowserScreenshot(runtime, { fullPage: false })).resolves.toMatchObject({
      structuredContent: {
        tabId: TAB_ID,
        url: "https://example.test/page",
        mode: "viewport",
        clipped: false,
        image: { width: 1_024, height: 768, byteLength: 24 },
      },
      image: { mimeType: "image/png", width: 1_024, height: 768 },
    });
    expect(beginFrameSubscription).not.toHaveBeenCalled();
    expect(endFrameSubscription).not.toHaveBeenCalled();
  });

  it("caps full-page CSS dimensions and reports clipping", async () => {
    const { runtime, sendCommand } = createRuntime({
      contentWidth: 5_000,
      contentHeight: 20_000,
      fullPagePng: png(3_840, 16_384),
    });

    await expect(captureBrowserScreenshot(runtime, { fullPage: true })).resolves.toMatchObject({
      structuredContent: {
        mode: "fullPage",
        clipped: true,
        image: { width: 3_840, height: 16_384 },
      },
    });
    expect(sendCommand).toHaveBeenCalledWith(
      "Page.captureScreenshot",
      expect.objectContaining({
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: 3_840, height: 16_384, scale: 1 },
      }),
    );
  });

  it("rejects images above the hard byte limit", async () => {
    const { runtime } = createRuntime({ viewportPng: png(1_024, 768, 8 * 1024 * 1024) });

    await expect(captureBrowserScreenshot(runtime, { fullPage: false })).rejects.toMatchObject({
      browserError: { code: "BrowserScreenshotTooLarge" },
    });
  });

  it("uses CSS metrics instead of Retina device pixels for the clip", async () => {
    const { runtime, sendCommand, beginFrameSubscription, endFrameSubscription } = createRuntime();
    vi.mocked(runtime.webContents.getType).mockReturnValue("webview");
    await captureBrowserScreenshot(runtime, { fullPage: true });
    expect(beginFrameSubscription).not.toHaveBeenCalled();
    expect(endFrameSubscription).not.toHaveBeenCalled();
    expect(sendCommand).toHaveBeenCalledWith(
      "Page.captureScreenshot",
      expect.objectContaining({
        clip: { x: 0, y: 0, width: 1_500, height: 4_000, scale: 1 },
      }),
    );
  });

  it("reduces capture scale when Retina output exceeds the pixel limit", async () => {
    const { runtime, sendCommand } = createRuntime({ contentWidth: 3_000, contentHeight: 8_000 });
    const metrics = await sendCommand("Page.getLayoutMetrics");
    sendCommand.mockClear();
    sendCommand
      .mockResolvedValueOnce(metrics)
      .mockResolvedValueOnce({ data: png(6_000, 16_000).toString("base64") })
      .mockResolvedValueOnce({ data: png(4_500, 12_000).toString("base64") })
      .mockResolvedValueOnce({ data: png(3_000, 8_000).toString("base64") });
    await expect(captureBrowserScreenshot(runtime, { fullPage: true })).resolves.toMatchObject({
      image: { width: 3_000, height: 8_000 },
    });
    expect(sendCommand).toHaveBeenCalledTimes(4);
    expect(sendCommand).toHaveBeenLastCalledWith(
      "Page.captureScreenshot",
      expect.objectContaining({
        clip: { x: 0, y: 0, width: 3_000, height: 8_000, scale: 0.5 },
      }),
    );
  });
  it.each(["completed", "failed", "cancelled", "destroyed"] as const)(
    "releases native capture frames on %s while retaining the pending-command drain",
    async (outcome) => {
      const { runtime, sendCommand, beginFrameSubscription, endFrameSubscription } =
        createRuntime();
      const controller = new AbortController();
      let resolve!: (value: { data: string }) => void;
      let reject!: (error: Error) => void;
      sendCommand
        .mockImplementationOnce(async () => ({
          cssContentSize: { width: 1_500, height: 4_000 },
          contentSize: { width: 1_500, height: 4_000 },
        }))
        .mockImplementationOnce(
          () =>
            new Promise<{ data: string }>((res, rej) => {
              resolve = res;
              reject = rej;
            }),
        );
      let settled = false;
      const capture = captureBrowserScreenshot(runtime, { fullPage: true }, controller.signal)
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        )
        .finally(() => {
          settled = true;
        });
      await vi.waitFor(() =>
        expect(sendCommand).toHaveBeenCalledWith("Page.captureScreenshot", expect.any(Object)),
      );
      expect(beginFrameSubscription).toHaveBeenCalledExactlyOnceWith(true, expect.any(Function));
      const failure = new Error(outcome);
      if (outcome === "cancelled") {
        controller.abort(failure);
        expect(endFrameSubscription).toHaveBeenCalledTimes(1);
        await new Promise((nextTurn) => setImmediate(nextTurn));
        expect(settled).toBe(false);
      }
      if (outcome === "destroyed") vi.mocked(runtime.webContents.isDestroyed).mockReturnValue(true);
      if (outcome === "failed" || outcome === "destroyed") reject(failure);
      else resolve({ data: png(1_500, 4_000).toString("base64") });
      const result = await capture;
      if (outcome === "completed") expect(result).toHaveProperty("value.image.width", 1_500);
      else expect(result).toHaveProperty("error");
      if (outcome === "cancelled") expect(result).toEqual({ error: failure });
      expect(endFrameSubscription).toHaveBeenCalledTimes(outcome === "destroyed" ? 0 : 1);
    },
  );
});
