import "../../index.css";

import { expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { SidePanelOverlay } from "./SidePanelOverlay";

it.each([false, true])(
  "clips sliding panels horizontally while content scrolls vertically when open=%s",
  async (open) => {
    const screen = await render(
      <div className="relative" style={{ width: 700, height: 400 }}>
        <SidePanelOverlay
          open={open}
          variant="docked"
          className="items-end gap-3 overflow-y-auto"
          cardClassName="max-h-full w-72"
        >
          <div className="min-h-0 overflow-y-auto" data-testid="panel-content">
            <div style={{ height: 900 }}>Environment content</div>
          </div>
        </SidePanelOverlay>
      </div>,
    );

    try {
      const overlay = screen.container.querySelector<HTMLElement>(
        "[data-environment-panel-variant]",
      )!;
      const content = page.getByTestId("panel-content").element() as HTMLElement;

      await expect.poll(() => content.clientHeight).toBeGreaterThan(0);
      expect(getComputedStyle(overlay).overflowX).toBe("hidden");
      expect(getComputedStyle(overlay).overflowY).toBe("auto");
      expect(content.scrollHeight).toBeGreaterThan(content.clientHeight);
      content.scrollTop = 100;
      expect(content.scrollTop).toBe(100);
    } finally {
      await screen.unmount();
    }
  },
);

it("keeps a wide card inside a narrow chat column", async () => {
  const screen = await render(
    <div className="relative" style={{ width: 240, height: 400 }}>
      <SidePanelOverlay open variant="floating" className="items-end" cardClassName="w-72">
        <div style={{ width: 320 }}>Wide content</div>
      </SidePanelOverlay>
    </div>,
  );

  try {
    const column = screen.container.firstElementChild!;
    const card = screen.container.querySelector("[data-environment-panel-variant] > div")!;
    await expect.poll(() => card.getBoundingClientRect().width).toBeLessThanOrEqual(216);
    expect(card.getBoundingClientRect().left).toBeGreaterThanOrEqual(
      column.getBoundingClientRect().left,
    );
  } finally {
    await screen.unmount();
  }
});
