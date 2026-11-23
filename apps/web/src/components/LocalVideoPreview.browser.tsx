import "../index.css";

import { EnvironmentId, type NativeApi } from "@synara/contracts";
import { remoteResourceRoute } from "@synara/shared/remoteResources";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HttpResponse, http } from "msw";
import { setupWorker } from "msw/browser";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import ChatMarkdown from "./ChatMarkdown";
import { LocalVideoPreview } from "./LocalVideoPreview";
import { WorkspaceFilePreview } from "./WorkspaceFilePreview";
import { readExecutionContext } from "~/lib/hosts/executionContext";
import { readWorkspaceFrame } from "~/lib/hosts/workspaceFrame";
import type { WorkspaceResourceRequester } from "~/lib/hosts/workspaceResources";

vi.mock("~/lib/hosts/executionContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/hosts/executionContext")>()),
  readExecutionContext: vi.fn(),
}));
vi.mock("~/lib/hosts/workspaceFrame", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/hosts/workspaceFrame")>()),
  readWorkspaceFrame: vi.fn(),
}));
// A real VP8 WebM recorded in the test browser, so loadedmetadata is genuine.
async function recordWebm(): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 180;
  const context = canvas.getContext("2d")!;
  const recorder = new MediaRecorder(canvas.captureStream(30), {
    mimeType: "video/webm;codecs=vp8",
  });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => chunks.push(event.data);
  const stopped = new Promise((resolve) => {
    recorder.onstop = resolve;
  });
  recorder.start();
  for (let frame = 0; frame < 8; frame += 1) {
    context.fillStyle = frame % 2 === 0 ? "#2563eb" : "#dc2626";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  recorder.stop();
  await stopped;
  return new Uint8Array(await new Blob(chunks).arrayBuffer());
}

const webm = await recordWebm();
const requests: URL[] = [];
const savedUrls: string[] = [];
const grants = new Map<string, string>();
let nextGrant = 0;
const createLocalFilePreviewGrant = vi.fn(async ({ path }: { path: string }) => {
  const grant = `grant-${++nextGrant}`;
  grants.set(grant, path);
  return {
    grant,
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    canonicalPath: path,
  };
});

function videoResponse(request: Request, bytes: Uint8Array, contentType = "video/webm") {
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get("range") ?? "");
  if (!range) {
    return new HttpResponse(bytes.slice(), {
      headers: { "Content-Type": contentType, "Accept-Ranges": "bytes" },
    });
  }
  const start = Number(range[1]);
  const end = range[2] ? Math.min(Number(range[2]), bytes.byteLength - 1) : bytes.byteLength - 1;
  return new HttpResponse(bytes.slice(start, end + 1), {
    status: 206,
    headers: {
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
      "Content-Range": `bytes ${start}-${end}/${bytes.byteLength}`,
    },
  });
}

const worker = setupWorker(
  http.get("*/api/local-image", ({ request }) => {
    const url = new URL(request.url);
    requests.push(url);
    const path = url.searchParams.get("path") ?? "";
    if (path.endsWith("broken-codec.mov")) {
      // A container the browser cannot decode (e.g. ProRes): bytes arrive, playback fails.
      return videoResponse(request, new Uint8Array(256).fill(7), "video/quicktime");
    }
    const grant = url.searchParams.get("grant");
    const allowed =
      path === "out/clip.webm" ||
      path === "/workspace/out/clip.webm" ||
      (grant !== null && grants.get(grant) === path);
    return allowed ? videoResponse(request, webm) : new HttpResponse(null, { status: 404 });
  }),
);
let client: QueryClient;
let previousNativeApi: PropertyDescriptor | undefined;

