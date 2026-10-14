import "../../index.css";

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { AsciiWaveBackground } from "./AsciiWaveBackground";

const motion = vi.hoisted(() => ({ reduced: false }));
vi.mock("~/hooks/useMediaQuery", () => ({ useMediaQuery: () => motion.reduced }));
vi.mock("~/hooks/useTheme", () => ({
  useTheme: () => ({ activeTheme: { theme: { ink: "#ffffff", accent: "#88ee44" } } }),
}));

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function pixels(canvas: HTMLCanvasElement, bottomQuarter = false) {
  const y = bottomQuarter ? Math.floor(canvas.height * 0.75) : 0;
  return canvas.getContext("2d")!.getImageData(0, y, canvas.width, canvas.height - y).data;
}

async function mount(width = 800, height = 600) {
  const view = await render(
    <div data-testid="landing" style={{ position: "relative", width, height }}>
      <AsciiWaveBackground />
    </div>,
  );
  const host = document.querySelector<HTMLDivElement>('[data-testid="landing"]')!;
  const canvas = host.querySelector("canvas")!;
  await expect.poll(() => pixels(canvas).some((byte) => byte > 0), { timeout: 5000 }).toBe(true);
  await wait(1600);
  return { view, host, canvas };
}

beforeEach(() => {
  motion.reduced = false;
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("pauses canvas work in an invisible retained owner, resumes, and stops on unmount", async () => {
  const { view, host } = await mount();
  const draws = vi.spyOn(CanvasRenderingContext2D.prototype, "drawImage");
  host.style.visibility = "hidden";
  await wait(150);
  draws.mockClear();
  await wait(1200);
  expect(draws.mock.calls.length).toBe(0);
  host.style.visibility = "visible";
  await expect.poll(() => draws.mock.calls.length, { timeout: 2000 }).toBeGreaterThan(0);
  await view.unmount();
  draws.mockClear();
  await wait(150);
  expect(draws.mock.calls.length).toBe(0);
});

it("keeps the reduced-motion field unchanged after a user-triggered ripple settles", async () => {
  motion.reduced = true;
  const { host, canvas } = await mount();
  const before = pixels(canvas);
  const rect = host.getBoundingClientRect();
  for (const type of ["pointerdown", "pointerup"]) {
    host.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        button: 0,
        isPrimary: true,
        pointerId: 1,
        clientX: rect.left + 400,
        clientY: rect.top + 300,
      }),
    );
  }
  await wait(250);
  expect(pixels(canvas).every((byte, index) => byte === before[index])).toBe(false);
  await wait(2800);
  expect(pixels(canvas).every((byte, index) => byte === before[index])).toBe(true);
});

it("bounds Retina canvas allocation while preserving the landing's CSS size", async () => {
  vi.stubGlobal("devicePixelRatio", 3);
  const canvases = new Set<HTMLCanvasElement>();
  const getContext = HTMLCanvasElement.prototype.getContext;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
    this: HTMLCanvasElement,
    ...args: Parameters<typeof getContext>
  ) {
    canvases.add(this);
    return getContext.apply(this, args);
  });
  const { canvas } = await mount(1920, 1080);
  expect(canvas.getBoundingClientRect().width).toBe(1920);
  expect(canvas.getBoundingClientRect().height).toBe(1080);
  expect(canvas.width * canvas.height).toBeLessThan(4_010_000);
  expect([...canvases].reduce((bytes, c) => bytes + c.width * c.height * 4, 0)).toBeLessThan(
    50 * 1024 * 1024,
  );
});

it("publishes complete glyph layers after resize without a partial top-down wipe", async () => {
  motion.reduced = true;
  const { host, canvas } = await mount();
  const bottomCoverage: boolean[] = [];
  const drawImage = CanvasRenderingContext2D.prototype.drawImage;
  vi.spyOn(CanvasRenderingContext2D.prototype, "drawImage").mockImplementation(function (
    this: CanvasRenderingContext2D,
    ...args: Parameters<typeof drawImage>
  ) {
    drawImage.apply(this, args);
    if (this.canvas === canvas && pixels(canvas).some((byte) => byte > 0)) {
      bottomCoverage.push(pixels(canvas, true).some((byte) => byte > 0));
    }
  });
  host.style.width = "1200px";
  host.style.height = "800px";
  await expect.poll(() => bottomCoverage.length, { timeout: 5000 }).toBeGreaterThan(0);
  expect(bottomCoverage.every(Boolean)).toBe(true);
});
