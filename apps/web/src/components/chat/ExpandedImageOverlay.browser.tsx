import "../../index.css";

import { useState } from "react";

import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { EnvironmentId } from "@synara/contracts";
import { readExecutionContext, type WindowExecutionContext } from "~/lib/hosts/executionContext";
import { readWorkspaceFrame } from "~/lib/hosts/workspaceFrame";
import { createWorkspaceResourceRequester } from "~/lib/hosts/workspaceResources";
import { toAttachmentPreviewUrl } from "~/lib/wsHttpUrl";
import { NATIVE_SURFACE_OCCLUSION_SYNC_EVENT } from "~/lib/nativeSurfaceOcclusion";
import { ExpandedImageOverlay } from "./ExpandedImageOverlay";
import { useExpandedImagePreview } from "./useExpandedImagePreview";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";

vi.mock("~/lib/hosts/executionContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/hosts/executionContext")>()),
  readExecutionContext: vi.fn(),
}));
vi.mock("~/lib/hosts/workspaceFrame", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/hosts/workspaceFrame")>()),
  readWorkspaceFrame: vi.fn(),
}));

const inlineImage = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="6"/>')}`;
const canvas = new OffscreenCanvas(8, 6);
canvas.getContext("2d")!.fillRect(0, 0, 8, 6);
const imageBytes = new Uint8Array(
  await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer(),
);
const imageResponse = () =>
  new Response(imageBytes.slice(), { headers: { "Content-Type": "image/png" } });

/** Keep the real typed parent/child request path while substituting only host HTTP responses. */
function remoteCapability(fetchResponse: typeof fetch) {
  const controller = {
    environmentId: EnvironmentId.makeUnsafe("controller"),
    label: "Controller",
    platform: { os: "darwin" as const, arch: "arm64" as const },
    serverVersion: "fixture",
    capabilities: { repositoryIdentity: true },
  };
  const execution = { ...controller, environmentId: EnvironmentId.makeUnsafe("mini") };
  const context: WindowExecutionContext = {
    controller,
    execution,
    remoteHostId: "host-mini",
    remote: {
      environmentId: execution.environmentId,
      accountAuthority: "https://account.example",
      userId: "fixture-user",
      organizationId: "fixture-org",
      channel: "beta",
    },
  };
  const lifetime = new AbortController();
  const requestResource = createWorkspaceResourceRequester({
    environmentId: execution.environmentId,
    isAvailable: () => !lifetime.signal.aborted,
    subscribe: () => () => {},
    resourceUrl: (reference) => {
      if (reference.resource.kind !== "attachment") throw new Error("Unexpected resource");
      return `https://host.example/${reference.resource.attachmentId}`;
    },
    fetch: fetchResponse,
    signal: lifetime.signal,
  });
  vi.mocked(readExecutionContext).mockReturnValue(context);
  vi.mocked(readWorkspaceFrame).mockReturnValue({
    host: { hostId: context.remoteHostId, executionScope: context.remote },
    controller: { desktop: true, requestResource },
  } as unknown as NonNullable<ReturnType<typeof readWorkspaceFrame>>);
  return {
    source: (id: string) => toAttachmentPreviewUrl(`/attachments/${id}`),
    dispose: () => lifetime.abort(),
  };
}