beforeAll(async () => {
  await worker.start({ quiet: true, onUnhandledRequest: "bypass" });
});
afterAll(() => worker.stop());
beforeEach(() => {
  vi.mocked(readExecutionContext).mockReset();
  vi.mocked(readWorkspaceFrame).mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  previousNativeApi = Object.getOwnPropertyDescriptor(window, "nativeApi");
  Object.defineProperty(window, "nativeApi", {
    configurable: true,
    value: { projects: { createLocalFilePreviewGrant } } as unknown as NativeApi,
  });
  grants.clear();
  nextGrant = 0;
  requests.length = 0;
  savedUrls.length = 0;
  // Intercept only the final programmatic save, after real resource routing.
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
    function (this: HTMLAnchorElement) {
      savedUrls.push(this.href);
    },
  );
  vi.clearAllMocks();
});
afterEach(() => {
  worker.resetHandlers();
  client.clear();
  if (previousNativeApi) Object.defineProperty(window, "nativeApi", previousNativeApi);
  else Reflect.deleteProperty(window, "nativeApi");
  vi.restoreAllMocks();
});

function configureDesktopResourceFixture() {
  const scope = {
    environmentId: EnvironmentId.makeUnsafe("preview-host"),
    accountAuthority: "https://account.example",
    userId: "preview-user",
    organizationId: "preview-org",
    channel: "beta" as const,
  };
  const environment = {
    environmentId: scope.environmentId,
    label: "Preview host",
    platform: { os: "darwin" as const, arch: "arm64" as const },
    serverVersion: "fixture",
    capabilities: { repositoryIdentity: true },
  };
  vi.mocked(readExecutionContext).mockReturnValue({
    controller: environment,
    execution: environment,
    remoteHostId: "preview-computer",
    remote: scope,
  });
  vi.mocked(readWorkspaceFrame).mockReturnValue({
    host: { hostId: "preview-computer", executionScope: scope },
    controller: {
      desktop: true,
      requestResource: ((resource, request) => {
        const route = remoteResourceRoute(resource);
        if (route.method !== "GET") throw new Error("Only preview GETs belong to this fixture");
        return fetch(new URL(route.path, window.location.origin), {
          cache: "no-store",
          ...(request?.signal ? { signal: request.signal } : {}),
        });
      }) satisfies WorkspaceResourceRequester,
    },
  } as unknown as NonNullable<ReturnType<typeof readWorkspaceFrame>>);
}

function videoElement(): HTMLVideoElement | null {
  return document.querySelector("video");
}

function inlineVideoWrapper(): HTMLElement {
  return document.querySelector<HTMLElement>(".chat-generated-video")!;
}

it("streams a workspace video into a native player and reports readiness once", async () => {
  const onPreviewReady = vi.fn();
  const onPreviewError = vi.fn();
  const screen = await render(
    <LocalVideoPreview
      src="/workspace/out/clip.webm"
      cwd="/workspace"
      onPreviewReady={onPreviewReady}
      onPreviewError={onPreviewError}
    />,
  );
  try {
    await vi.waitFor(() => {
      expect(document.querySelector(".local-image-preview")?.getAttribute("data-status")).toBe(
        "ready",
      );
    });
    const video = videoElement()!;
    expect(video.controls).toBe(true);
    expect(video.preload).toBe("metadata");
    expect(video.autoplay).toBe(false);
    expect(video.playsInline).toBe(true);
    expect(video.videoWidth).toBe(320);
    expect(new URL(video.src).pathname).toBe("/api/local-image");
    expect(new URL(video.src).searchParams.get("path")).toBe("/workspace/out/clip.webm");
    expect(onPreviewReady).toHaveBeenCalledOnce();
    expect(onPreviewError).not.toHaveBeenCalled();
    expect(document.querySelector("img")).toBeNull();

    const download = screen.getByRole("link", { name: "Download video" });
    await download.click();
    await vi.waitFor(() => expect(savedUrls).toEqual([download.element().getAttribute("href")]));
  } finally {
    await screen.unmount();
  }
});

