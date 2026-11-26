import "../../index.css";

import type { CanvasAsset, CanvasWork, DesignFrame, ThreadId } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const native = vi.hoisted(() => ({
  canvas: { getAsset: vi.fn(), setChatSelection: vi.fn() },
}));
vi.mock("../../nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../nativeApi")>()),
  ensureNativeApi: () => native,
  readNativeApi: () => undefined,
}));

import { useCanvasPreviewContext } from "./canvasAssets";
import { CanvasFrameStrip } from "./CanvasFrameStrip";
import { CanvasSelectionCard, useCanvasSelectionCard } from "./CanvasSelectionChip";
import { useCanvasEditorStore } from "./canvasStores";
import { canvasWorkQueryKey } from "./canvasWorkCache";

// A 1×1 PNG.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const sha = (char: string) => char.repeat(64);
const assets: CanvasAsset[] = [
  {
    id: "inter",
    name: "Inter",
    mimeType: "font/woff2",
    sizeBytes: 4,
    sha256: sha("a"),
    font: { family: "Inter", weight: "400", style: "normal" },
  },
  { id: "hero", name: "Hero", mimeType: "image/png", sizeBytes: 68, sha256: sha("b") },
];
const frame: DesignFrame = {
  id: "f1",
  title: "Pricing card",
  x: 0,
  y: 0,
  width: 300,
  height: 200,
  revision: 1,
  style: "background:#fff",
  layers: {
    roots: ["title", "image"],
    nodes: [
      // Only the work's own family, as agents write it: without the font it falls to serif.
      {
        id: "title",
        type: "element",
        tag: "h2",
        attributes: { style: "font-family:Inter" },
        children: ["text"],
      },
      { id: "text", type: "text", text: "Pro plan" },
      {
        id: "image",
        type: "element",
        tag: "img",
        attributes: { src: "synara-asset:hero", style: "width:40px;height:40px" },
        children: [],
      },
    ],
  },
};

function TurnCardStrip() {
  const context = useCanvasPreviewContext("work1", assets);
  return <CanvasFrameStrip frames={[frame]} context={context} />;
}

const preview = () => document.querySelector<HTMLElement>("[inert]")!.shadowRoot!;

function ComposerChip({ threadId }: { threadId: ThreadId }) {
  const card = useCanvasSelectionCard(threadId);
  return card ? <CanvasSelectionCard card={card} /> : null;
}

const serveAssets = () =>
  native.canvas.getAsset.mockImplementation(
    async ({ assetId }: { workId: string; assetId: string }) => {
      const asset = assets.find((item) => item.id === assetId)!;
      return {
        assetId,
        sha256: asset.sha256,
        mimeType: asset.mimeType,
        data: assetId === "hero" ? PNG : "d09GMg==",
      };
    },
  );

describe("canvas frame strip", () => {
  afterEach(() => native.canvas.getAsset.mockReset());

  it("draws a turn card's thumbnails with the work's fonts and images", async () => {
    serveAssets();
    const screen = await render(<TurnCardStrip />);
    try {
      // The face is fetched and the design's "Inter" maps to it, as on the canvas.
      await vi.waitFor(() =>
        expect(native.canvas.getAsset).toHaveBeenCalledWith({ workId: "work1", assetId: "inter" }),
      );
      const title = preview().querySelector("h2")!;
      expect(getComputedStyle(title).fontFamily).toContain("SynaraCanvas Inter");
      // Images load through the same asset path and show.
      await vi.waitFor(() =>
        expect(preview().querySelector("img")!.getAttribute("src")).toMatch(/^blob:/),
      );
    } finally {
      await screen.unmount();
    }
  });

  it("draws the composer's selection chip with the work's fonts too", async () => {
    serveAssets();
    native.canvas.setChatSelection.mockResolvedValue(undefined);
    const threadId = "chat1" as ThreadId;
    const work = {
      id: "work1",
      title: "Work",
      version: 3,
      kind: "work",
      folderId: null,
      projectId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: null,
      assets,
      chats: [],
      pages: [
        {
          id: "page1",
          title: "Page",
          viewport: { x: 0, y: 0, zoom: 1 },
          frames: [frame],
          comments: [],
        },
      ],
    } as unknown as CanvasWork;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(canvasWorkQueryKey("work1"), work);
    const release = useCanvasEditorStore.getState().showBeside(threadId, "work1");
    useCanvasEditorStore
      .getState()
      .setSelection("work1", "page1", [{ kind: "frame", frameId: "f1" }]);
    const screen = await render(
      <QueryClientProvider client={client}>
        <ComposerChip threadId={threadId} />
      </QueryClientProvider>,
    );
    try {
      await vi.waitFor(() => expect(document.querySelector("[inert]")).toBeTruthy());
      expect(getComputedStyle(preview().querySelector("h2")!).fontFamily).toContain(
        "SynaraCanvas Inter",
      );
      // (The face itself loads once per document; the first test already registered it.)
    } finally {
      await screen.unmount();
      release();
      useCanvasEditorStore.getState().setSelection("work1", "page1", []);
    }
  });

  it("without the work's context the thumbnail still renders, its families as written", async () => {
    const screen = await render(<CanvasFrameStrip frames={[frame]} />);
    try {
      const title = preview().querySelector("h2")!;
      expect(title.textContent).toBe("Pro plan");
      expect(getComputedStyle(title).fontFamily).not.toContain("SynaraCanvas");
      expect(preview().querySelector("img")!.hasAttribute("src")).toBe(false);
    } finally {
      await screen.unmount();
    }
  });
});