describe("ExpandedImageOverlay", () => {
  beforeEach(() => {
    vi.mocked(readExecutionContext).mockReset();
    vi.mocked(readWorkspaceFrame).mockReset();
  });
  it("consumes Escape for the image before dismissing its owning draft dialog", async () => {
    function DraftDialog() {
      const [open, setOpen] = useState(true);
      const preview = useExpandedImagePreview();
      return (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogPopup>
            <DialogTitle>New task</DialogTitle>
            <input aria-label="Task draft" defaultValue="Keep my draft" />
            <button
              type="button"
              onClick={() =>
                preview.setExpandedImage({
                  images: [{ src: `${window.location.origin}/synara.png`, name: "Attachment" }],
                  index: 0,
                })
              }
            >
              Preview attachment
            </button>
            <ExpandedImageOverlay
              expandedImage={preview.expandedImage}
              onClose={preview.closeExpandedImage}
              onNavigate={preview.navigateExpandedImage}
            />
          </DialogPopup>
        </Dialog>
      );
    }
    const screen = await render(<DraftDialog />);
    try {
      await page.getByRole("button", { name: "Preview attachment" }).click();
      await expect
        .element(page.getByRole("dialog", { name: "Expanded image preview" }))
        .toBeInTheDocument();
      await userEvent.keyboard("{Escape}");
      await expect
        .element(page.getByRole("dialog", { name: "Expanded image preview" }))
        .not.toBeInTheDocument();
      await expect.element(page.getByRole("dialog", { name: "New task" })).toBeInTheDocument();
      await expect
        .element(page.getByRole("textbox", { name: "Task draft" }))
        .toHaveValue("Keep my draft");
      await userEvent.keyboard("{Escape}");
      await expect.element(page.getByRole("dialog", { name: "New task" })).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders the selected image and dispatches previous, next, and close", async () => {
    const onClose = vi.fn();
    const onNavigate = vi.fn();
    const screen = await render(
      <ExpandedImageOverlay
        expandedImage={{
          images: [
            { src: inlineImage, name: "First image" },
            { src: inlineImage, name: "Second image" },
            { src: inlineImage, name: "Third image" },
          ],
          index: 1,
        }}
        onClose={onClose}
        onNavigate={onNavigate}
      />,
    );

    try {
      await expect.element(page.getByRole("img", { name: "Second image" })).toBeInTheDocument();
      await expect.element(page.getByText("Second image (2/3)")).toBeInTheDocument();

      await page.getByRole("button", { name: "Previous image" }).click();
      await page.getByRole("button", { name: "Next image" }).click();
      document
        .querySelector<HTMLButtonElement>('button[aria-label="Close image preview"]')
        ?.click();

      expect(onNavigate).toHaveBeenNthCalledWith(1, -1);
      expect(onNavigate).toHaveBeenNthCalledWith(2, 1);
      expect(onClose).toHaveBeenCalledOnce();
    } finally {
      await screen.unmount();
    }
  });

  it("signals native surfaces when the overlay opens and closes", async () => {
    const onOcclusionChange = vi.fn();
    window.addEventListener(NATIVE_SURFACE_OCCLUSION_SYNC_EVENT, onOcclusionChange);
    const screen = await render(
      <ExpandedImageOverlay expandedImage={null} onClose={vi.fn()} onNavigate={vi.fn()} />,
    );

    try {
      expect(onOcclusionChange).not.toHaveBeenCalled();
      await expect
        .element(page.getByRole("dialog", { name: "Expanded image preview" }))
        .not.toBeInTheDocument();

      await screen.rerender(
        <ExpandedImageOverlay
          expandedImage={{
            images: [{ src: inlineImage, name: "Preview image" }],
            index: 0,
          }}
          onClose={vi.fn()}
          onNavigate={vi.fn()}
        />,
      );
      expect(onOcclusionChange).toHaveBeenCalledTimes(1);

      await screen.rerender(
        <ExpandedImageOverlay expandedImage={null} onClose={vi.fn()} onNavigate={vi.fn()} />,
      );
      expect(onOcclusionChange).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener(NATIVE_SURFACE_OCCLUSION_SYNC_EVENT, onOcclusionChange);
      await screen.unmount();
    }
  });
  it.each([403, 404])(
    "shows the existing error card for a host %s and retries the same image",
    async (status) => {
      const fetchResponse = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response("Unavailable", { status }))
        .mockImplementation(async () => imageResponse());
      const fixture = remoteCapability(fetchResponse);
      const source = fixture.source(`att_v2_retry_${status}`);
      const screen = await render(
        <ExpandedImageOverlay
          expandedImage={{ images: [{ src: source, name: "Remote screenshot" }], index: 0 }}
          onClose={vi.fn()}
          onNavigate={vi.fn()}
        />,
      );
      try {
        await expect.element(page.getByText("Couldn’t open this image")).toBeVisible();
        await expect
          .element(page.getByRole("link", { name: "Download image" }))
          .toHaveAttribute("href", source);
        await page.getByRole("button", { name: "Retry image preview" }).click();
        await vi.waitFor(() => {
          const image = document.querySelector<HTMLImageElement>('img[alt="Remote screenshot"]');
          expect(image?.src).toMatch(/^blob:/);
          expect(image?.naturalWidth).toBe(8);
        });
        await expect.element(page.getByText("Couldn’t open this image")).not.toBeInTheDocument();
        expect(fetchResponse).toHaveBeenCalledTimes(2);
      } finally {
        await screen.unmount();
        fixture.dispose();
      }
    },
  );

  it("shows the error card when successful host bytes cannot decode as an image", async () => {
    const fixture = remoteCapability(
      vi.fn(
        async () => new Response("Not PNG bytes", { headers: { "Content-Type": "image/png" } }),
      ),
    );
    const screen = await render(
      <ExpandedImageOverlay
        expandedImage={{
          images: [{ src: fixture.source("att_v2_decode"), name: "Damaged screenshot" }],
          index: 0,
        }}
        onClose={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );
    try {
      await expect.element(page.getByText("Couldn’t open this image")).toBeVisible();
      await expect.element(page.getByRole("button", { name: "Retry image preview" })).toBeVisible();
    } finally {
      await screen.unmount();
      fixture.dispose();
    }
  });

  it("keeps navigation and close usable after a failed image, without carrying its error to the next one", async () => {
    const fetchResponse = vi.fn<typeof fetch>(async (input) =>
      String(input).endsWith("att_v2_missing")
        ? new Response("Missing", { status: 404 })
        : imageResponse(),
    );
    const fixture = remoteCapability(fetchResponse);
    const images = [
      { src: fixture.source("att_v2_missing"), name: "Missing image" },
      { src: fixture.source("att_v2_present"), name: "Available image" },
    ];
    const onClose = vi.fn();
    function Gallery() {
      const [index, setIndex] = useState(0);
      return (
        <ExpandedImageOverlay
          expandedImage={{ images, index }}
          onClose={onClose}
          onNavigate={(direction) => setIndex((index) => index + direction)}
        />
      );
    }
    const screen = await render(<Gallery />);
    try {
      await expect.element(page.getByText("Couldn’t open this image")).toBeVisible();
      await page.getByRole("button", { name: "Next image" }).click();
      await vi.waitFor(() =>
        expect(
          document.querySelector<HTMLImageElement>('img[alt="Available image"]')?.naturalWidth,
        ).toBe(8),
      );
      await expect.element(page.getByText("Available image (2/2)")).toBeVisible();
      await expect.element(page.getByText("Couldn’t open this image")).not.toBeInTheDocument();
      await page.getByRole("button", { name: "Previous image" }).click();
      await expect.element(page.getByText("Couldn’t open this image")).toBeVisible();
      document
        .querySelector<HTMLButtonElement>('button[aria-label="Close image preview"]')
        ?.click();
      expect(onClose).toHaveBeenCalledOnce();
      expect(fetchResponse).toHaveBeenCalledTimes(3);
    } finally {
      await screen.unmount();
      fixture.dispose();
    }
  });
});