it.each([
  ["a missing file", "/workspace/out/missing.mp4"],
  ["an undecodable codec", "/workspace/out/broken-codec.mov"],
])("falls back to a download card for %s", async (_case, src) => {
  const onPreviewError = vi.fn();
  const screen = await render(
    <LocalVideoPreview src={src} cwd="/workspace" onPreviewError={onPreviewError} />,
  );
  try {
    await expect.element(screen.getByText("Couldn’t play this video")).toBeVisible();
    expect(videoElement()).toBeNull();
    expect(onPreviewError).toHaveBeenCalledOnce();
    const download = screen.getByRole("link", { name: "Download video" });
    await expect.element(download).toBeVisible();
    expect(new URL(download.element().getAttribute("href")!).searchParams.get("download")).toBe(
      "1",
    );
  } finally {
    await screen.unmount();
  }
});

it("keeps playback on a renewed grant and adopts it only after the current URL fails", async () => {
  const path = "/Users/tester/Downloads/demo.webm";
  grants.set("first", path);
  grants.set("second", path);
  const preview = (grant: string) => (
    <LocalVideoPreview src={path} cwd="/workspace" previewGrant={grant} />
  );
  const screen = await render(preview("first"));
  try {
    await vi.waitFor(() => expect(videoElement()?.readyState).toBeGreaterThanOrEqual(1));
    const firstSrc = videoElement()!.src;
    expect(new URL(firstSrc).searchParams.get("grant")).toBe("first");

    await screen.rerender(preview("second"));
    expect(videoElement()!.src).toBe(firstSrc);

    // The first grant expires; the next range request fails and the player
    // reconnects through the renewed grant instead of showing an error.
    grants.delete("first");
    videoElement()!.dispatchEvent(new Event("error"));
    await vi.waitFor(() =>
      expect(new URL(videoElement()!.src).searchParams.get("grant")).toBe("second"),
    );
    await vi.waitFor(() => expect(videoElement()!.readyState).toBeGreaterThanOrEqual(1));
    expect(document.querySelector(".local-image-error")).toBeNull();
  } finally {
    await screen.unmount();
  }
});

it("recovers a projectless file preview after the server invalidates its video grant", async () => {
  const path = "/Users/tester/Downloads/demo.webm";
  const screen = await render(
    <QueryClientProvider client={client}>
      <WorkspaceFilePreview workspaceRoot={null} filePath={path} />
    </QueryClientProvider>,
  );
  try {
    await vi.waitFor(() => expect(videoElement()?.readyState).toBeGreaterThanOrEqual(1));
    const video = videoElement()!;
    const oldGrant = new URL(video.src).searchParams.get("grant")!;
    grants.delete(oldGrant);
    video.dispatchEvent(new Event("error"));

    await vi.waitFor(() => expect(createLocalFilePreviewGrant).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(new URL(video.src).searchParams.get("grant")).not.toBe(oldGrant));
    await vi.waitFor(() => expect(videoElement()?.readyState).toBeGreaterThanOrEqual(1));
    expect(videoElement()).toBe(video);

    // A failed renewal must leave a real Retry action even without a project.
    const renewedGrant = new URL(video.src).searchParams.get("grant")!;
    grants.delete(renewedGrant);
    createLocalFilePreviewGrant.mockRejectedValueOnce(new Error("Preview host is reconnecting."));
    video.dispatchEvent(new Event("error"));
    await screen.getByRole("button", { name: "Retry video preview" }).click();
    await vi.waitFor(() => expect(videoElement()?.readyState).toBeGreaterThanOrEqual(1));
    expect(new URL(videoElement()!.src).searchParams.get("grant")).not.toBe(renewedGrant);
  } finally {
    await screen.unmount();
  }
});

it("shows a download card instead of streaming on desktop-frame hosts", async () => {
  configureDesktopResourceFixture();
  const onPreviewReady = vi.fn();
  const screen = await render(
    <LocalVideoPreview src="out/clip.webm" cwd="/workspace" onPreviewReady={onPreviewReady} />,
  );
  try {
    await expect
      .element(screen.getByText("Inline playback isn’t available for this host"))
      .toBeVisible();
    expect(videoElement()).toBeNull();
    expect(requests).toHaveLength(0);
    await vi.waitFor(() => expect(onPreviewReady).toHaveBeenCalledOnce());

    await screen.getByRole("link", { name: "Download video" }).click();
    await vi.waitFor(() => expect(savedUrls[0]).toMatch(/^blob:/));
    expect(requests).toHaveLength(1);
    expect(requests[0]!.searchParams.get("download")).toBe("1");
    expect(requests[0]!.searchParams.get("path")).toBe("out/clip.webm");
  } finally {
    await screen.unmount();
  }
});

