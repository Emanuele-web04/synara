import "../index.css";

import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { AmbientRailSlot } from "~/components/chat/AmbientRailSlot";
import { SidePanelOverlay } from "~/components/chat/SidePanelOverlay";
import { notificationSurfaceClassName } from "~/components/ui/notificationSurface";
import { installGlassOverlayCutout } from "./glassOverlayCutout";

const disposers: Array<() => void> = [];
const frames = async (count = 2) => {
  for (let i = 0; i < count; i++) await new Promise(requestAnimationFrame);
};

function glassRoot() {
  document.documentElement.dataset.windowMaterial = "translucent";
  document.documentElement.dataset.windowTranslucency = "window";
  const root = document.createElement("div");
  root.style.cssText = `position:fixed;left:0;top:0;width:${Math.min(700, window.innerWidth)}px;height:500px;background:red;z-index:100`;
  document.body.append(root);
  disposers.push(() => root.remove());
  disposers.push(installGlassOverlayCutout(root));
  return root;
}

function portal(left: number, top: number, width = 120, height = 100) {
  const popup = document.createElement("div");
  popup.className = "app-popup-surface";
  popup.style.cssText = `position:fixed;left:${left}px;top:${top}px;width:${width}px;height:${height}px;pointer-events:none;z-index:200`;
  document.body.append(popup);
  disposers.push(() => popup.remove());
  return popup;
}

afterEach(() => {
  for (const dispose of disposers.toReversed()) dispose();
  disposers.length = 0;
  delete document.documentElement.dataset.windowMaterial;
  delete document.documentElement.dataset.windowTranslucency;
});

