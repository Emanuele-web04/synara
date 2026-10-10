import "../../index.css";

import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { SurfaceContentTabs } from "./SurfaceContentTabs";

const TITLES = [
  "Cambiar resolución de pantalla",
  "Ocultar chats archivados",
  "Revisar la cola de tareas",
  "Arreglar el menú de pestañas",
  "Medir el uso de contexto",
  "Mover la vista previa flotante",
];

function mountStrip(widthPx: number, onSelect: (key: string) => void) {
  return render(
    <div style={{ width: `${widthPx}px`, display: "flex" }}>
      <SurfaceContentTabs
        ariaLabel="Open threads"
        activeKey="tab-0"
        tabs={TITLES.map((title, index) => ({
          key: `tab-${index}`,
          title,
          icon: <span aria-hidden className="size-3.5" />,
          onSelect: () => onSelect(`tab-${index}`),
        }))}
      />
    </div>,
  );
}

describe("SurfaceContentTabs overflow", () => {
  it("keeps titles readable and lists tabs that do not fit in an overflow menu", async () => {
    const onSelect = vi.fn();
    const screen = await mountStrip(560, onSelect);
    try {
      const overflow = page.getByRole("button", { name: /more tabs?$/ });
      await expect.element(overflow).toBeVisible();
      // Each tab keeps its floor width instead of shrinking to a few letters.
      const tabWidths = Array.from(
        document.querySelectorAll<HTMLElement>("[data-surface-tab]"),
        (tab) => tab.getBoundingClientRect().width,
      );
      const fontSizePx = Number.parseFloat(
        getComputedStyle(document.querySelector<HTMLElement>("[data-surface-tab]")!).fontSize,
      );
      expect(Math.min(...tabWidths)).toBeGreaterThanOrEqual(fontSizePx * 12 - 1);

      await overflow.click();
      const lastTitle = TITLES.at(-1)!;
      await page.getByRole("menuitem", { name: lastTitle }).click();
      expect(onSelect).toHaveBeenCalledWith(`tab-${TITLES.length - 1}`);
    } finally {
      await screen.unmount();
    }
  });

  it("shows no overflow menu while every tab fits", async () => {
    const screen = await mountStrip(4000, () => {});
    try {
      await expect.element(page.getByRole("navigation", { name: "Open threads" })).toBeVisible();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      expect(page.getByRole("button", { name: /more tabs?$/ }).elements()).toHaveLength(0);
    } finally {
      await screen.unmount();
    }
  });
});
