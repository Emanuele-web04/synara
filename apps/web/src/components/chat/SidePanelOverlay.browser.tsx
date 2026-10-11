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
