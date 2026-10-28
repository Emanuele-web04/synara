import "../../index.css";

import { EnvironmentId, type NativeApi } from "@synara/contracts";
import { remoteResourceRoute } from "@synara/shared/remoteResources";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HttpResponse, http } from "msw";
import { setupWorker } from "msw/browser";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import ChatMarkdown from "../ChatMarkdown";
import { downloadUrlAsBlob } from "~/lib/browserDownload";
import { projectLocalPreviewGrantQueryOptions } from "~/lib/projectReactQuery";
import { readExecutionContext } from "~/lib/hosts/executionContext";
import { readWorkspaceFrame } from "~/lib/hosts/workspaceFrame";
import type { WorkspaceResourceRequester } from "~/lib/hosts/workspaceResources";
import { GeneratedMarkdownImage } from "./GeneratedMarkdownImage";

vi.mock("~/lib/hosts/executionContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/hosts/executionContext")>()),
  readExecutionContext: vi.fn(),
}));
vi.mock("~/lib/hosts/workspaceFrame", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/hosts/workspaceFrame")>()),
  readWorkspaceFrame: vi.fn(),
}));

vi.mock("~/lib/browserDownload", () => ({
  downloadUrlAsBlob: vi.fn(async ({ url }: { url: string }) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
  }),
}));

// Use screenshot-sized bytes so the owner tests exercise actual preview geometry.
const canvas = new OffscreenCanvas(1024, 256);
canvas.getContext("2d")!.fillRect(0, 0, 1024, 256);
const png = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
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
  vi.mocked(readExecutionContext).mockReset();
  vi.mocked(readWorkspaceFrame).mockReset();
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
  worker.resetHandlers();
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

// Keep the real viewport/image hook; only the parent capability and remote HTTP receiver are fixtures.
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
    // This mock supplies only the resource boundary; no unrelated controller API is invoked.
  } as unknown as NonNullable<ReturnType<typeof readWorkspaceFrame>>);
}

function scrollableImage() {
  return (
    <div data-preview-scroll style={{ height: 220, width: 400, overflow: "auto" }}>
      {image(desktopPath)}
      <div style={{ height: 1200 }} />
    </div>
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
      ).toBe(1024);
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
    client.setQueryData(
      projectLocalPreviewGrantQueryOptions({ path: desktopPath, cwd: "/Users/tester/project" })
        .queryKey,
      {
        grant: "renewed-in-file-pane",
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
      },
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(document.querySelector<HTMLImageElement>(".chat-generated-image__img")!.src).toBe(src);
  } finally {
    vi.useRealTimers();
  }
});

it.each(["expired", "host-restarted"] as const)(
  "renews a loaded desktop preview on viewport reacquisition after its grant is %s",
  async (reason) => {
    configureDesktopResourceFixture();
    const realNow = Date.now.bind(Date);
    let elapsed = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + elapsed);
    const expiry = new Map<string, number>();
    const originalGrant = createLocalFilePreviewGrant.getMockImplementation()!;
    createLocalFilePreviewGrant.mockImplementation(async (input) => {
      const grant = await originalGrant(input);
      expiry.set(grant.grant, Date.parse(grant.expiresAt));
      return grant;
    });
    worker.use(
      http.get("*/api/local-image", ({ request }) => {
        const url = new URL(request.url);
        requests.push(url);
        const grant = url.searchParams.get("grant") ?? "";
        const authorized =
          grants.get(grant) === desktopPath && (expiry.get(grant) ?? 0) > Date.now();
        return authorized
          ? new HttpResponse(png.slice(), { headers: { "Content-Type": "image/png" } })
          : new HttpResponse(null, { status: 404 });
      }),
    );
    const screen = await render(scrollableImage());
    try {
      await expectReady();
      const firstSrc = document.querySelector<HTMLImageElement>(".chat-generated-image__img")!.src;
      expect(firstSrc).toMatch(/^blob:/);
      const scroll = document.querySelector<HTMLDivElement>("[data-preview-scroll]")!;
      scroll.scrollTop = 700;
      await vi.waitFor(() =>
        expect(document.querySelector<HTMLImageElement>(".chat-generated-image__img")!.src).toMatch(
          /^data:image\/svg\+xml,/,
        ),
      );
      // Exercise actual elapsed expiry; a restart also invalidates an otherwise unexpired token.
      if (reason === "expired") elapsed = 121_000;
      else grants.clear();
      scroll.scrollTop = 0;
      await vi.waitFor(() => expect(createLocalFilePreviewGrant).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => {
        const img = document.querySelector<HTMLImageElement>(".chat-generated-image__img")!;
        expect(img.src).toMatch(/^blob:/);
        expect(img.src).not.toBe(firstSrc);
        expect(img.naturalWidth).toBe(1024);
      });
      await expectReady();
      expect(requests.filter((url) => url.searchParams.get("grant"))).toHaveLength(3);
      expect(document.querySelector(".local-image-error")).toBeNull();
    } finally {
      await screen.unmount();
      clock.mockRestore();
      createLocalFilePreviewGrant.mockImplementation(originalGrant);
    }
  },
);

