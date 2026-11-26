import type { CanvasStreamEvent } from "@synara/contracts";
import { afterEach, expect, it, vi } from "vitest";
import {
  hasCanvasRenderClient,
  registerCanvasRenderClient,
  requestCanvasMeasure,
  requestCanvasRender,
  submitCanvasRender,
} from "./canvasRenderRequests";

type RenderEvent = Extract<CanvasStreamEvent, { type: "render" }>;

const releases: Array<() => void> = [];
afterEach(() => {
  releases.splice(0).forEach((release) => release());
  vi.useRealTimers();
});
const connect = () => {
  const release = registerCanvasRenderClient();
  releases.push(release);
  return release;
};

/** Only the header matters: dimensions come from IHDR, not from what the client claims. */
function pngBase64(width: number, height: number) {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes.toString("base64");
}
const target = { workId: "work", pageId: "page-main", frameId: "home", maxSide: 1600 };
function request(signal?: AbortSignal) {
  const publish = vi.fn<(event: RenderEvent) => void>();
  const promise = requestCanvasRender(publish, target, signal);
  return { publish, promise, requestId: () => publish.mock.calls[0]![0].requestId };
}

it("refuses a screenshot when no editor window is connected", async () => {
  const publish = vi.fn();
  await expect(requestCanvasRender(publish, target)).rejects.toThrow("open Synara window");
  expect(publish).not.toHaveBeenCalled();
});

it("publishes a render request and resolves with the first valid answer", async () => {
  connect();
  const controller = new AbortController();
  const { publish, promise, requestId } = request(controller.signal);
  expect(publish).toHaveBeenCalledWith({ type: "render", requestId: requestId(), ...target });
  expect(requestId()).toMatch(/^render_/);
  const png = pngBase64(640, 480);
  expect(submitCanvasRender({ requestId: requestId(), result: { png, width: 1, height: 1 } })).toBe(
    true,
  );
  await expect(promise).resolves.toEqual({ png, width: 640, height: 480 });
  expect(
    submitCanvasRender({
      requestId: requestId(),
      result: { png: pngBase64(2, 2), width: 2, height: 2 },
    }),
  ).toBe(false);
  // A settled request no longer listens to its signal.
  controller.abort();
  expect(submitCanvasRender({ requestId: "render_unknown", result: { error: "late" } })).toBe(
    false,
  );
});

it("rejects a request with the client's error or an invalid PNG", async () => {
  connect();
  const failed = request();
  expect(
    submitCanvasRender({ requestId: failed.requestId(), result: { error: "renderer crashed" } }),
  ).toBe(true);
  await expect(failed.promise).rejects.toThrow("Screenshot failed: renderer crashed");

  for (const png of [
    Buffer.from("not a png at all, just text").toString("base64"),
    pngBase64(0, 10),
  ]) {
    const invalid = request();
    expect(
      submitCanvasRender({
        requestId: invalid.requestId(),
        result: { png, width: 10, height: 10 },
      }),
    ).toBe(true);
    await expect(invalid.promise).rejects.toThrow("invalid PNG");
    expect(
      submitCanvasRender({
        requestId: invalid.requestId(),
        result: { png: pngBase64(1, 1), width: 1, height: 1 },
      }),
    ).toBe(false);
  }
});

it("times out after 20 seconds without an answer", async () => {
  vi.useFakeTimers();
  connect();
  const { promise, requestId } = request();
  let settled = false;
  const outcome = promise.then(
    () => "resolved",
    (error: Error) => error.message,
  );
  void outcome.finally(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(19_999);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await outcome).toContain("in time");
  expect(
    submitCanvasRender({
      requestId: requestId(),
      result: { png: pngBase64(1, 1), width: 1, height: 1 },
    }),
  ).toBe(false);
});

it("cancels a pending request when its signal aborts", async () => {
  vi.useFakeTimers();
  connect();
  const controller = new AbortController();
  const { promise, requestId } = request(controller.signal);
  controller.abort();
  await expect(promise).rejects.toThrow("Screenshot cancelled.");
  expect(vi.getTimerCount()).toBe(0);
  expect(
    submitCanvasRender({
      requestId: requestId(),
      result: { png: pngBase64(1, 1), width: 1, height: 1 },
    }),
  ).toBe(false);
});

it("counts each client once even when its release runs twice", async () => {
  const first = connect();
  const second = connect();
  first();
  first();
  const pending = request();
  expect(pending.publish).toHaveBeenCalledOnce();
  submitCanvasRender({ requestId: pending.requestId(), result: { error: "done" } });
  await expect(pending.promise).rejects.toThrow("done");
  second();
  await expect(requestCanvasRender(vi.fn(), target)).rejects.toThrow("open Synara window");
});

it("forwards a layer crop and scale, and refuses an answer without an image", async () => {
  connect();
  const publish = vi.fn<(event: RenderEvent) => void>();
  const promise = requestCanvasRender(publish, { ...target, layerId: "button", scale: 2 });
  const event = publish.mock.calls[0]![0];
  expect(event).toMatchObject({ type: "render", frameId: "home", layerId: "button", scale: 2 });
  expect(event.measure).toBeUndefined();
  submitCanvasRender({ requestId: event.requestId, result: { layers: [] } });
  await expect(promise).rejects.toThrow("returned no image");
});

it("measures layers through the window and keeps only the boxes it asked for", async () => {
  expect(hasCanvasRenderClient()).toBe(false);
  await expect(
    requestCanvasMeasure(vi.fn(), { ...target, frameId: "home", layerIds: ["a"] }),
  ).rejects.toThrow("Measurements need an open Synara window");
  connect();
  expect(hasCanvasRenderClient()).toBe(true);
  const publish = vi.fn<(event: RenderEvent) => void>();
  const promise = requestCanvasMeasure(publish, {
    workId: "work",
    pageId: "page-main",
    frameId: "home",
    layerIds: ["a", "b", "a"],
    styles: true,
  });
  const event = publish.mock.calls[0]![0];
  expect(event).toMatchObject({
    type: "render",
    frameId: "home",
    maxSide: 64,
    measure: { layerIds: ["a", "b"], styles: true },
  });
  const box = { x: 1, y: 2, width: 93, height: 40 };
  submitCanvasRender({
    requestId: event.requestId,
    result: {
      layers: [
        { id: "a", ...box },
        { id: "other", ...box },
      ],
    },
  });
  expect([...(await promise).entries()]).toEqual([["a", { id: "a", ...box }]]);

  // An older window answers with an image; a measure request treats that as unmeasured.
  const old = vi.fn<(event: RenderEvent) => void>();
  const unmeasured = requestCanvasMeasure(old, { ...target, frameId: "home", layerIds: ["a"] });
  submitCanvasRender({
    requestId: old.mock.calls[0]![0].requestId,
    result: { png: pngBase64(1, 1), width: 1, height: 1 },
  });
  await expect(unmeasured).rejects.toThrow("cannot measure layers");
});

it("gives up measuring after its own timeout", async () => {
  vi.useFakeTimers();
  connect();
  const promise = requestCanvasMeasure(
    vi.fn(),
    { ...target, frameId: "home", layerIds: ["a"] },
    undefined,
    5_000,
  );
  const outcome = promise.then(
    () => "resolved",
    (error: Error) => error.message,
  );
  await vi.advanceTimersByTimeAsync(5_000);
  expect(await outcome).toContain("measurement request in time");
});
