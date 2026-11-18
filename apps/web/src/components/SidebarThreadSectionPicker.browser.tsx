import "../index.css";

import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { SidebarThreadSectionPicker } from "./SidebarThreadSectionPicker";
import type { SidebarThreadSection } from "./Sidebar.uiState";
import { SidebarProvider } from "./ui/sidebar";

const protocol = () =>
  cdp() as {
    send(
      method: "Emulation.setEmulatedMedia",
      params: { features: { name: string; value: string }[] },
    ): Promise<void>;
  };

function Harness({ width = 256 }: { width?: number }) {
  const [value, setValue] = useState<SidebarThreadSection | null>(null);
  const [unread, setUnread] = useState(false);
  return (
    <SidebarProvider>
      <div style={{ width }}>
        <SidebarThreadSectionPicker
          value={value}
          attention={{ projects: false, chats: unread }}
          onValueChange={setValue}
        />
        <button onClick={() => setUnread((current) => !current)}>Toggle unread</button>
      </div>
    </SidebarProvider>
  );
}

afterEach(async () => {
  document.documentElement.classList.remove("dark");
  document.documentElement.style.removeProperty("--app-font-size-ui");
  await protocol().send("Emulation.setEmulatedMedia", { features: [] });
});

it.each([
  { theme: "light", width: 256, fontSize: 13 },
  { theme: "dark", width: 256, fontSize: 13 },
  { theme: "light", width: 224, fontSize: 13 },
  { theme: "dark", width: 224, fontSize: 20 },
])(
  "uses stable sidebar destinations without a sliding control ($theme, $width, $fontSize)",
  async ({ theme, width, fontSize }) => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.style.setProperty("--app-font-size-ui", `${fontSize}px`);
    const screen = await render(<Harness width={width} />);
    try {
      const projects = page.getByRole("radio", { name: "Projects", exact: true });
      const chats = page.getByRole("radio", { name: /^Chats/ });
      const label = chats.element().querySelector<HTMLElement>('[data-slot="sidebar-list-label"]')!;
      const initial = label.getBoundingClientRect();
      const projectBounds = projects.element().getBoundingClientRect();
      const chatBounds = chats.element().getBoundingClientRect();
      expect(chatBounds.top).toBeGreaterThanOrEqual(projectBounds.bottom);
      expect(chatBounds.left).toBeCloseTo(projectBounds.left, 1);
      expect(chatBounds.width).toBeCloseTo(projectBounds.width, 1);
      expect(chatBounds.height).toBeGreaterThanOrEqual(28);
      expect(screen.container.querySelector('[data-slot="segmented-thumb"]')).toBeNull();
      expect(screen.container.querySelector('[data-variant="inset"]')).toBeNull();

      await projects.click();
      await userEvent.keyboard("{ArrowDown}");
      await expect.element(chats).toHaveAttribute("aria-checked", "true");
      await expect.element(chats).toHaveAttribute("data-active", "true");
      expect(document.activeElement).toBe(chats.element());
      await page.getByRole("button", { name: "Toggle unread" }).click();
      await expect.element(chats).toHaveAttribute("aria-label", "Chats — needs attention");
      expect(label.getBoundingClientRect().left).toBeCloseTo(initial.left, 1);
      expect(label.getBoundingClientRect().top).toBeCloseTo(initial.top, 1);
      expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth);
      expect(label.getBoundingClientRect().bottom).toBeLessThanOrEqual(chatBounds.bottom);
      expect(Number.parseFloat(getComputedStyle(label).fontSize)).toBe(fontSize);
      const navigation = screen.container.querySelector<HTMLElement>(
        '[data-slot="sidebar-list-navigation"]',
      )!;
      expect(navigation.scrollWidth).toBeLessThanOrEqual(navigation.clientWidth);
      await page.getByRole("button", { name: "Toggle unread" }).click();
      await expect.element(chats).toHaveAttribute("aria-label", "Chats");
      expect(
        chats.element().querySelector('[data-slot="sidebar-list-attention"]')!.children,
      ).toHaveLength(0);
      expect(label.getBoundingClientRect().left).toBeCloseTo(initial.left, 1);
    } finally {
      await screen.unmount();
    }
  },
);

it("keeps sidebar destination focus and selection clear in reduced motion and forced colors", async () => {
  await protocol().send("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-reduced-motion", value: "reduce" },
      { name: "forced-colors", value: "active" },
    ],
  });
  const screen = await render(<Harness />);
  try {
    const projects = page.getByRole("radio", { name: "Projects", exact: true });
    const chats = page.getByRole("radio", { name: "Chats", exact: true });
    await expect.element(projects).toHaveAttribute("tabindex", "0");
    await expect.element(chats).toHaveAttribute("tabindex", "-1");
    await projects.click();
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(chats).toHaveAttribute("aria-checked", "true");
    expect(document.activeElement).toBe(chats.element());
    expect(chats.element().getAnimations()).toHaveLength(0);
    expect(getComputedStyle(chats.element()).outlineStyle).toBe("solid");
    expect(getComputedStyle(chats.element()).outlineWidth).toBe("2px");
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(projects).toHaveAttribute("aria-checked", "true");
    await userEvent.keyboard("{ArrowUp}");
    await expect.element(chats).toHaveAttribute("aria-checked", "true");
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(
      page.getByRole("button", { name: "Toggle unread" }).element(),
    );
  } finally {
    await screen.unmount();
  }
});