it("stops automatic grant recovery when the fresh preview is also denied", async () => {
  configureDesktopResourceFixture();
  let denied = false;
  worker.use(
    http.get("*/api/local-image", ({ request }) => {
      const url = new URL(request.url);
      requests.push(url);
      const grant = url.searchParams.get("grant") ?? "";
      return !denied && grants.get(grant) === desktopPath
        ? new HttpResponse(png.slice(), { headers: { "Content-Type": "image/png" } })
        : new HttpResponse(null, { status: 404 });
    }),
  );
  const screen = await render(scrollableImage());
  try {
    await expectReady();
    const scroll = document.querySelector<HTMLDivElement>("[data-preview-scroll]")!;
    scroll.scrollTop = 700;
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLImageElement>(".chat-generated-image__img")!.src).toMatch(
        /^data:image\/svg\+xml,/,
      ),
    );
    denied = true;
    scroll.scrollTop = 0;
    await expect.element(screen.getByText("Couldn’t open this image")).toBeVisible();
    await vi.waitFor(() => expect(client.isFetching()).toBe(0));
    expect(createLocalFilePreviewGrant).toHaveBeenCalledTimes(2);
    expect(requests.filter((url) => url.searchParams.get("grant"))).toHaveLength(3);
    await screen.rerender(scrollableImage());
    expect(createLocalFilePreviewGrant).toHaveBeenCalledTimes(2);
    await expect.element(screen.getByRole("button", { name: "Retry image preview" })).toBeVisible();
  } finally {
    await screen.unmount();
  }
});

