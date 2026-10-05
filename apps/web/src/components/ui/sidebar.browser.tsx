import "../../index.css";

import { useState } from "react";
import { createPortal } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { DISCLOSURE_TRANSITION_MS } from "~/lib/disclosureMotion";
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "./preview-card";
import { AppRailPortal, AppRailSlotProvider, railItemGlyphs } from "../AppRail";
import { ProviderIcon } from "../ProviderIcon";
import { installGlassOverlayCutout } from "~/lib/glassOverlayCutout";

import {
  Sidebar,
  SidebarContent,
  SidebarHeaderTrigger,
  SidebarProvider,
  SidebarTrigger,
  SIDEBAR_OFFCANVAS_MOTION_CLASS,
  useSidebar,
} from "./sidebar";

function Controls({ name }: { name: string }) {
  const { state } = useSidebar();
  return (
    <>
      <SidebarTrigger aria-label={`Toggle ${name}`} />
      <output aria-label={`${name} state`}>{state}</output>
    </>
  );
}

function ControlledSidebar() {
  const [open, setOpen] = useState(true);
  return (
    <SidebarProvider open={open} onOpenChange={setOpen}>
      <Controls name="right" />
    </SidebarProvider>
  );
}

function IntegratedRailShell({ compactPreview = false }: { compactPreview?: boolean }) {
  const { open } = useSidebar();
  const [rail, setRail] = useState<HTMLDivElement | null>(null);
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
  const item = (id: "home" | "settings") => ({
    id,
    glyphs: railItemGlyphs(id),
    label: id === "home" ? "Home" : "Settings",
    active: id === "home",
    badge: null,
    onSelect: vi.fn(),
  });
  return (
    <AppRailSlotProvider value={rail} compactThreadSlotRef={!open ? setAnchor : undefined}>
      <div data-sidebar-preview-host className="flex min-h-0 shrink-0">
        <div ref={setRail} className="flex shrink-0" />
        <div className="app-rail-panel relative flex shrink-0">
          <Sidebar
            collapsible="compact"
            compactInRail
            compactPreview={compactPreview}
            compactAnchor={anchor}
            transparentSurface
          >
            <AppRailPortal items={[item("home")]} shortcuts={[]} bottomItems={[item("settings")]} />
            <SidebarContent>
              <div
                data-slot="sidebar-panel-controls"
                className="flex items-center gap-1 pt-1.5 pb-1 pr-2.5 pl-1.5"
              >
                <SidebarHeaderTrigger data-slot="sidebar-compact-trigger" className="hidden" />
                <strong data-testid="rail-panel-title">Synara</strong>
              </div>
              {(["codex", "claudeAgent", "cursor"] as const).map((provider) => (
                <button
                  key={provider}
                  data-slot="activity-thread-button"
                  className="w-full shrink-0"
                  aria-label={`${provider} thread`}
                >
                  <span data-slot="activity-thread-identity" className="flex items-center gap-2">
                    <span data-slot="sidebar-thread-provider">
                      <ProviderIcon provider={provider} />
                    </span>
                    <span data-slot="sidebar-thread-title">{provider} thread</span>
                  </span>
                </button>
              ))}
            </SidebarContent>
          </Sidebar>
        </div>
      </div>
      <main data-testid="integrated-main" className="min-w-0 flex-1">
        <SidebarTrigger aria-label="Toggle integrated sidebar" />
      </main>
    </AppRailSlotProvider>
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("sidebar toggles", () => {
  it("keeps the integrated compact list usable until the sidebar toggle is selected", async () => {
    await page.viewport(1280, 800);
    const screen = await render(
      <SidebarProvider defaultOpen={false}>
        <IntegratedRailShell />
      </SidebarProvider>,
    );
    try {
      const panel = screen.container.querySelector<HTMLElement>('[data-slot="sidebar-container"]')!;
      const gap = screen.container.querySelector<HTMLElement>('[data-slot="sidebar-gap"]')!;
      const rail = screen.getByRole("navigation", { name: "Primary" }).element();
      const collapsedWidth = rail.getBoundingClientRect().width;
      const thread = screen.getByRole("button", { name: "codex thread", exact: true });
      await thread.hover();
      await new Promise((resolve) => setTimeout(resolve, 1100));
      expect(panel.getBoundingClientRect().width).toBe(collapsedWidth);
      await thread.click();
      await userEvent.keyboard("{Tab}");
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "claudeAgent thread", exact: true }).element(),
      );
      expect(panel.getBoundingClientRect().width).toBe(collapsedWidth);
      expect(gap.getBoundingClientRect().width).toBe(0);
      await screen.getByRole("button", { name: "Toggle integrated sidebar" }).click();
      await expect.poll(() => gap.getBoundingClientRect().width).toBe(256);
      await screen.getByRole("button", { name: "Toggle integrated sidebar" }).click();
      await expect.poll(() => gap.getBoundingClientRect().width).toBe(0);
      await thread.hover();
      await new Promise((resolve) => setTimeout(resolve, 1100));
      expect(panel.getBoundingClientRect().width).toBe(collapsedWidth);
    } finally {
      await screen.unmount();
    }
  });
  it("lets users click compact icons and cross the rail before a sustained hover opens it", async () => {
    await page.viewport(1280, 800);
    const onSelect = vi.fn();
    const screen = await render(
      <SidebarProvider defaultOpen={false}>
        <Sidebar collapsible="compact">
          <button type="button" className="w-full" onClick={onSelect}>
            Quick conversation
          </button>
        </Sidebar>
        <main className="flex-1" data-testid="quick-hover-main">
          Chat
        </main>
      </SidebarProvider>,
    );
    try {
      const sidebar = screen.container.querySelector<HTMLElement>('[data-slot="sidebar"]')!;
      const button = screen.getByRole("button", { name: "Quick conversation" });
      await button.hover();
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(sidebar.dataset.sidebarPreview).not.toBe("true");
      await button.click();
      expect(onSelect).toHaveBeenCalledOnce();
      expect(sidebar.dataset.sidebarPreview).not.toBe("true");
      await screen.getByTestId("quick-hover-main").hover();
      await new Promise((resolve) => setTimeout(resolve, 800));
      expect(sidebar.dataset.sidebarPreview).not.toBe("true");
      await button.hover();
      await expect.poll(() => sidebar.dataset.sidebarPreview).toBe("true");
    } finally {
      await screen.unmount();
    }
  });
  it.each([
    { dark: false, scope: "none" },
    { dark: true, scope: "none" },
    { dark: false, scope: "sidebar" },
    { dark: true, scope: "sidebar" },
    { dark: false, scope: "window" },
    { dark: true, scope: "window" },
  ])(
    "preserves configured appearance in the hover preview (dark=$dark, glass=$scope)",
    async ({ dark, scope }) => {
      await page.viewport(1280, 800);
      const html = document.documentElement;
      const savedClass = html.className;
      const savedScope = html.getAttribute("data-window-translucency");
      const savedMaterial = html.getAttribute("data-window-material");
      html.classList.toggle("dark", dark);
      html.dataset.windowTranslucency = scope;
      html.dataset.windowMaterial = scope === "none" ? "opaque" : "translucent";
      const root = document.createElement("div");
      root.style.cssText = "position:fixed;inset:0";
      document.body.append(root);
      const dispose = installGlassOverlayCutout(root);
      const screen = await render(
        <SidebarProvider
          defaultOpen
          data-sidebar-layout="rail"
          style={
            {
              "--color-background-surface": "rgb(34, 46, 58)",
              "--popover": "rgb(200, 100, 60)",
            } as import("react").CSSProperties
          }
        >
          <IntegratedRailShell compactPreview />
        </SidebarProvider>,
        { container: root },
      );
      try {
        const host = root.querySelector<HTMLElement>(".app-rail-panel")!;
        const surface = root.querySelector<HTMLElement>('[data-slot="sidebar-inner"]')!;
        const main = page.getByTestId("integrated-main").element() as HTMLElement;
        const title = page.getByTestId("rail-panel-title").element();
        const normal = getComputedStyle(host);
        const expected = {
          background: normal.backgroundColor,
          border: normal.borderLeftWidth,
          radius: normal.borderTopLeftRadius,
          shadow: normal.boxShadow,
          titleOffset: title.getBoundingClientRect().left - host.getBoundingClientRect().left,
          font: getComputedStyle(title).fontFamily,
          fontSize: getComputedStyle(title).fontSize,
        };
        await page.getByRole("button", { name: "Toggle integrated sidebar" }).click();
        await expect
          .poll(
            () =>
              root.querySelector<HTMLElement>('[data-slot="sidebar-gap"]')!.getBoundingClientRect()
                .width,
          )
          .toBe(0);
        await page.getByRole("button", { name: "codex thread", exact: true }).hover();
        await expect
          .poll(
            () =>
              root
                .querySelector<HTMLElement>('[data-slot="sidebar-container"]')!
                .getBoundingClientRect().width,
          )
          .toBe(256);
        const preview = getComputedStyle(surface);
        expect(preview.backgroundColor).toBe(expected.background);
        expect(preview.borderLeftWidth).toBe(expected.border);
        expect(preview.borderTopLeftRadius).toBe(expected.radius);
        expect(preview.boxShadow).toBe(expected.shadow);
        expect(
          Math.abs(
            title.getBoundingClientRect().left -
              surface.getBoundingClientRect().left -
              expected.titleOffset,
          ),
        ).toBeLessThan(1);
        expect(getComputedStyle(title).fontFamily).toBe(expected.font);
        expect(getComputedStyle(title).fontSize).toBe(expected.fontSize);
        expect(root.style.clipPath).toBe("");
        if (scope === "window") {
          await expect.poll(() => main.style.clipPath).not.toBe("");
          const bounds = surface.getBoundingClientRect();
          expect(
            document.elementsFromPoint(
              bounds.left + bounds.width / 2,
              bounds.top + bounds.height / 2,
            ),
          ).not.toContain(main);
        } else expect(main.style.clipPath).toBe("");
        await userEvent.keyboard("{Escape}");
        await expect.poll(() => main.style.clipPath).toBe("");
      } finally {
        await screen.unmount();
        dispose();
        root.remove();
        html.className = savedClass;
        if (savedScope === null) html.removeAttribute("data-window-translucency");
        else html.setAttribute("data-window-translucency", savedScope);
        if (savedMaterial === null) html.removeAttribute("data-window-material");
        else html.setAttribute("data-window-material", savedMaterial);
      }
    },
  );
  it("moves the same conversation icons into the outer rail only while collapsed", async () => {
    await page.viewport(1280, 800);
    const screen = await render(
      <SidebarProvider defaultOpen>
        <IntegratedRailShell compactPreview />
      </SidebarProvider>,
    );
    try {
      const rail = page.getByRole("navigation", { name: "Primary" }).element();
      const main = page.getByTestId("integrated-main").element();
      const thread = page.getByRole("button", { name: "codex thread", exact: true }).element();
      const panel = screen.container.querySelector<HTMLElement>('[data-slot="sidebar-container"]')!;
      const gap = screen.container.querySelector<HTMLElement>('[data-slot="sidebar-gap"]')!;
      expect(thread.getBoundingClientRect().left).toBeGreaterThanOrEqual(
        rail.getBoundingClientRect().right,
      );
      expect(screen.container.querySelector('[data-slot="app-rail-threads"]')).toBeNull();
      await page.getByRole("button", { name: "Toggle integrated sidebar" }).click();
      await expect.poll(() => gap.getBoundingClientRect().width).toBe(0);
      await expect
        .poll(() => panel.getBoundingClientRect().width)
        .toBe(rail.getBoundingClientRect().width);
      const slot = screen.container.querySelector<HTMLElement>('[data-slot="app-rail-threads"]')!;
      const provider = thread.querySelector<HTMLElement>('[data-slot="sidebar-thread-provider"]')!;
      expect(provider.getBoundingClientRect().left).toBeGreaterThanOrEqual(
        rail.getBoundingClientRect().left,
      );
      expect(provider.getBoundingClientRect().right).toBeLessThanOrEqual(
        rail.getBoundingClientRect().right,
      );
      expect(thread.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        slot.getBoundingClientRect().top,
      );
      expect(main.getBoundingClientRect().left).toBeCloseTo(rail.getBoundingClientRect().right, 0);
      expect(screen.container.querySelectorAll('[aria-label="codex thread"]')).toHaveLength(1);
      await page.getByRole("button", { name: "Home", exact: true }).hover();
      expect(panel.getBoundingClientRect().width).toBe(rail.getBoundingClientRect().width);
      const contentLeft = main.getBoundingClientRect().left;
      await page.getByRole("button", { name: "codex thread", exact: true }).hover();
      await page.getByRole("button", { name: "Home", exact: true }).hover();
      await new Promise((resolve) => setTimeout(resolve, DISCLOSURE_TRANSITION_MS * 2));
      expect(panel.getBoundingClientRect().width).toBe(rail.getBoundingClientRect().width);
      await page.getByRole("button", { name: "codex thread", exact: true }).hover();
      await expect.poll(() => panel.getBoundingClientRect().width).toBe(256);
      expect(panel.getBoundingClientRect().left).toBeGreaterThanOrEqual(
        rail.getBoundingClientRect().right,
      );
      const expectNavigationUncovered = () => {
        for (const name of ["Home", "Settings"]) {
          const button = page.getByRole("button", { name, exact: true }).element();
          const bounds = button.getBoundingClientRect();
          expect(
            button.contains(
              document.elementFromPoint(
                bounds.left + bounds.width / 2,
                bounds.top + bounds.height / 2,
              ),
            ),
          ).toBe(true);
        }
      };
      expectNavigationUncovered();
      await userEvent.hover(slot);
      await new Promise((resolve) => setTimeout(resolve, DISCLOSURE_TRANSITION_MS * 2));
      expect(panel.getBoundingClientRect().width).toBe(256);
      await expect
        .element(thread.querySelector<HTMLElement>('[data-slot="sidebar-thread-title"]')!)
        .toBeVisible();
      expect(main.getBoundingClientRect().left).toBe(contentLeft);
      await userEvent.keyboard("{Escape}");
      await expect
        .poll(() => panel.getBoundingClientRect().width)
        .toBe(rail.getBoundingClientRect().width);
      await page.viewport(1280, 360);
      await expect
        .poll(() => panel.getBoundingClientRect().height)
        .toBe(slot.getBoundingClientRect().height);
      await expect
        .element(page.getByRole("button", { name: "Settings", exact: true }))
        .toBeVisible();
      expect(panel.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        page
          .getByRole("button", { name: "Settings", exact: true })
          .element()
          .getBoundingClientRect().top,
      );
      await page.viewport(1280, 800);
      await page.getByRole("button", { name: "Toggle integrated sidebar" }).click();
      await expect.poll(() => gap.getBoundingClientRect().width).toBe(256);
      expectNavigationUncovered();
      expect(page.getByRole("button", { name: "codex thread", exact: true }).element()).toBe(
        thread,
      );
      expect(screen.container.querySelector('[data-slot="app-rail-threads"]')).toBeNull();
      expect(thread.getBoundingClientRect().left).toBeGreaterThanOrEqual(
        rail.getBoundingClientRect().right,
      );
    } finally {
      await screen.unmount();
    }
  });
  it("keeps the compact list visible and previews it without moving content or pinning it", async () => {
    await page.viewport(1280, 800);
    const screen = await render(
      <SidebarProvider defaultOpen={false}>
        <Sidebar collapsible="compact">
          <button type="button" className="w-full truncate">
            Compact conversation
          </button>
          <SidebarTrigger aria-label="Pin compact sidebar" />
        </Sidebar>
        <main className="min-w-0 flex-1" data-testid="compact-main">
          Conversation
        </main>
      </SidebarProvider>,
    );
    const panel = screen.container.querySelector<HTMLElement>('[data-slot="sidebar-container"]')!;
    const gap = screen.container.querySelector<HTMLElement>('[data-slot="sidebar-gap"]')!;
    const sidebar = screen.container.querySelector<HTMLElement>('[data-slot="sidebar"]')!;
    const main = screen.container.querySelector<HTMLElement>('[data-testid="compact-main"]')!;
    try {
      expect(gap.getBoundingClientRect().width).toBe(64);
      expect(panel.getBoundingClientRect().width).toBe(64);
      const contentLeft = main.getBoundingClientRect().left;
      await page.getByRole("button", { name: "Compact conversation", exact: true }).hover();
      await expect.poll(() => panel.getBoundingClientRect().width).toBe(256);
      expect(main.getBoundingClientRect().left).toBe(contentLeft);
      expect(gap.getBoundingClientRect().width).toBe(64);
      expect(sidebar.dataset.state).toBe("collapsed");
      await page.getByRole("button", { name: "Compact conversation", exact: true }).click();
      await page.getByTestId("compact-main").hover();
      await expect.poll(() => panel.getBoundingClientRect().width).toBe(64);
      await page.getByRole("button", { name: "Compact conversation", exact: true }).hover();
      await expect.poll(() => panel.getBoundingClientRect().width).toBe(256);
      await page.getByRole("button", { name: "Pin compact sidebar", exact: true }).click();
      await expect.poll(() => gap.getBoundingClientRect().width).toBe(256);
      await page.getByTestId("compact-main").hover();
      expect(sidebar.dataset.state).toBe("expanded");
      expect(panel.getBoundingClientRect().width).toBe(256);
    } finally {
      await screen.unmount();
    }
  });

  it("opens a compact preview for keyboard focus and closes only the preview with Escape", async () => {
    await page.viewport(1280, 800);
    const screen = await render(
      <SidebarProvider defaultOpen={false}>
        <Sidebar collapsible="compact">
          <button type="button">Keyboard conversation</button>
        </Sidebar>
        <main className="min-w-0 flex-1">Conversation</main>
      </SidebarProvider>,
    );
    const panel = screen.container.querySelector<HTMLElement>('[data-slot="sidebar-container"]')!;
    const sidebar = screen.container.querySelector<HTMLElement>('[data-slot="sidebar"]')!;
    try {
      await userEvent.keyboard("{Tab}");
      expect(document.activeElement).toBe(screen.container.querySelector("button"));
      await expect.poll(() => panel.getBoundingClientRect().width).toBe(256);
      await userEvent.keyboard("{Escape}");
      await expect.poll(() => panel.getBoundingClientRect().width).toBe(64);
      expect(sidebar.dataset.state).toBe("collapsed");
      expect(document.activeElement).toBe(screen.container.querySelector("button"));
    } finally {
      await screen.unmount();
    }
  });

  it("closes a hover preview with Escape while focus stays in the composer", async () => {
    await page.viewport(1280, 800);
    const screen = await render(
      <SidebarProvider defaultOpen={false}>
        <Sidebar collapsible="compact">
          <button type="button" className="w-full truncate">
            Hover conversation
          </button>
        </Sidebar>
        <main className="flex-1">
          <input aria-label="Chat composer" />
        </main>
      </SidebarProvider>,
    );
    try {
      const composer = screen
        .getByRole("textbox", { name: "Chat composer" })
        .element() as HTMLInputElement;
      composer.focus();
      await screen.getByRole("button", { name: "Hover conversation" }).hover();
      const panel = screen.container.querySelector<HTMLElement>('[data-slot="sidebar-container"]')!;
      await expect.poll(() => panel.getBoundingClientRect().width).toBe(256);
      await userEvent.keyboard("{Escape}");
      await expect.poll(() => panel.getBoundingClientRect().width).toBe(64);
      expect(document.activeElement).toBe(composer);
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the mobile sheet when the desktop sidebar uses compact mode", async () => {
    await page.viewport(390, 800);
    const screen = await render(
      <SidebarProvider defaultOpen={false}>
        <SidebarTrigger aria-label="Open compact mobile sidebar" />
        <Sidebar collapsible="compact">
          <button type="button">Mobile conversation</button>
        </Sidebar>
      </SidebarProvider>,
    );
    try {
      await page.getByRole("button", { name: "Open compact mobile sidebar" }).click();
      await expect
        .element(page.getByRole("dialog", { name: "Sidebar", exact: true }))
        .toBeVisible();
      const sheet = document.querySelector<HTMLElement>(
        '[data-slot="sidebar"][data-mobile="true"]',
      )!;
      await expect.element(page.getByRole("button", { name: "Mobile conversation" })).toBeVisible();
      expect(sheet.dataset.sidebarCompact).not.toBe("true");
    } finally {
      await screen.unmount();
    }
  });

  it("does not preview the panel when focusing its navigation rail portal", async () => {
    await page.viewport(1280, 800);
    const rail = document.createElement("nav");
    document.body.append(rail);
    const screen = await render(
      <SidebarProvider defaultOpen={false}>
        <Sidebar collapsible="compact">
          <button type="button" className="w-full">
            Conversation
          </button>
          {createPortal(<button type="button">Navigation destination</button>, rail)}
        </Sidebar>
        <main className="flex-1">Chat</main>
      </SidebarProvider>,
    );
    try {
      await page.getByRole("button", { name: "Navigation destination" }).click();
      const sidebar = screen.container.querySelector<HTMLElement>('[data-slot="sidebar"]')!;
      expect(sidebar.dataset.sidebarPreview).not.toBe("true");
      expect(
        screen.container
          .querySelector<HTMLElement>('[data-slot="sidebar-container"]')!
          .getBoundingClientRect().width,
      ).toBe(64);
    } finally {
      await screen.unmount();
      rail.remove();
    }
  });

  it("keeps the hover preview open while using a portaled project card", async () => {
    await page.viewport(1280, 800);
    const onEdit = vi.fn();
    const screen = await render(
      <SidebarProvider defaultOpen={false}>
        <Sidebar collapsible="compact">
          <PreviewCard>
            <PreviewCardTrigger
              render={
                <button type="button" className="w-full truncate">
                  Project card
                </button>
              }
            />
            <PreviewCardPopup>
              <button type="button" onClick={onEdit}>
                Edit preview project
              </button>
            </PreviewCardPopup>
          </PreviewCard>
        </Sidebar>
        <main className="flex-1">
          <input aria-label="Project card composer" />
        </main>
      </SidebarProvider>,
    );
    try {
      (
        screen.getByRole("textbox", { name: "Project card composer" }).element() as HTMLElement
      ).focus();
      await screen.getByRole("button", { name: "Project card" }).hover();
      const panel = screen.container.querySelector<HTMLElement>('[data-slot="sidebar-container"]')!;
      await expect.poll(() => panel.getBoundingClientRect().width).toBe(256);
      const edit = page.getByRole("button", { name: "Edit preview project" });
      await expect.element(edit).toBeVisible();
      await edit.hover();
      // Exercise the leave grace period while the pointer is inside the shared card.
      await new Promise((resolve) => setTimeout(resolve, DISCLOSURE_TRANSITION_MS * 2));
      expect(panel.getBoundingClientRect().width).toBe(256);
      await edit.click();
      expect(onEdit).toHaveBeenCalledOnce();
    } finally {
      await screen.unmount();
    }
  });

  it.each(["left", "right"] as const)(
    "settles the %s panel and layout gap immediately with reduced motion",
    async (side) => {
      const protocol = cdp() as {
        send(
          method: "Emulation.setEmulatedMedia",
          params: { features: { name: string; value: string }[] },
        ): Promise<void>;
      };
      await protocol.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: "reduce" }],
      });
      await page.viewport(1280, 800);
      const screen = await render(
        <SidebarProvider defaultOpen>
          <SidebarTrigger aria-label="Toggle motion panel" className="relative z-50" />
          <Sidebar
            side={side}
            className={SIDEBAR_OFFCANVAS_MOTION_CLASS}
            gapClassName={SIDEBAR_OFFCANVAS_MOTION_CLASS}
          >
            Panel content
          </Sidebar>
        </SidebarProvider>,
      );
      try {
        const panel = screen.container.querySelector<HTMLElement>(
          '[data-slot="sidebar-container"]',
        )!;
        const gap = screen.container.querySelector<HTMLElement>('[data-slot="sidebar-gap"]')!;
        const initial = panel.getBoundingClientRect();
        await page.getByRole("button", { name: "Toggle motion panel" }).click();
        expect(panel.getAnimations()).toHaveLength(0);
        expect(gap.getAnimations()).toHaveLength(0);
        expect(panel.getBoundingClientRect().left).toBeCloseTo(
          initial.left + (side === "left" ? -initial.width : initial.width),
          0,
        );
        expect(gap.getBoundingClientRect().width).toBe(0);
        await page.getByRole("button", { name: "Toggle motion panel" }).click();
        expect(panel.getAnimations()).toHaveLength(0);
        expect(gap.getAnimations()).toHaveLength(0);
        expect(panel.getBoundingClientRect().left).toBeCloseTo(initial.left, 0);
        expect(gap.getBoundingClientRect().width).toBeCloseTo(initial.width, 0);
      } finally {
        await screen.unmount();
        await protocol.send("Emulation.setEmulatedMedia", { features: [] });
      }
    },
  );

  it.each(["missing", "rejecting"])(
    "toggles controlled and uncontrolled sidebars when CookieStore is %s",
    async (cookieStoreState) => {
      await page.viewport(1280, 800);
      vi.stubGlobal(
        "cookieStore",
        cookieStoreState === "missing"
          ? undefined
          : {
              set: () =>
                Promise.reject(
                  new TypeError("An unknown error occurred while writing the cookie."),
                ),
            },
      );
      const screen = await render(
        <>
          <SidebarProvider defaultOpen>
            <Controls name="left" />
          </SidebarProvider>
          <ControlledSidebar />
        </>,
      );
      try {
        for (const state of ["collapsed", "expanded"]) {
          for (const name of ["left", "right"]) {
            await page.getByRole("button", { name: `Toggle ${name}` }).click();
            await expect
              .element(page.getByRole("status", { name: `${name} state` }))
              .toHaveTextContent(state);
          }
        }
      } finally {
        await screen.unmount();
      }
    },
  );
});
