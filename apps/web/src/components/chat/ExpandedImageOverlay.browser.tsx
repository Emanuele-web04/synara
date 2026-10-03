import "../../index.css";

import { useState } from "react";

import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { NATIVE_SURFACE_OCCLUSION_SYNC_EVENT } from "~/lib/nativeSurfaceOcclusion";
import { ExpandedImageOverlay } from "./ExpandedImageOverlay";
import { useExpandedImagePreview } from "./useExpandedImagePreview";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";

describe("ExpandedImageOverlay", () => {
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
            { src: "data:image/png;base64,first", name: "First image" },
            { src: "data:image/png;base64,second", name: "Second image" },
            { src: "data:image/png;base64,third", name: "Third image" },
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
            images: [{ src: "data:image/png;base64,preview", name: "Preview image" }],
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
});