it("plays markdown videos inline in a box that keeps its height when metadata loads", async () => {
  const screen = await render(
    <QueryClientProvider client={client}>
      <div style={{ width: 800 }}>
        <ChatMarkdown text="Recording: ![Demo run](out/clip.webm)" cwd="/workspace" />
      </div>
    </QueryClientProvider>,
  );
  try {
    await vi.waitFor(() => expect(inlineVideoWrapper()).not.toBeNull());
    const before = inlineVideoWrapper().getBoundingClientRect();
    expect(before.width).toBeCloseTo(420, 0);
    expect(before.height).toBeCloseTo((420 * 9) / 16, 0);

    await vi.waitFor(() => expect(inlineVideoWrapper().getAttribute("data-status")).toBe("ready"));
    const after = inlineVideoWrapper().getBoundingClientRect();
    expect(after.height).toBe(before.height);
    expect(after.width).toBe(before.width);

    const video = videoElement()!;
    expect(video.getAttribute("aria-label")).toBe("Demo run");
    expect(video.controls).toBe(true);
    expect(video.preload).toBe("metadata");
    expect(document.querySelector(".chat-markdown img, img")).toBeNull();
  } finally {
    await screen.unmount();
  }
});

it("recovers a markdown video outside the workspace through a preview grant", async () => {
  const path = "/Users/tester/Desktop/simulator-recording.webm";
  const screen = await render(
    <QueryClientProvider client={client}>
      <ChatMarkdown text={`![Simulator](${path})`} cwd="/workspace" />
    </QueryClientProvider>,
  );
  try {
    await vi.waitFor(() =>
      expect(document.querySelector(".chat-generated-video")?.getAttribute("data-status")).toBe(
        "ready",
      ),
    );
    expect(createLocalFilePreviewGrant).toHaveBeenCalledOnce();
    expect(new URL(videoElement()!.src).searchParams.get("grant")).toBe("grant-1");
  } finally {
    await screen.unmount();
  }
});

it("downloads a markdown video outside the workspace on desktop-frame hosts with a grant", async () => {
  configureDesktopResourceFixture();
  const path = "/Users/tester/Desktop/simulator-recording.webm";
  const screen = await render(
    <QueryClientProvider client={client}>
      <ChatMarkdown text={`![Simulator](${path})`} cwd="/workspace" />
    </QueryClientProvider>,
  );
  try {
    await expect
      .element(screen.getByText("Inline playback isn’t available for this host"))
      .toBeVisible();
    expect(requests).toHaveLength(0);

    await screen.getByRole("link", { name: "Download video" }).click();
    await vi.waitFor(() => expect(savedUrls[0]).toMatch(/^blob:/));
    expect(createLocalFilePreviewGrant).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.searchParams.get("download")).toBe("1");
    expect(requests[0]!.searchParams.get("grant")).toMatch(/^grant-\d+$/);
  } finally {
    await screen.unmount();
  }
});

it("shows a retryable error card for a missing markdown video", async () => {
  createLocalFilePreviewGrant.mockRejectedValueOnce(new Error("Preview file not found."));
  const screen = await render(
    <QueryClientProvider client={client}>
      <ChatMarkdown text="![Gone](out/missing.mp4)" cwd="/workspace" />
    </QueryClientProvider>,
  );
  try {
    await expect.element(screen.getByText("Couldn’t play this video")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Retry video preview" })).toBeVisible();
    expect(videoElement()).toBeNull();
  } finally {
    await screen.unmount();
  }
});
