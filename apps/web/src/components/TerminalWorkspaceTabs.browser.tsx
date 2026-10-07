import "../index.css";

import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import TerminalWorkspaceTabs from "./TerminalWorkspaceTabs";

describe("TerminalWorkspaceTabs wheel scrolling", () => {
  it("scrolls an overflowing workspace strip sideways with a vertical wheel", async () => {
    const mounted = await render(
      <div style={{ width: 40 }}>
        <TerminalWorkspaceTabs
          activeTab="terminal"
          isWorking={false}
          terminalHasRunningActivity={false}
          workspaceLayout="both"
          onSelectTab={() => {}}
          onClose={() => {}}
        />
      </div>,
    );
    try {
      const strip = page.getByTestId("terminal-workspace-tab-strip").element() as HTMLElement;
      expect(strip.scrollWidth).toBeGreaterThan(strip.clientWidth);
      strip.dispatchEvent(new WheelEvent("wheel", { deltaY: 24, bubbles: true }));
      expect(strip.scrollLeft).toBeGreaterThan(0);
    } finally {
      await mounted.unmount();
    }
  });
});
