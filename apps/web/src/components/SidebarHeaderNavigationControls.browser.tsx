import "../index.css";

import { useState } from "react";
import { describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import {
  SidebarHeaderNavigationControls,
  SidebarLeadingControlsDock,
  SidebarLeadingControlsSlot,
} from "./SidebarHeaderNavigationControls";
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

async function renderShell(vertical = false) {
  await page.viewport(1280, 800);
  return render(
    <SidebarProvider defaultOpen={false}>
      <Shell vertical={vertical} />
    </SidebarProvider>,
  );
}

describe("sidebar leading controls dock", () => {
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
