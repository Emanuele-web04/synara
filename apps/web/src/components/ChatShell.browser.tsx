import "../index.css";
import { expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { ChatShell } from "./ChatShell";
import type { SidebarContextProps } from "./ui/sidebar";

it("keeps the remote card on the same inset surface and follows the controller sidebar", async () => {
  await page.viewport(1100, 800);
  const controls: SidebarContextProps = {
    open: true,
    state: "expanded",
    isMobile: false,
    openMobile: false,
    setOpen: () => {},
    setOpenMobile: () => {},
    toggleSidebar: () => {},
  };
  const content = (
    <main data-testid="card" className="chat-content-card relative flex-1">
      Remote chat
    </main>
  );
  const screen = await render(
    <ChatShell open={false} controls={controls}>
      {content}
    </ChatShell>,
  );
  const card = page.getByTestId("card").element();
  await expect.poll(() => parseFloat(getComputedStyle(card).marginRight)).toBeGreaterThan(0);
  await expect.poll(() => parseFloat(getComputedStyle(card).marginBottom)).toBeGreaterThan(0);
  await expect.poll(() => parseFloat(getComputedStyle(card, "::after").top)).toBeGreaterThan(0);
  await expect
    .poll(() => parseFloat(getComputedStyle(card, "::after").borderTopLeftRadius))
    .toBe(0);
  await screen.rerender(
    <ChatShell open={false} controls={{ ...controls, open: false, state: "collapsed" }}>
      {content}
    </ChatShell>,
  );
  await expect
    .poll(() => parseFloat(getComputedStyle(card, "::after").borderTopLeftRadius))
    .toBeGreaterThan(0);
});
