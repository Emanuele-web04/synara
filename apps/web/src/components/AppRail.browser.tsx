import "../index.css";

import { useState } from "react";
import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { AppRail, railCentralGlyphs, railItemGlyphs } from "./AppRail";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider } from "./ui/sidebar";

function RailHoverHarness() {
  const [selected, setSelected] = useState("");
  return (
    <SidebarProvider defaultOpen={false}>
      <AppRail
        items={[]}
        shortcuts={[]}
        bottomItems={[]}
        activityItems={[
          {
            id: "activity-review",
            glyphs: railCentralGlyphs("eye-open"),
            label: "Needs review",
            active: false,
            badge: { text: "2", accessibleLabel: "2 conversations" },
            showBadgeCount: true,
            onSelect: () => setSelected("Activity"),
            hoverContent: (
              <SidebarMenu aria-label="Unread chats">
                {["First unread chat", "Second unread chat"].map((title) => (
                  <SidebarMenuItem key={title}>
                    <SidebarMenuButton size="sm" onClick={() => setSelected(title)}>
                      <span>{title}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            ),
          },
        ]}
      />
      <output aria-label="Selected chat">{selected}</output>
    </SidebarProvider>
  );
}

describe("AppRail hover content", () => {
  it("keeps compact conversations and Settings reachable in a short rail with all activity counters", async () => {
    await page.viewport(1280, 360);
    const item = (id: string) => ({
      id,
      glyphs: railItemGlyphs("home"),
      label: id,
      badge: null,
      active: false,
      onSelect: () => {},
    });
    const mounted = await render(
      <div className="fixed inset-0 flex">
        <AppRail
          items={["Home", "Inbox", "Projects", "Tasks", "Automations", "History", "More"].map(item)}
          shortcuts={[]}
          activityItems={["Working", "Needs review", "Snoozed"].map(item)}
          bottomItems={[item("Settings")]}
          bottomSlot={
            <>
              <button type="button" className="size-9 shrink-0" aria-label="Usage" />
              <button type="button" className="size-9 shrink-0" aria-label="Help" />
            </>
          }
          compactThreadSlotRef={() => {}}
        />
      </div>,
    );
    try {
      const rail = mounted.getByRole("navigation", { name: "Primary" }).element();
      const settings = mounted.getByRole("button", { name: "Settings", exact: true }).element();
      expect(settings.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        rail.getBoundingClientRect().bottom,
      );
      expect(
        mounted.container.querySelector('[data-slot="app-rail-threads"]')!.getBoundingClientRect()
          .height,
      ).toBeGreaterThan(0);
      const navigation = rail.firstElementChild!;
      navigation.scrollTop = navigation.scrollHeight;
      await mounted.getByRole("button", { name: "More", exact: true }).click();
      await mounted.getByRole("button", { name: "Settings", exact: true }).click();
    } finally {
      await mounted.unmount();
    }
  });
  it("shows an interactive chat list on hover without moving the rail or activating its destination", async () => {
    await page.viewport(1280, 800);
    const mounted = await render(<RailHoverHarness />);
    try {
      const rail = mounted.getByRole("navigation", { name: "Primary" }).element();
      const width = rail.getBoundingClientRect().width;
      const eye = mounted.getByRole("button", { name: "Needs review · 2 conversations" });
      await eye.hover();
      await expect
        .poll(() => document.querySelector('[aria-label="Unread chats"]') !== null)
        .toBe(true);
      const chat = mounted.getByRole("button", { name: "Second unread chat", exact: true });
      await expect.element(chat).toBeVisible();
      expect(mounted.getByRole("status", { name: "Selected chat" }).element().textContent).toBe("");
      expect(rail.getBoundingClientRect().width).toBe(width);
      await chat.hover();
      await expect.element(chat).toBeVisible();
      await chat.click();
      await expect
        .element(mounted.getByRole("status", { name: "Selected chat" }))
        .toHaveTextContent("Second unread chat");
      await eye.click();
      await expect
        .element(mounted.getByRole("status", { name: "Selected chat" }))
        .toHaveTextContent("Activity");
    } finally {
      await mounted.unmount();
    }
  });
});
