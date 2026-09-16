import type { NativeApi } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HttpResponse, http } from "msw";
import { setupWorker } from "msw/browser";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { downloadUrlAsBlob } from "~/lib/browserDownload";
import { projectLocalPreviewGrantQueryOptions } from "~/lib/projectReactQuery";
import { GeneratedMarkdownImage } from "./GeneratedMarkdownImage";

vi.mock("~/lib/browserDownload", () => ({
  downloadUrlAsBlob: vi.fn(async ({ url }: { url: string }) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
  }),
}));

const png = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==",
  ),
  (char) => char.charCodeAt(0),
);
const desktopPath = "/Users/tester/Desktop/simulator shot.png";
const grants = new Map<string, string>();
const requests: URL[] = [];
let nextGrant = 0;
const createLocalFilePreviewGrant = vi.fn(async ({ path }: { path: string }) => {
  if (path.includes("missing")) throw new Error("Preview file not found.");
  const grant = `grant-${++nextGrant}`;
  grants.set(grant, path);
  return { grant, expiresAt: new Date(Date.now() + 120_000).toISOString() };
});
const worker = setupWorker(
  http.get("*/api/local-image", ({ request }) => {
    const url = new URL(request.url);
    requests.push(url);
    const path = url.searchParams.get("path") ?? "";
    const allowed =
      path === "./workspace.png" || grants.get(url.searchParams.get("grant") ?? "") === path;
    return allowed
      ? new HttpResponse(png.slice(), { headers: { "Content-Type": "image/png" } })
      : new HttpResponse(null, { status: 404 });
  }),
);
let client: QueryClient;
let previousNativeApi: PropertyDescriptor | undefined;

beforeAll(async () => {
  await worker.start({ quiet: true, onUnhandledRequest: "bypass" });
});
afterAll(() => worker.stop());
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  previousNativeApi = Object.getOwnPropertyDescriptor(window, "nativeApi");
  Object.defineProperty(window, "nativeApi", {
    configurable: true,
    value: { projects: { createLocalFilePreviewGrant } } as unknown as NativeApi,
  });
  grants.clear();
  requests.length = 0;
  vi.clearAllMocks();
});
afterEach(() => {
  client.clear();
  if (previousNativeApi) Object.defineProperty(window, "nativeApi", previousNativeApi);
  else Reflect.deleteProperty(window, "nativeApi");
});

function image(src: string, onImageExpand = vi.fn()) {
  return (
    <QueryClientProvider client={client}>
      <GeneratedMarkdownImage
        src={src}
        alt="Simulator screenshot"
        cwd="/Users/tester/project"
        onImageExpand={onImageExpand}
      />
    </QueryClientProvider>
  );
}

async function expectReady() {
  await vi.waitFor(
    () => {
      expect(document.querySelector(".chat-generated-image")?.getAttribute("data-status")).toBe(
        "ready",
      );
      expect(
        document.querySelector<HTMLImageElement>(".chat-generated-image__img")?.naturalWidth,
      ).toBe(1);
    },
    { timeout: 5_000 },
  );
}

