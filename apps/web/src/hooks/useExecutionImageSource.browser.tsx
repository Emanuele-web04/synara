import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { fetchExecutionImageResourceUrl } from "~/lib/wsHttpUrl";
import { useExecutionImageSource } from "./useExecutionImageSource";

vi.mock("~/lib/wsHttpUrl", () => ({
  isDesktopFrameResourceUrl: (source: string | undefined) => source?.startsWith("/owned/") === true,
  fetchExecutionImageResourceUrl: vi.fn(),
}));

const canvas = new OffscreenCanvas(8, 6);
canvas.getContext("2d")!.fillRect(0, 0, 8, 6);
const png = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
const response = () => new Response(png.slice(), { headers: { "Content-Type": "image/png" } });

function Preview({
  source,
  lazy = false,
  fill = false,
  onLoadResult,
}: {
  source: string;
  lazy?: boolean;
  fill?: boolean;
  onLoadResult?: ((realImage: boolean) => void) | undefined;
}) {
  const image = useExecutionImageSource(source, lazy);
  return (
    <img
      ref={image.ref}
      src={image.src}
      {...image.intrinsicProps}
      style={{ ...image.intrinsicProps.style, ...(fill ? { width: "100%" } : {}) }}
      onLoad={(event) => {
        const realImage = image.onLoad(event);
        onLoadResult?.(realImage);
      }}
      alt="Owned image"
      data-error={image.error}
    />
  );
}

beforeEach(() => {
  vi.mocked(fetchExecutionImageResourceUrl).mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

it("keeps native browser and draft blob images independent of the parent capability", async () => {
  const source = URL.createObjectURL(new Blob([png], { type: "image/png" }));
  const screen = await render(<Preview source={source} />);
  try {
    await vi.waitFor(() => expect(document.querySelector("img")?.naturalWidth).toBe(8));
    expect(fetchExecutionImageResourceUrl).not.toHaveBeenCalled();
  } finally {
    await screen.unmount();
    URL.revokeObjectURL(source);
  }
});

it("revokes replaced image URLs and refetches A → B → A rather than reviving a revoked preview", async () => {
  vi.mocked(fetchExecutionImageResourceUrl).mockImplementation(async () => response());
  const revoke = vi.spyOn(URL, "revokeObjectURL");
  const screen = await render(<Preview source="/owned/a" />);
  try {
    await vi.waitFor(() => expect(document.querySelector("img")?.naturalWidth).toBe(8));
    const first = document.querySelector("img")!.src;
    await screen.rerender(<Preview source="/owned/b" />);
    await vi.waitFor(() => expect(document.querySelector("img")?.naturalWidth).toBe(8));
    expect(revoke).toHaveBeenCalledWith(first);
    await screen.rerender(<Preview source="/owned/a" />);
    await vi.waitFor(() => {
      expect(document.querySelector("img")?.naturalWidth).toBe(8);
      expect(document.querySelector("img")?.src).not.toBe(first);
    });
    expect(fetchExecutionImageResourceUrl).toHaveBeenCalledTimes(3);
  } finally {
    await screen.unmount();
  }
  expect(revoke).toHaveBeenCalledTimes(3);
});

it("aborts an unmounted preview without creating an object URL from late bytes", async () => {
  let resolve!: (response: Response) => void;
  vi.mocked(fetchExecutionImageResourceUrl).mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const create = vi.spyOn(URL, "createObjectURL");
  const screen = await render(<Preview source="/owned/late" />);
  await vi.waitFor(() => expect(fetchExecutionImageResourceUrl).toHaveBeenCalledOnce());
  const signal = vi.mocked(fetchExecutionImageResourceUrl).mock.calls[0]?.[1]?.signal;
  await screen.unmount();
  expect(signal?.aborted).toBe(true);
  resolve(response());
  await vi.waitFor(() => expect(create).not.toHaveBeenCalled());
});

it("releases visited offscreen bytes while keeping row geometry and onscreen images stable", async () => {
  vi.mocked(fetchExecutionImageResourceUrl).mockImplementation(async () => response());
  const createObjectURL = URL.createObjectURL.bind(URL);
  const revokeObjectURL = URL.revokeObjectURL.bind(URL);
  const active = new Map<string, number>();
  const firstImageLoads = vi.fn();
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    const url = createObjectURL(blob);
    active.set(url, blob instanceof Blob ? blob.size : 0);
    return url;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => {
    active.delete(url);
    revokeObjectURL(url);
  });
  function Gallery({ tick }: { tick: number }) {
    return (
      <div data-tick={tick} data-gallery style={{ height: 220, width: 240, overflow: "auto" }}>
        {Array.from({ length: 12 }, (_, index) => (
          <div key={index} data-row={index} style={{ marginBottom: 20 }}>
            <Preview
              source={`/owned/${index}`}
              lazy
              fill
              onLoadResult={index === 0 ? firstImageLoads : undefined}
            />
          </div>
        ))}
      </div>
    );
  }
  const screen = await render(<Gallery tick={0} />);
  try {
    const gallery = document.querySelector<HTMLDivElement>("[data-gallery]")!;
    const firstRow = document.querySelector<HTMLDivElement>('[data-row="0"]')!;
    await vi.waitFor(() => expect(firstRow.querySelector("img")?.naturalWidth).toBe(8));
    expect(firstImageLoads).toHaveBeenLastCalledWith(true);
    const firstHeight = firstRow.getBoundingClientRect().height;
    const requestCount = vi.mocked(fetchExecutionImageResourceUrl).mock.calls.length;
    await screen.rerender(<Gallery tick={1} />);
    expect(vi.mocked(fetchExecutionImageResourceUrl).mock.calls).toHaveLength(requestCount);
    for (let index = 2; index < 12; index++) {
      const row = document.querySelector<HTMLDivElement>(`[data-row="${index}"]`)!;
      gallery.scrollTop = row.offsetTop - gallery.offsetTop;
      await vi.waitFor(() => expect(row.querySelector("img")?.src).toMatch(/^blob:/));
    }
    await vi.waitFor(() => {
      expect(firstRow.querySelector("img")?.src).toMatch(/^data:image\/svg\+xml,/);
      expect(active.size).toBeLessThanOrEqual(4);
      expect([...active.values()].reduce((sum, bytes) => sum + bytes, 0)).toBeLessThanOrEqual(
        png.byteLength * 4,
      );
    });
    expect(firstRow.getBoundingClientRect().height).toBe(firstHeight);
    await vi.waitFor(() => expect(firstImageLoads).toHaveBeenLastCalledWith(false));
    gallery.scrollTop = 0;
    await vi.waitFor(() => expect(firstRow.querySelector("img")?.src).toMatch(/^blob:/));
    await vi.waitFor(() => expect(firstImageLoads).toHaveBeenLastCalledWith(true));
    expect(firstRow.getBoundingClientRect().height).toBe(firstHeight);
  } finally {
    await screen.unmount();
  }
  expect(active.size).toBe(0);
});
