import type { CanvasPage, CanvasStreamEvent } from "@synara/contracts";
import { expect, it } from "vitest";
import { answerCanvasRenderRequest } from "./canvasExport";

type RenderEvent = Extract<CanvasStreamEvent, { type: "render" }>;

const page: CanvasPage = {
  id: "page",
  title: "Page",
  viewport: { x: 0, y: 0, zoom: 1 },
  comments: [],
  frames: [
    {
      id: "card",
      title: "Card",
      x: 0,
      y: 0,
      width: 390,
      height: 320,
      revision: 1,
      style: "background:#ffffff;padding:16px",
      layers: {
        roots: ["card-box"],
        nodes: [
          {
            id: "card-box",
            type: "element",
            tag: "div",
            attributes: { style: "display:flex;flex-direction:column;gap:12px;padding:16px" },
            children: ["button", "hidden"],
          },
          {
            id: "button",
            type: "element",
            tag: "button",
            attributes: {
              style:
                "width:93px;height:40px;border:0;border-radius:8px;background-color:#174039;color:#ffffff",
            },
            children: ["label"],
          },
          { id: "label", type: "text", text: "Upgrade" },
          {
            id: "hidden",
            type: "element",
            tag: "div",
            attributes: { "data-hidden": "true", style: "width:10px;height:10px" },
            children: [],
          },
        ],
      },
    },
  ],
};

const request = (overrides: Partial<RenderEvent>): RenderEvent => ({
  type: "render",
  requestId: "render_test",
  workId: "work",
  pageId: "page",
  frameId: "card",
  maxSide: 1600,
  ...overrides,
});

async function pixels(png: string) {
  const bytes = Uint8Array.from(atob(png), (char) => char.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d")!;
  context.drawImage(bitmap, 0, 0);
  const read = (x: number, y: number) =>
    Array.from(context.getImageData(x, y, 1, 1).data.slice(0, 3));
  return { width: bitmap.width, height: bitmap.height, read };
}

const near = (actual: number[], expected: number[]) =>
  actual.every((value, index) => Math.abs(value - expected[index]!) <= 3);

it("measures layer boxes in frame pixels, off screen, skipping text and hidden layers", async () => {
  const result = await answerCanvasRenderRequest(
    request({ maxSide: 64, measure: { layerIds: ["button", "label", "hidden", "missing"] } }),
    page,
    [],
  );
  expect(result).toEqual({ layers: [{ id: "button", x: 32, y: 32, width: 93, height: 40 }] });
  expect(document.body.querySelector("[aria-hidden='true']")).toBeNull();
  const styled = await answerCanvasRenderRequest(
    request({ maxSide: 64, measure: { layerIds: ["button"], styles: true } }),
    page,
    [],
  );
  expect("layers" in styled && styled.layers[0]!.styles).toMatchObject({
    "background-color": "rgb(23, 64, 57)",
    "border-radius": "8px",
    width: "93px",
  });
});

it("crops a screenshot to one layer at the requested scale, within maxSide", async () => {
  const doubled = await answerCanvasRenderRequest(
    request({ layerId: "button", scale: 2 }),
    page,
    [],
  );
  if (!("png" in doubled)) throw new Error("expected an image");
  expect([doubled.width, doubled.height]).toEqual([186, 80]);
  const image = await pixels(doubled.png);
  expect([image.width, image.height]).toEqual([186, 80]);
  // The crop is the button itself: its fill at the centre.
  expect(near(image.read(20, 70), [23, 64, 57])).toBe(true);

  const single = await answerCanvasRenderRequest(
    request({ layerId: "button", scale: 1 }),
    page,
    [],
  );
  expect("png" in single && [single.width, single.height]).toEqual([93, 40]);
  const capped = await answerCanvasRenderRequest(
    request({ layerId: "button", scale: 2, maxSide: 64 }),
    page,
    [],
  );
  expect("png" in capped && [capped.width, capped.height]).toEqual([64, 28]);
  const frame = await answerCanvasRenderRequest(request({ scale: 1 }), page, []);
  expect("png" in frame && [frame.width, frame.height]).toEqual([390, 320]);

  await expect(answerCanvasRenderRequest(request({ layerId: "hidden" }), page, [])).rejects.toThrow(
    "hidden or empty",
  );
});

// A frame holding a 40×40 inline SVG icon at 20,20: a blue square drawn with currentColor.
const svgPage: CanvasPage = {
  ...page,
  frames: [
    {
      id: "card",
      title: "Card",
      x: 0,
      y: 0,
      width: 100,
      height: 80,
      revision: 1,
      style: "background:#ffffff;color:#0000ff",
      layers: {
        roots: ["icon"],
        nodes: [
          {
            id: "icon",
            type: "element",
            tag: "svg",
            attributes: {
              viewBox: "0 0 10 10",
              style: "position:absolute;left:20px;top:20px;width:40px;height:40px",
            },
            children: ["square"],
          },
          {
            id: "square",
            type: "element",
            tag: "path",
            attributes: { d: "M0 0h10v10H0z", fill: "currentColor" },
            children: [],
          },
        ],
      },
    },
  ],
};

it("renders inline SVG in screenshots, page images and measurements (pixel check)", async () => {
  // A frame screenshot rasterizes the SVG nested in the foreignObject.
  const frame = await answerCanvasRenderRequest(request({ scale: 1 }), svgPage, []);
  if (!("png" in frame)) throw new Error("expected an image");
  const whole = await pixels(frame.png);
  expect(near(whole.read(40, 40), [0, 0, 255])).toBe(true);
  expect(near(whole.read(10, 10), [255, 255, 255])).toBe(true);
  // Cropped to the SVG layer at scale 2.
  const crop = await answerCanvasRenderRequest(request({ layerId: "icon", scale: 2 }), svgPage, []);
  if (!("png" in crop)) throw new Error("expected an image");
  expect([crop.width, crop.height]).toEqual([80, 80]);
  expect(near((await pixels(crop.png)).read(40, 40), [0, 0, 255])).toBe(true);
  // The whole page.
  const all = await answerCanvasRenderRequest(request({ frameId: null }), svgPage, []);
  if (!("png" in all)) throw new Error("expected an image");
  const pageImage = await pixels(all.png);
  expect(
    near(
      pageImage.read(Math.round(pageImage.width / 2), Math.round(pageImage.height / 2)),
      [0, 0, 255],
    ),
  ).toBe(true);
  // Measuring reads the SVG's box and what its shapes are painted with.
  const measured = await answerCanvasRenderRequest(
    request({ measure: { layerIds: ["icon", "square"], styles: true } }),
    svgPage,
    [],
  );
  if (!("layers" in measured)) throw new Error("expected layers");
  expect(measured.layers.map(({ id, x, y, width, height }) => [id, x, y, width, height])).toEqual([
    ["icon", 20, 20, 40, 40],
    ["square", 20, 20, 40, 40],
  ]);
  expect(measured.layers[1]!.styles).toMatchObject({ fill: "rgb(0, 0, 255)" });
});