it("requests a fresh grant after HTTP denial even with an unexpired cached token", async () => {
  client.setQueryData(
    projectLocalPreviewGrantQueryOptions({ path: desktopPath, cwd: "/Users/tester/project" })
      .queryKey,
    {
      grant: "from-before-server-restart",
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    },
  );
  await render(image(desktopPath));
  await expectReady();
  expect(createLocalFilePreviewGrant).toHaveBeenCalledExactlyOnceWith({
    path: desktopPath,
    cwd: "/Users/tester/project",
  });
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
  expect(createLocalFilePreviewGrant).toHaveBeenCalledExactlyOnceWith({
    path: desktopPath,
    cwd: "/Users/tester/project",
  });
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

it("keeps a missing relative image in the error card after bounded recovery", async () => {
  const screen = await render(image("./missing.png"));
  await expect.element(screen.getByText("Couldn’t open this image")).toBeVisible();
  expect(createLocalFilePreviewGrant).toHaveBeenCalledOnce();
});

// Recover in the same message: neither new markdown nor a remount by the caller is needed.
it("retries the same relative image after the file becomes available", async () => {
  let available = false;
  worker.use(
    http.get("*/api/local-image", ({ request }) => {
      if (new URL(request.url).searchParams.get("path") !== "./pending.png") return;
      return available
        ? new HttpResponse(png.slice(), { headers: { "Content-Type": "image/png" } })
        : new HttpResponse(null, { status: 404 });
    }),
  );
  const screen = await render(image("./pending.png"));
  await expect.element(screen.getByText("Couldn’t open this image")).toBeVisible();
  available = true;
  const retry = screen.getByRole("button", { name: "Retry image preview" });
  await expect.element(retry, { timeout: 5_000 }).toBeVisible();
  await retry.click();
  await expectReady();
});

it("renews a grant lost between issuance and the preview request when Retry is pressed", async () => {
  let losesGrant = true;
  worker.use(
    http.get("*/api/local-image", ({ request }) => {
      const url = new URL(request.url);
      const grant = url.searchParams.get("grant");
      if (losesGrant && grant && grants.has(grant)) {
        // The host restarted (or the grant expired) before these image bytes were read.
        losesGrant = false;
        grants.clear();
        return new HttpResponse(null, { status: 404 });
      }
    }),
  );
  const screen = await render(image(desktopPath));
  await expect.element(screen.getByText("Couldn’t open this image")).toBeVisible();
  const retry = screen.getByRole("button", { name: "Retry image preview" });
  await expect.element(retry, { timeout: 5_000 }).toBeVisible();
  await retry.click();
  await expectReady();
});

it("uses the host's canonical path for a relative worktree image, expansion and download", async () => {
  const canonicalPath = "/Users/tester/sibling-worktree/shared %20 shot.png";
  const previousGrant = createLocalFilePreviewGrant.getMockImplementation()!;
  createLocalFilePreviewGrant.mockImplementation(async () => {
    grants.set("worktree-grant", canonicalPath);
    return {
      grant: "worktree-grant",
      canonicalPath,
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    };
  });
  try {
    const expand = vi.fn();
    const screen = await render(image("../sibling-worktree/shared%20shot.png", expand));
    await expectReady();
    await screen.getByRole("button", { name: "Expand generated image" }).click();
    await vi.waitFor(() => expect(expand).toHaveBeenCalledOnce());
    expect(new URL(expand.mock.calls[0]![0].images[0].src).searchParams.get("path")).toBe(
      canonicalPath,
    );
    await screen.getByRole("link", { name: "Download generated image" }).click();
    await vi.waitFor(() => expect(downloadUrlAsBlob).toHaveBeenCalledOnce());
    await vi.mocked(downloadUrlAsBlob).mock.results[0]?.value;
  } finally {
    createLocalFilePreviewGrant.mockImplementation(previousGrant);
  }
});

it("keeps persisted images inline and message-scoped after their original path is unavailable", async () => {
  const portraitCanvas = new OffscreenCanvas(256, 1024);
  portraitCanvas.getContext("2d")!.fillRect(0, 0, 256, 1024);
  const portrait = new Uint8Array(
    await (await portraitCanvas.convertToBlob({ type: "image/png" })).arrayBuffer(),
  );
  worker.use(
    http.get("*/api/local-image", () => new HttpResponse(null, { status: 404 })),
    http.get(
      "*/attachments/:attachmentId",
      ({ params }) =>
        new HttpResponse((params.attachmentId === "stored-before" ? png : portrait).slice(), {
          headers: { "Content-Type": "image/png" },
        }),
    ),
  );
  const sourcePath = "./literal%20.png";
  const attachment = (id: string, sizeBytes: number) => ({
    type: "image" as const,
    id,
    sourcePath,
    name: "shared shot.png",
    mimeType: "image/png",
    sizeBytes,
  });
  const screen = await render(
    <QueryClientProvider client={client}>
      <ChatMarkdown
        text="First step. ![Before](./literal%2520.png) Next step."
        cwd="/Users/tester/project"
        imageAttachments={[attachment("stored-before", png.byteLength)]}
      />
      <ChatMarkdown
        text="Another message. ![After](./literal%2520.png) Done."
        cwd="/Users/tester/another-project"
        imageAttachments={[attachment("stored-after", portrait.byteLength)]}
      />
    </QueryClientProvider>,
  );
  await vi.waitFor(() => {
    expect(
      (screen.getByRole("img", { name: "Before" }).element() as HTMLImageElement).naturalWidth,
    ).toBe(1024);
    expect(
      (screen.getByRole("img", { name: "After" }).element() as HTMLImageElement).naturalWidth,
    ).toBe(256);
  });
  expect(document.querySelectorAll("img")).toHaveLength(2);
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

it.each([
  { src: "./workspace.png", expandable: true },
  { src: "./missing.png", expandable: true },
  { src: "file:///Users/tester/Desktop/simulator%20shot.png", expandable: false },
])("lets a linked local image follow its link ($src)", async ({ src, expandable }) => {
  const expand = vi.fn();
  let releaseLoading: (() => void) | undefined;
  if (src.includes("missing")) {
    const pendingResponse = new Promise<void>((resolve) => {
      releaseLoading = resolve;
    });
    worker.use(
      http.get(
        "*/api/local-image",
        async () => {
          await pendingResponse;
          return new HttpResponse(null, { status: 404 });
        },
        { once: true },
      ),
    );
  }
  const screen = await render(
    <QueryClientProvider client={client}>
      <ChatMarkdown
        text={`[![Simulator screenshot](${src})](https://example.com/screenshot)`}
        style={{ width: 800 }}
        cwd="/Users/tester/project"
        onImageExpand={expandable ? expand : undefined}
      />
    </QueryClientProvider>,
  );
  const img = screen.getByRole("img", { name: "Simulator screenshot" });
  if (releaseLoading) {
    try {
      expect((img.element() as HTMLImageElement).complete).toBe(false);
      expect(img.element().getBoundingClientRect().width).toBeLessThanOrEqual(255);
      expect(getComputedStyle(img.element()).opacity).toBe("1");
    } finally {
      releaseLoading();
    }
  }
  await vi.waitFor(() => {
    const element = img.element() as HTMLImageElement;
    expect(element.complete).toBe(true);
    expect(element.naturalWidth).toBe(src.includes("missing") ? 0 : 1024);
  });
  const width = img.element().getBoundingClientRect().width;
  expect(width).toBeGreaterThan(0);
  expect(width).toBeLessThanOrEqual(255);
  if (!src.includes("missing")) expect(width).toBe(255);
  let cancelledBeforeNavigation: boolean | undefined;
  const observeClick = (event: MouseEvent) => {
    cancelledBeforeNavigation = event.defaultPrevented;
    // Observe browser activation without opening an external test tab.
    event.preventDefault();
  };
  document.addEventListener("click", observeClick, { once: true });
  try {
    await img.click();
  } finally {
    document.removeEventListener("click", observeClick);
  }
  expect(cancelledBeforeNavigation).toBe(false);
  expect(expand).not.toHaveBeenCalled();
  const link = screen.getByRole("link", { name: "Simulator screenshot" }).element();
  expect(link.getAttribute("href")).toBe("https://example.com/screenshot");
  expect(link.querySelector("button, a")).toBeNull();
  if (src.startsWith("file:")) {
    expect(createLocalFilePreviewGrant).toHaveBeenCalledExactlyOnceWith({
      path: desktopPath,
      cwd: "/Users/tester/project",
    });
    const url = new URL((img.element() as HTMLImageElement).src);
    expect(grants.get(url.searchParams.get("grant") ?? "")).toBe(desktopPath);
  } else if (src.includes("missing")) {
    expect(createLocalFilePreviewGrant).toHaveBeenCalledOnce();
  } else {
    expect(createLocalFilePreviewGrant).not.toHaveBeenCalled();
  }
});
