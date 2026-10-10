import "../index.css";

import { useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import {
  SidebarHeaderNavigationControls,
  SidebarLeadingControlsDock,
  SidebarLeadingControlsSlot,
} from "./SidebarHeaderNavigationControls";
import { RouteSurfaceHeader } from "./RouteSurface";
import { SurfaceContentTabs } from "./chat/SurfaceContentTabs";
import { SidebarProvider, useSidebar } from "./ui/sidebar";

vi.mock("~/env", () => ({ isElectron: true }));

function nativeDragRegionAt(container: HTMLElement, x: number, y: number) {
  // Electron folds border-box drag/no-drag rectangles in document order, even
  // when an ancestor clips a placeholder with overflow: hidden.
  let region = "";
  for (const element of container.querySelectorAll<HTMLElement>("*")) {
    const appRegion = getComputedStyle(element).getPropertyValue("app-region");
    if (appRegion !== "drag" && appRegion !== "no-drag") continue;
    const bounds = element.getBoundingClientRect();
    if (x >= bounds.left && x < bounds.right && y >= bounds.top && y < bounds.bottom) {
      region = appRegion;
    }
  }
  return region;
}

function Shell({ vertical = false }: { vertical?: boolean }) {
  const [rail, setRail] = useState<HTMLDivElement | null>(null);
  const [route, setRoute] = useState<HTMLElement | null>(null);
  const { open } = useSidebar();
  return (
    <SidebarLeadingControlsDock railSlot={rail} routeColumn={route}>
      <div ref={setRail} style={{ width: 48, flexShrink: 0 }} />
      {open ? (
        <header style={{ position: "absolute", left: 60, top: 12 }}>
          <SidebarLeadingControlsSlot />
        </header>
      ) : null}
      <main ref={setRoute} style={{ display: "flex", flexDirection: vertical ? "column" : "row" }}>
        {["Leading", "Other"].map((name) => (
          <section key={name} aria-label={`${name} pane`} style={{ width: 400, height: 200 }}>
            <header style={{ display: "flex", padding: 12 }}>
              <SidebarHeaderNavigationControls />
            </header>
            <input aria-label={`${name} composer`} />
          </section>
        ))}
      </main>
    </SidebarLeadingControlsDock>
  );
}

function RailShell({ threadTabs }: { threadTabs?: ReactNode }) {
  const [rail, setRail] = useState<HTMLDivElement | null>(null);
  const [route, setRoute] = useState<HTMLElement | null>(null);
  const { open, isMobile } = useSidebar();
  return (
    <SidebarLeadingControlsDock railSlot={rail} routeColumn={route}>
      <div ref={setRail} style={{ width: 48, flexShrink: 0 }} />
      <div
        className="app-rail-panel"
        aria-label="Thread panel"
        style={{ width: open ? 272 : 0, flexShrink: 0 }}
      >
        <div data-slot="sidebar" data-side="left" data-state={open ? "expanded" : "collapsed"} />
      </div>
      {open && !isMobile ? (
        <header
          className="drag-region"
          style={{
            position: "absolute",
            left: 90,
            top: 12,
            width: 200,
            height: 44,
            display: "flex",
            alignItems: "center",
          }}
        >
          <SidebarLeadingControlsSlot />
        </header>
      ) : null}
      <main ref={setRoute} className="chat-content-card relative min-w-0 flex-1">
        <RouteSurfaceHeader
          className={isMobile || !open ? "desktop-top-bar-traffic-light-gutter" : undefined}
        >
          {threadTabs ?? <span>Inbox</span>}
        </RouteSurfaceHeader>
      </main>
    </SidebarLeadingControlsDock>
  );
}

async function renderShell(vertical = false) {
  await page.viewport(1280, 800);
  return render(
    <SidebarProvider defaultOpen={false}>
      <Shell vertical={vertical} />
    </SidebarProvider>,
  );
}

describe("sidebar leading controls dock", () => {
  it("keeps clipped thread tabs from excluding the chrome beside their scroll viewport", async () => {
    await page.viewport(1280, 800);
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const screen = await render(
      <SidebarProvider defaultOpen={false} data-sidebar-layout="rail">
        <RailShell
          threadTabs={
            <SurfaceContentTabs
              ariaLabel="Open threads"
              activeKey="0"
              onMove={vi.fn()}
              tabs={Array.from({ length: 18 }, (_, index) => ({
                key: String(index),
                title: `Thread ${index + 1}`,
                icon: <span>T</span>,
                onSelect,
                onClose,
              }))}
            />
          }
        />
      </SidebarProvider>,
    );
    try {
      const strip = screen.container.querySelector<HTMLElement>(".scroll-fade-x")!;
      expect(strip.scrollWidth).toBeGreaterThan(strip.clientWidth);
      for (const position of [1, 0, 0.5]) {
        strip.scrollLeft = position * (strip.scrollWidth - strip.clientWidth);
        await expect
          .poll(() => {
            const rect = strip.getBoundingClientRect();
            const y = rect.top + rect.height / 2;
            // Clipped tabs add the overflow menu button right after the strip; the chrome
            // past that control must stay draggable.
            const trailing =
              screen.container.querySelector<HTMLElement>("[aria-label$='more tabs']") ?? strip;
            return [
              nativeDragRegionAt(screen.container, rect.left - 6, y),
              nativeDragRegionAt(screen.container, trailing.getBoundingClientRect().right + 6, y),
            ];
          })
          .toEqual(["drag", "drag"]);
      }
      const rect = strip.getBoundingClientRect();
      const visibleTab = Array.from(strip.querySelectorAll<HTMLElement>("[data-surface-tab]")).find(
        (tab) => {
          const bounds = tab.getBoundingClientRect();
          return bounds.left >= rect.left && bounds.right <= rect.right;
        },
      )!;
      const bounds = visibleTab.getBoundingClientRect();
      expect(
        nativeDragRegionAt(
          screen.container,
          bounds.left + bounds.width / 2,
          bounds.top + bounds.height / 2,
        ),
      ).toBe("no-drag");
      await userEvent.click(visibleTab.querySelector("button")!);
      expect(onSelect).toHaveBeenCalledOnce();
      await userEvent.click(visibleTab.querySelectorAll("button")[1]!);
      expect(onClose).toHaveBeenCalledOnce();
    } finally {
      await screen.unmount();
    }
  });

  it.each([1, 3])("keeps unused header space draggable with %s thread tabs", async (count) => {
    await page.viewport(1280, 800);
    const screen = await render(
      <SidebarProvider defaultOpen={false} data-sidebar-layout="rail">
        <RailShell
          threadTabs={
            <SurfaceContentTabs
              ariaLabel="Open threads"
              activeKey="0"
              tabs={Array.from({ length: count }, (_, index) => ({
                key: String(index),
                title: `Thread ${index + 1}`,
                icon: <span>T</span>,
                onSelect: () => {},
              }))}
            />
          }
        />
      </SidebarProvider>,
    );
    try {
      const last = screen.container.querySelector<HTMLElement>("[data-surface-tab]:last-child")!;
      const rect = last.getBoundingClientRect();
      expect(rect.width).toBeCloseTo(Number.parseFloat(getComputedStyle(last).flexBasis), 0);
      expect(nativeDragRegionAt(screen.container, rect.right + 8, rect.top + rect.height / 2)).toBe(
        "drag",
      );
    } finally {
      await screen.unmount();
    }
  });

  it("excludes the docked toggle from the host header's native drag region", async () => {
    await page.viewport(1280, 800);
    const screen = await render(
      <SidebarProvider defaultOpen data-sidebar-layout="rail">
        <RailShell />
      </SidebarProvider>,
    );
    try {
      const toggle = page.getByRole("button", { name: "Toggle thread sidebar" });
      for (let count = 0; count < 3; count += 1) {
        await expect
          .poll(() => {
            const rect = toggle.element().getBoundingClientRect();
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            return nativeDragRegionAt(screen.container, x, y);
          })
          .toBe("no-drag");
        await toggle.click();
        await expect
          .element(screen.container.querySelector<HTMLElement>('[data-slot="sidebar"]')!)
          .toHaveAttribute("data-state", count % 2 === 0 ? "collapsed" : "expanded");
      }
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the empty space after the navigation arrows draggable with either panel state", async () => {
    await page.viewport(1280, 800);
    const screen = await render(
      <SidebarProvider defaultOpen data-sidebar-layout="rail">
        <RailShell />
      </SidebarProvider>,
    );
    try {
      const toggle = page.getByRole("button", { name: "Toggle thread sidebar" });
      for (let count = 0; count < 3; count += 1) {
        await expect
          .poll(() => {
            const forward = page.getByRole("button", { name: "Forward" }).element();
            const rect = forward.getBoundingClientRect();
            return {
              after: nativeDragRegionAt(
                screen.container,
                rect.right + 6,
                rect.top + rect.height / 2,
              ),
              below: nativeDragRegionAt(
                screen.container,
                rect.left + rect.width / 2,
                rect.bottom + 2,
              ),
            };
          })
          .toEqual({ after: "drag", below: "drag" });
        for (const name of ["Toggle thread sidebar", "Back", "Forward"]) {
          const rect = page
            .getByRole("button", { name, exact: true })
            .element()
            .getBoundingClientRect();
          expect(
            nativeDragRegionAt(
              screen.container,
              rect.left + rect.width / 2,
              rect.top + rect.height / 2,
            ),
          ).toBe("no-drag");
        }
        await toggle.click();
        await expect
          .element(screen.container.querySelector<HTMLElement>('[data-slot="sidebar"]')!)
          .toHaveAttribute("data-state", count % 2 === 0 ? "collapsed" : "expanded");
      }
    } finally {
      await screen.unmount();
    }
  });

  it("does not exclude the clipped route-header placeholder when the panel is open", async () => {
    await page.viewport(1280, 800);
    const screen = await render(
      <SidebarProvider defaultOpen data-sidebar-layout="rail">
        <RailShell />
      </SidebarProvider>,
    );
    try {
      const header = screen.container.querySelector<HTMLElement>(".app-top-bar")!;
      const rect = header.getBoundingClientRect();
      expect(nativeDragRegionAt(screen.container, rect.left + 60, rect.top + rect.height / 2)).toBe(
        "drag",
      );
    } finally {
      await screen.unmount();
    }
  });

  it("settles header controls, corners, and panel edges immediately with reduced motion", async () => {
    // Vitest's provider-neutral CDP type is empty; type only the Playwright
    // protocol operation used here without loading its global DOM augmentation.
    const protocol = cdp() as {
      send(
        method: "Emulation.setEmulatedMedia",
        params: {
          features: { name: string; value: string }[];
        },
      ): Promise<void>;
    };
    await protocol.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    await page.viewport(1280, 800);
    const previousRuntime = document.documentElement.dataset.runtime;
    document.documentElement.dataset.runtime = "electron";
    const screen = await render(
      <SidebarProvider defaultOpen data-sidebar-layout="rail">
        <RailShell />
      </SidebarProvider>,
    );
    try {
      expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
      const toggle = page.getByRole("button", { name: "Toggle thread sidebar" }).element();
      await page.getByRole("button", { name: "Toggle thread sidebar" }).click();
      const topBar = screen.container.querySelector<HTMLElement>(".app-top-bar")!;
      const card = screen.container.querySelector<HTMLElement>(".chat-content-card")!;
      const panel = screen.container.querySelector<HTMLElement>(".app-rail-panel")!;
      expect(topBar.getAnimations()).toHaveLength(0);
      expect(card.getAnimations({ subtree: true })).toHaveLength(0);
      expect(panel.getAnimations()).toHaveLength(0);
      const reserved = topBar.querySelector<HTMLElement>("[aria-hidden]")!;
      expect(
        Math.abs(toggle.getBoundingClientRect().left - reserved.getBoundingClientRect().left),
      ).toBeLessThan(1);
      expect(getComputedStyle(panel).borderLeftWidth).toBe("0px");
      await page.getByRole("button", { name: "Toggle thread sidebar" }).click();
      expect(topBar.getAnimations()).toHaveLength(0);
      expect(card.getAnimations({ subtree: true })).toHaveLength(0);
      expect(panel.getAnimations()).toHaveLength(0);
      expect(page.getByRole("button", { name: "Toggle thread sidebar" }).element()).toBe(toggle);
    } finally {
      await screen.unmount();
      if (previousRuntime === undefined) delete document.documentElement.dataset.runtime;
      else document.documentElement.dataset.runtime = previousRuntime;
      await protocol.send("Emulation.setEmulatedMedia", { features: [] });
    }
  });

  it.each([false, true])("stays over the leading split header (vertical=%s)", async (vertical) => {
    const screen = await renderShell(vertical);
    try {
      const leading = page
        .getByRole("region", { name: "Leading pane" })
        .element()
        .getBoundingClientRect();
      await expect
        .poll(() => {
          const cluster = page
            .getByRole("button", { name: "Toggle thread sidebar" })
            .element()
            .parentElement!.getBoundingClientRect();
          return (
            Math.abs(cluster.left - (leading.left + 12)) +
            Math.abs(cluster.top - (leading.top + 12))
          );
        })
        .toBeLessThan(1);
      expect(page.getByRole("button", { name: "Toggle thread sidebar" }).all()).toHaveLength(1);
    } finally {
      await screen.unmount();
    }
  });

  it("reaches the visible leading controls before the pane composers with Tab", async () => {
    const screen = await renderShell();
    try {
      document.body.tabIndex = -1;
      document.body.focus();
      await userEvent.tab();
      expect(document.activeElement).toBe(
        page.getByRole("button", { name: "Toggle thread sidebar" }).element(),
      );
      await userEvent.tab();
      expect(document.activeElement).toBe(
        page.getByRole("textbox", { name: "Leading composer" }).element(),
      );
    } finally {
      document.body.removeAttribute("tabindex");
      await screen.unmount();
    }
  });

  it("keeps the same focused controls and settled position across panel toggles", async () => {
    const screen = await renderShell();
    try {
      const toggle = page.getByRole("button", { name: "Toggle thread sidebar" }).element();
      for (let count = 0; count < 4; count += 1) {
        await page.getByRole("button", { name: "Toggle thread sidebar" }).click();
        expect(page.getByRole("button", { name: "Toggle thread sidebar" }).element()).toBe(toggle);
        expect(document.activeElement).toBe(toggle);
        await expect.poll(() => toggle.getBoundingClientRect().left).toBeCloseTo(60, 0);
      }
    } finally {
      await screen.unmount();
    }
  });
});
