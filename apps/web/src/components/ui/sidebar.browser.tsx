import "../../index.css";

import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cdp, page } from "vitest/browser";
import { render } from "vitest-browser-react";

import {
  Sidebar,
  SidebarProvider,
  SidebarTrigger,
  SIDEBAR_OFFCANVAS_MOTION_CLASS,
  useSidebar,
  type SidebarContextProps,
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
  it("keeps a controller desktop dock visible in a narrow workspace viewport", async () => {
    await page.viewport(700, 800);
    const controls: SidebarContextProps = {
      state: "expanded",
      open: true,
      openMobile: false,
      isMobile: false,
      setOpen: () => {},
      setOpenMobile: () => {},
      toggleSidebar: () => {},
    };
    const screen = await render(
      <SidebarProvider controls={controls}>
        <Sidebar side="right">Remote file contents</Sidebar>
      </SidebarProvider>,
    );
    try {
      await expect.element(page.getByText("Remote file contents")).toBeVisible();
      const panel = screen.container.querySelector<HTMLElement>('[data-slot="sidebar-container"]')!;
      expect(panel.getBoundingClientRect().width).toBeGreaterThan(0);
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