it("does not poll or reload a loaded image when another consumer renews its grant", async () => {
  await render(image(desktopPath));
  await expectReady();
  const src = document.querySelector<HTMLImageElement>(".chat-generated-image__img")!.src;
  const requestCount = requests.length;
  vi.useFakeTimers();
  try {
    await vi.advanceTimersByTimeAsync(65_000);
    expect(createLocalFilePreviewGrant).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(requestCount);
    client.setQueryData(projectLocalPreviewGrantQueryOptions({ path: desktopPath }).queryKey, {
      grant: "renewed-in-file-pane",
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(document.querySelector<HTMLImageElement>(".chat-generated-image__img")!.src).toBe(src);
  } finally {
    vi.useRealTimers();
  }
});

it("requests a fresh grant after HTTP denial even with an unexpired cached token", async () => {
  client.setQueryData(projectLocalPreviewGrantQueryOptions({ path: desktopPath }).queryKey, {
    grant: "from-before-server-restart",
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
  });
  await render(image(desktopPath));
  await expectReady();
  expect(createLocalFilePreviewGrant).toHaveBeenCalledExactlyOnceWith({ path: desktopPath });
  expect(
    requests.some((url) => url.searchParams.get("grant") === "from-before-server-restart"),
  ).toBe(false);
});

it("retries an interrupted grant request without retrying permanent missing-file errors", async () => {
  createLocalFilePreviewGrant.mockRejectedValueOnce(
    Object.assign(new Error("Transport interrupted"), { retryable: true }),
  );
  await render(image(desktopPath));
  await expectReady();
  expect(createLocalFilePreviewGrant).toHaveBeenCalledTimes(2);
});

it("recovers a Desktop screenshot after HTTP denial using the exact decoded file grant", async () => {
  await render(image("file:///Users/tester/Desktop/simulator%20shot.png"));
  await expectReady();
  expect(createLocalFilePreviewGrant).toHaveBeenCalledExactlyOnceWith({ path: desktopPath });
  expect(requests[0]?.searchParams.get("grant")).toBeNull();
  expect(
    requests.some((url) => grants.get(url.searchParams.get("grant") ?? "") === desktopPath),
  ).toBe(true);
});

it("keeps workspace images on the HTTP-only path", async () => {
  await render(image("./workspace.png"));
  await expectReady();
  expect(createLocalFilePreviewGrant).not.toHaveBeenCalled();
});

it("renews the grant before downloading after the server has lost its old grants", async () => {
  const screen = await render(image(desktopPath));
  await expectReady();
  grants.clear();
  await screen.getByRole("link", { name: "Download generated image" }).click();
  await vi.waitFor(() => expect(downloadUrlAsBlob).toHaveBeenCalledOnce());
  await vi.mocked(downloadUrlAsBlob).mock.results[0]?.value;
  expect(createLocalFilePreviewGrant).toHaveBeenCalledTimes(2);
  await vi.waitFor(() =>
    expect(
      requests.some(
        (url) =>
          url.searchParams.get("download") === "1" &&
          grants.get(url.searchParams.get("grant") ?? "") === desktopPath,
      ),
    ).toBe(true),
  );
});

it("renews the grant for the expanded image too", async () => {
  const expand = vi.fn();
  const screen = await render(image(desktopPath, expand));
  await expectReady();
  grants.clear();
  await screen.getByRole("button", { name: "Expand generated image" }).click();
  await vi.waitFor(() => expect(expand).toHaveBeenCalledOnce());
  const url = new URL(expand.mock.calls[0]![0].images[0].src);
  expect(grants.get(url.searchParams.get("grant") ?? "")).toBe(desktopPath);
});

it("keeps missing absolute files in the error card without repeated grant requests", async () => {
  const screen = await render(image("/Users/tester/Desktop/missing.png"));
  await expect.element(screen.getByText("Couldn’t open this image")).toBeVisible();
  expect(createLocalFilePreviewGrant).toHaveBeenCalledOnce();
});

it("does not request an absolute-file grant for a missing relative image", async () => {
  const screen = await render(image("./missing.png"));
  await expect.element(screen.getByText("Couldn’t open this image")).toBeVisible();
  expect(createLocalFilePreviewGrant).not.toHaveBeenCalled();
});

it("resets recovery across source changes and returns to a previously failed source", async () => {
  const screen = await render(image("/Users/tester/Desktop/missing.png"));
  await expect.element(screen.getByText("Couldn’t open this image")).toBeVisible();
  await screen.rerender(image("./workspace.png"));
  await expectReady();
  await screen.rerender(image(desktopPath));
  await expectReady();
  await screen.rerender(image("./workspace.png"));
  await expectReady();
  expect(document.querySelector<HTMLImageElement>(".chat-generated-image__img")?.src).not.toContain(
    "grant=",
  );
});