describe("glass overlay content cutouts", () => {
  it("hides content under overlapping portals, including their shared area, and restores it on close", async () => {
    const root = glassRoot();
    const first = portal(50, 50);
    first.style.borderRadius = "16px";
    const second = portal(100, 80);
    await frames();
    expect(document.elementFromPoint(51, 51)).toBe(root);
    expect(document.elementFromPoint(60, 60)).not.toBe(root);
    expect(document.elementFromPoint(120, 100)).not.toBe(root);
    expect(document.elementFromPoint(210, 170)).not.toBe(root);
    expect(document.elementFromPoint(300, 300)).toBe(root);
    first.remove();
    second.remove();
    await frames();
    expect(document.elementFromPoint(120, 100)).toBe(root);
  });

  it("retains a floating panel's cutout during its close transition and wakes after an idle reopen", async () => {
    const root = glassRoot();
    function Panel() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <div data-content="" style={{ position: "absolute", inset: 0, background: "red" }} />
          <button onClick={() => setOpen((value) => !value)}>Toggle panel</button>
          <SidePanelOverlay open={open} variant="floating" cardClassName="h-60 w-72">
            Panel
          </SidePanelOverlay>
        </>
      );
    }
    const screen = await render(<Panel />, { container: root });
    await frames();
    const content = root.querySelector<HTMLElement>("[data-content]")!;
    const surface = root.querySelector<HTMLElement>(".chat-raised-panel-surface")!;
    const toggle = root.querySelector<HTMLButtonElement>("button")!;
    const point = () => {
      const box = surface.getBoundingClientRect();
      return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    };
    toggle.click();
    await frames();
    expect(Number(getComputedStyle(surface).opacity)).toBeGreaterThan(0.5);
    expect(content.style.clipPath).not.toBe("");
    expect(point()).not.toBe(content);
    await new Promise((resolve) => setTimeout(resolve, 750));
    expect(content.style.clipPath).toBe("");
    const requestFrame = vi.spyOn(window, "requestAnimationFrame");
    try {
      content.append(document.createTextNode("More transcript content"));
      surface.setAttribute("data-git-status", "updated");
      surface.append(document.createTextNode("Hidden status update"));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(requestFrame).not.toHaveBeenCalled();
    } finally {
      requestFrame.mockRestore();
    }
    toggle.click();
    await expect.poll(() => content.style.clipPath).not.toBe("");
    await screen.unmount();
  });

  it("cuts a closed Environment panel's visible preview rail out from under the open sibling panel", async () => {
    const root = glassRoot();
    const screen = await render(
      <>
        <SidePanelOverlay
          open={false}
          variant="floating"
          className="items-end gap-3 overflow-y-auto"
          cardClassName="h-60 w-72"
          trailing={
            <AmbientRailSlot envOpen={false}>
              <div
                data-preview=""
                style={{ width: 288, height: 180, background: "red", pointerEvents: "auto" }}
              >
                Preview
              </div>
            </AmbientRailSlot>
          }
        >
          Hidden environment
        </SidePanelOverlay>
        <SidePanelOverlay open variant="floating" cardClassName="h-60 w-72">
          Project
        </SidePanelOverlay>
      </>,
      { container: root },
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    await frames();
    const preview = root.querySelector<HTMLElement>("[data-preview]")!;
    const closed = root.querySelector<HTMLElement>('[aria-hidden="true"]')!;
    const openSurface = root.querySelector<HTMLElement>(
      '[aria-hidden="false"] .chat-raised-panel-surface',
    )!;
    // Make the clipped paint region inspectable by native hit testing. This only removes
    // the closed host's interaction gate and the foreground card's hit target, not its geometry.
    closed.inert = false;
    openSurface.style.pointerEvents = "none";
    const rect = preview.getBoundingClientRect();
    const cover = openSurface.getBoundingClientRect();
    expect(rect.top).toBeLessThan(cover.bottom);
    expect(rect.x + 100).toBeLessThan(window.innerWidth);
    expect(Math.max(rect.y, cover.y) + 30).toBeLessThan(window.innerHeight);
    expect(document.elementFromPoint(rect.x + 100, Math.max(rect.y, cover.y) + 30)).not.toBe(
      preview,
    );
    await screen.unmount();
  });

  it("gives a portaled selection composer the menu material in sidebar-only glass", async () => {
    glassRoot();
    document.documentElement.dataset.windowTranslucency = "sidebar";
    const menu = portal(50, 50);
    const composer = portal(250, 50);
    composer.className = "chat-composer-surface";
    // The selection layer portals a positioned host containing the composer surface.
    const host = document.createElement("div");
    document.body.append(host);
    host.append(composer);
    disposers.push(() => host.remove());
    for (const surface of [menu, composer]) {
      surface.style.setProperty("--app-overlay-surface", "rgba(255, 255, 255, 0.55)");
      surface.style.setProperty("--app-overlay-backing", "rgba(0, 0, 0, 0.3)");
    }
    await frames();
    expect(getComputedStyle(composer).backgroundImage).toBe(getComputedStyle(menu).backgroundImage);
    expect(getComputedStyle(composer, "::before").backdropFilter).toBe("none");
  });

  it("drops dialog backing before a kept-mounted overlay fades in over the page", async () => {
    const root = glassRoot();
    const dialog = document.createElement("div");
    dialog.style.cssText =
      "position:fixed;left:40px;top:40px;width:200px;height:160px;background:white;z-index:150";
    document.body.append(dialog);
    disposers.push(() => dialog.remove());
    const popup = portal(50, 50);
    await frames();
    expect(popup.hasAttribute("data-glass-backed")).toBe(true);
    expect(root.style.clipPath).toBe("");
    popup.style.opacity = "0";
    await frames();
    dialog.remove();
    popup.style.opacity = "0.25";
    await frames();
    expect(popup.hasAttribute("data-glass-backed")).toBe(false);
    popup.style.opacity = "1";
    await frames();
    expect(root.style.clipPath).not.toBe("");
  });

  it("restores an existing inline clip when material becomes opaque or the installer is disposed", async () => {
    const root = glassRoot();
    root.style.clipPath = "inset(2px)";
    portal(50, 50);
    await frames();
    document.documentElement.dataset.windowMaterial = "opaque";
    await frames();
    expect(root.style.clipPath).toBe("inset(2px)");
    document.documentElement.dataset.windowMaterial = "translucent";
    await frames();
    expect(root.style.clipPath).not.toBe("inset(2px)");
    disposers.splice(1, 1)[0]!();
    expect(root.style.clipPath).toBe("inset(2px)");
  });

  it("keeps inline error notifications tinted and blurred on a translucent window", async () => {
    const root = glassRoot();
    const banner = document.createElement("div");
    banner.className = notificationSurfaceClassName({ compact: false, tone: "error" });
    banner.style.setProperty("--popover", "rgb(255, 255, 255)");
    banner.style.setProperty("--destructive", "rgb(255, 0, 0)");
    banner.style.setProperty("--app-overlay-surface", "rgb(0, 255, 0)");
    root.append(banner);
    await frames();
    expect(getComputedStyle(banner).backgroundImage).toBe("none");
    expect(getComputedStyle(banner).backgroundColor).toMatch(/color\(srgb 1 0\.95 0\.95\)/);
    expect(getComputedStyle(banner).backdropFilter).not.toBe("none");
  });

  it("backs an overlay rendered inside the page, which cannot be cut out from under itself", async () => {
    const root = glassRoot();
    root.id = "root";
    const portaled = portal(250, 50);
    const inPage = document.createElement("div");
    inPage.className = "app-popup-surface";
    root.append(inPage);
    for (const surface of [portaled, inPage]) {
      surface.style.setProperty("--popover", "rgb(255, 255, 255)");
      surface.style.setProperty("--app-overlay-surface", "rgba(255, 255, 255, 0.3)");
    }
    await frames();
    // The portaled overlay keeps the thin fill: the page is clipped away beneath it.
    expect(getComputedStyle(portaled).backgroundImage).not.toBe("none");
    expect(getComputedStyle(inPage).backgroundImage).toBe("none");
    expect(getComputedStyle(inPage).backgroundColor).toBe("color(srgb 1 1 1 / 0.96)");
  });
});
