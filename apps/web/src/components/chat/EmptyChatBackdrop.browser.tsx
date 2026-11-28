// FILE: EmptyChatBackdrop.browser.tsx
// Purpose: Exercises ripple cleanup while a retained chat pane is hidden.

import "../../index.css";
import { expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { EmptyChatBackdrop } from "./EmptyChatBackdrop";

it("restores the still Temple image after hiding the pane during a ripple", async () => {
  const backdropProps = { style: "temple", intensity: 100 } as const;
  const screen = await render(
    <div data-testid="pane" style={{ position: "relative", width: 480, height: 320 }}>
      <EmptyChatBackdrop {...backdropProps} />
    </div>,
  );
  try {
    const pane = page.getByTestId("pane").element() as HTMLElement;
    const backdrop = pane.querySelector("[data-empty-chat-backdrop]")!;
    const canvas = backdrop.querySelector("canvas")!;
    await expect.poll(() => getComputedStyle(backdrop).opacity, { timeout: 3_000 }).toBe("1");
    const still = canvas.toDataURL();
    await page.getByTestId("pane").click({ position: { x: 200, y: 170 } });
    await expect.poll(() => canvas.toDataURL() === still).toBe(false);

    pane.style.visibility = "hidden";
    // Give the active frame time to observe the parked pane without a resize.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    pane.style.visibility = "visible";
    await expect.poll(() => canvas.toDataURL() === still, { timeout: 4_000 }).toBe(true);
  } finally {
    screen.unmount();
  }
});
