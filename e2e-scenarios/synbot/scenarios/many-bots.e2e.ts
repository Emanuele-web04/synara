import { expect, test } from "./synbot.ts";

// Stop all shows only while something runs; with idle bots the foot holds New bot alone.
test("With many bots the sidebar footer (New bot) stays reachable", async ({
  synbot,
  browser,
  screen,
  app,
}) => {
  const stamp = Date.now() % 100000;
  for (let index = 0; index < 16; index += 1) {
    await synbot.bot({ name: `Crowd ${stamp} ${String(index).padStart(2, "0")}` });
  }
  await synbot.open();
  await expect(screen.getByRole("button", "New bot")).toBeAttached({ timeout: 30_000 });
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  await app.screenshot("many-bots");
  const footer = await browser.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "New bot",
    );
    const rect = button?.getBoundingClientRect();
    let scroller: Element | null = button?.parentElement ?? null;
    while (
      scroller &&
      !(
        scroller.scrollHeight > scroller.clientHeight &&
        /(auto|scroll)/.test(getComputedStyle(scroller).overflowY)
      )
    ) {
      scroller = scroller.parentElement;
    }
    return rect
      ? {
          top: rect.top,
          bottom: rect.bottom,
          viewport: window.innerHeight,
          scrollableAncestor: scroller
            ? `${scroller.tagName}.${String(scroller.className).slice(0, 60)}`
            : null,
        }
      : null;
  });
  expect(footer).not.toBeNull();
  expect(footer!.bottom).toBeLessThanOrEqual(footer!.viewport);
  await expect(screen.getByRole("button", "New bot")).toBeVisible();
});
