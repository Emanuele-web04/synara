import "../../index.css";

import { useState } from "react";
import { createPortal } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { DISCLOSURE_TRANSITION_MS } from "~/lib/disclosureMotion";
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "./preview-card";

import {
  Sidebar,
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

afterEach(() => vi.unstubAllGlobals());

describe("sidebar toggles", () => {
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
      screen.container.querySelector<HTMLButtonElement>("button")!.focus();
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
