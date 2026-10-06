import "../index.css";

import { useState, type CSSProperties } from "react";
import { describe, expect, it } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import {
  SidebarHeaderNavigationControls,
  SidebarLeadingControlsDock,
  SidebarLeadingControlsSlot,
} from "./SidebarHeaderNavigationControls";
import { RouteSurfaceHeader } from "./RouteSurface";
import { SidebarProvider, useSidebar } from "./ui/sidebar";

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

function RailShell({
  compact = false,
  integrated = false,
}: {
  compact?: boolean;
  integrated?: boolean;
}) {
  const [rail, setRail] = useState<HTMLDivElement | null>(null);
  const [route, setRoute] = useState<HTMLElement | null>(null);
  const { open, isMobile } = useSidebar();
  return (
    <SidebarLeadingControlsDock
      railSlot={rail}
      routeColumn={route}
      collapsedPanelWidth={compact && !integrated ? 64 : 0}
    >
      <div ref={setRail} style={{ width: "var(--app-rail-width)", flexShrink: 0 }} />
      <div
        className="app-rail-panel"
        aria-label="Thread panel"
        style={{ width: open ? 272 : compact && !integrated ? 64 : 0, flexShrink: 0 }}
      >
        <div
          data-slot="sidebar"
          data-side="left"
          data-state={open ? "expanded" : "collapsed"}
          data-collapsible={!open && compact ? "compact" : undefined}
          data-sidebar-compact-rail={integrated ? "true" : undefined}
        />
      </div>
      {open && !isMobile ? (
        <header className="drag-region" style={{ position: "absolute", left: 90, top: 12 }}>
          <SidebarLeadingControlsSlot />
        </header>
      ) : null}
      <main ref={setRoute} className="chat-content-card relative flex-1">
        <RouteSurfaceHeader
          className={isMobile || !open ? "desktop-top-bar-traffic-light-gutter" : undefined}
        >
          <span>Inbox</span>
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
  it.each([false, true])(
    "aligns collapsed header controls and retains the compact seam (integrated=%s)",
    async (integrated) => {
      await page.viewport(1280, 800);
      const previousRuntime = document.documentElement.dataset.runtime;
      document.documentElement.dataset.runtime = "electron";
      const screen = await render(
        <SidebarProvider
          defaultOpen={false}
          data-sidebar-layout="rail"
          data-sidebar-compact-mode="true"
          style={
            integrated
              ? ({ "--sidebar-compact-reserved-width": "0px" } as CSSProperties)
              : undefined
          }
        >
          <RailShell compact integrated={integrated} />
        </SidebarProvider>,
      );
      try {
        const toggle = page.getByRole("button", { name: "Toggle thread sidebar" }).element();
        const topBar = screen.container.querySelector<HTMLElement>(".app-top-bar")!;
        const reserved = topBar.querySelector<HTMLElement>("[aria-hidden]")!;
        await expect
          .poll(() =>
            Math.abs(toggle.getBoundingClientRect().left - reserved.getBoundingClientRect().left),
          )
          .toBeLessThan(1);
        expect(toggle.getBoundingClientRect().left).toBeGreaterThanOrEqual(integrated ? 90 : 112);
        const panel = screen.container.querySelector<HTMLElement>(".app-rail-panel")!;
        const panelBorder = Number.parseFloat(getComputedStyle(panel).borderLeftWidth);
        if (integrated) expect(panelBorder).toBe(0);
        else expect(panelBorder).toBeGreaterThan(0);
        expect(
          getComputedStyle(screen.container.querySelector<HTMLElement>(".chat-content-card")!)
            .borderBottomLeftRadius,
        ).toBe("0px");
      } finally {
        await screen.unmount();
        if (previousRuntime === undefined) delete document.documentElement.dataset.runtime;
        else document.documentElement.dataset.runtime = previousRuntime;
      }
    },
  );
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
            // Electron folds overlapping drag/no-drag rectangles in document order.
            let region = "";
            for (const element of screen.container.querySelectorAll<HTMLElement>("*")) {
              const appRegion = getComputedStyle(element).getPropertyValue("app-region");
              if (appRegion !== "drag" && appRegion !== "no-drag") continue;
              const bounds = element.getBoundingClientRect();
              if (x >= bounds.left && x < bounds.right && y >= bounds.top && y < bounds.bottom) {
                region = appRegion;
              }
            }
            return region;
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
          const toggle = page
            .getByRole("button", { name: "Toggle thread sidebar" })
            .element()
            .getBoundingClientRect();
          return (
            Math.abs(toggle.left - (leading.left + 12)) + Math.abs(toggle.top - (leading.top + 12))
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
