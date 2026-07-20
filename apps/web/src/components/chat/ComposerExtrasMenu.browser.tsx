// FILE: ComposerExtrasMenu.browser.tsx
// Purpose: Verifies the composer `+` menu exposes attachment uploads and quick mode toggles.
// Layer: Browser UI test
// Depends on: vitest browser rendering helpers and the ComposerExtrasMenu component.

import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ComposerExtrasMenu } from "./ComposerExtrasMenu";

async function mountMenu(props?: {
  fastModeEnabled?: boolean;
  interactionMode?: "default" | "plan";
  supportsFastMode?: boolean;
  supportsFileAttachments?: boolean;
}) {
  const onAddPhotos = vi.fn();
  const onAddFiles = vi.fn();
  const onToggleFastMode = vi.fn();
  const onSetPlanMode = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(
    <ComposerExtrasMenu
      interactionMode={props?.interactionMode ?? "default"}
      supportsFastMode={props?.supportsFastMode ?? true}
      supportsFileAttachments={props?.supportsFileAttachments ?? false}
      fastModeEnabled={props?.fastModeEnabled ?? false}
      onAddPhotos={onAddPhotos}
      onAddFiles={onAddFiles}
      onToggleFastMode={onToggleFastMode}
      onSetPlanMode={onSetPlanMode}
    />,
    { container: host },
  );

  const cleanup = async () => {
    await screen.unmount();
    host.remove();
  };

  return {
    [Symbol.asyncDispose]: cleanup,
    cleanup,
    onAddPhotos,
    onAddFiles,
    onToggleFastMode,
    onSetPlanMode,
  };
}

describe("ComposerExtrasMenu", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("routes picked images and generic files to their composer callbacks when supported", async () => {
    await using menu = await mountMenu({ supportsFileAttachments: true });

    const input = document.querySelector<HTMLInputElement>("[data-testid='composer-photo-input']");
    expect(input).not.toBeNull();
    expect(input?.accept).toBe("");

    const files = new DataTransfer();
    files.items.add(new File(["photo"], "photo.png", { type: "image/png" }));
    files.items.add(new File(["notes"], "notes.txt", { type: "text/plain" }));
    Object.defineProperty(input, "files", {
      configurable: true,
      value: files.files,
    });
    input?.dispatchEvent(new Event("change", { bubbles: true }));

    expect(menu.onAddPhotos).toHaveBeenCalledTimes(1);
    expect(menu.onAddPhotos.mock.calls[0]?.[0]?.[0]?.name).toBe("photo.png");
    expect(menu.onAddFiles).toHaveBeenCalledTimes(1);
    expect(menu.onAddFiles.mock.calls[0]?.[0]?.[0]?.name).toBe("notes.txt");
  });

  it("shows the attachment action in the menu when supported", async () => {
    await using _ = await mountMenu({
      interactionMode: "plan",
      fastModeEnabled: true,
      supportsFileAttachments: true,
    });

    await page.getByLabelText("Composer extras").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Add attachment");
      expect(text).toContain("Plan mode");
      expect(text).toContain("Fast");
      expect(text).not.toContain("Plugins");
    });
  });

  it("wires the plan and speed controls", async () => {
    await using menu = await mountMenu({ supportsFileAttachments: true });

    await page.getByLabelText("Composer extras").click();
    await page.getByText("Plan mode").click();
    await page.getByText("Fast").click();
    await page.getByRole("menuitemradio", { name: "Fast" }).click();

    expect(menu.onSetPlanMode).toHaveBeenCalledWith(true);
    expect(menu.onToggleFastMode).toHaveBeenCalledTimes(1);
  });

  it("restricts image-only providers to images and ignores generic files", async () => {
    await using menu = await mountMenu({ supportsFileAttachments: false });

    const input = document.querySelector<HTMLInputElement>("[data-testid='composer-photo-input']");
    expect(input).not.toBeNull();
    expect(input?.accept).toBe("image/*");

    await page.getByLabelText("Composer extras").click();
    await vi.waitFor(() => {
      expect(document.body.textContent ?? "").toContain("Add image");
    });

    const files = new DataTransfer();
    files.items.add(new File(["photo"], "photo.png", { type: "image/png" }));
    files.items.add(new File(["notes"], "notes.txt", { type: "text/plain" }));
    Object.defineProperty(input, "files", {
      configurable: true,
      value: files.files,
    });
    input?.dispatchEvent(new Event("change", { bubbles: true }));

    expect(menu.onAddPhotos).toHaveBeenCalledTimes(1);
    expect(menu.onAddPhotos.mock.calls[0]?.[0]?.[0]?.name).toBe("photo.png");
    expect(menu.onAddFiles).not.toHaveBeenCalled();
  });
});
