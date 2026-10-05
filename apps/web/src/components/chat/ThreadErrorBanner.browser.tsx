import "../../index.css";

import { formatProviderDeliveryBlockDetail } from "@synara/shared/providerDeliveryBlock";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ThreadErrorBanner } from "./ThreadErrorBanner";

const LONG_ERROR = [
  "Provider request failed",
  "Connection closed while waiting for a response",
  "Acceptance could not be confirmed",
  "Additional provider details",
  "Final diagnostic line",
].join("\n");

describe("ThreadErrorBanner", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("expands the full multiline error and collapses it accessibly", async () => {
    await render(<ThreadErrorBanner error={LONG_ERROR} />);
    const show = page.getByRole("button", { name: "Show details" });
    await expect.element(show).toHaveAttribute("aria-expanded", "false");
    const detailsId = show.element().getAttribute("aria-controls");
    expect(detailsId).toBeTruthy();

    await show.click();
    const hide = page.getByRole("button", { name: "Hide details" });
    await expect.element(hide).toHaveAttribute("aria-expanded", "true");
    const fullError = document.getElementById(detailsId!)!.querySelector("p")!;
    expect(fullError.textContent).toBe(LONG_ERROR);
    await expect.element(fullError).toBeVisible();
    expect(getComputedStyle(fullError).whiteSpace).toBe("pre-wrap");
    expect(getComputedStyle(fullError).webkitLineClamp).toBe("none");

    await hide.click();
    await expect.element(show).toHaveAttribute("aria-expanded", "false");
    const closedRegion = fullError.closest<HTMLElement>("[inert]")!;
    expect(closedRegion.getAttribute("aria-hidden")).toBe("true");
    await expect.poll(() => closedRegion.getBoundingClientRect().height).toBe(0);
  });

  it("keeps long errors scrollable without widening a narrow pane", async () => {
    const error = `${"x".repeat(500)}\n${Array.from({ length: 30 }, (_, index) => `Detail ${index}`).join("\n")}`;
    await render(
      <div style={{ width: 320 }}>
        <ThreadErrorBanner error={error} onDismiss={() => {}} />
      </div>,
    );
    await page.getByRole("button", { name: "Show details" }).click();
    const detailsId = page
      .getByRole("button", { name: "Hide details" })
      .element()
      .getAttribute("aria-controls");
    const fullError = document.getElementById(detailsId!)!.querySelector("p")!;
    expect(fullError.textContent).toBe(error);
    await expect.poll(() => fullError.clientHeight).toBeGreaterThan(0);
    expect(fullError.scrollHeight).toBeGreaterThan(fullError.clientHeight);
    expect(fullError.scrollWidth).toBeLessThanOrEqual(fullError.clientWidth);
    expect(page.getByRole("alert").element().getBoundingClientRect().width).toBeLessThanOrEqual(
      320,
    );
    fullError.focus();
    expect(document.activeElement).toBe(fullError);
    fullError.scrollTop = fullError.scrollHeight;
    expect(fullError.scrollTop).toBeGreaterThan(0);
  });

  it("copies every line while collapsed and confirms success", async () => {
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await render(<ThreadErrorBanner error={LONG_ERROR} />);
    await page.getByRole("button", { name: "Copy error", exact: true }).click();
    await expect.element(page.getByRole("button", { name: "Copied error" })).toBeVisible();
    expect(writeText).toHaveBeenCalledExactlyOnceWith(LONG_ERROR);
  });

  it("resets details and copy feedback when the error changes", async () => {
    vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const screen = await render(<ThreadErrorBanner error={LONG_ERROR} />);
    await page.getByRole("button", { name: "Show details" }).click();
    await page.getByRole("button", { name: "Copy error", exact: true }).click();
    await expect.element(page.getByRole("button", { name: "Copied error" })).toBeVisible();

    await screen.rerender(<ThreadErrorBanner error="A different provider error" />);
    await expect
      .element(page.getByRole("button", { name: "Show details" }))
      .toHaveAttribute("aria-expanded", "false");
    await expect
      .element(page.getByRole("button", { name: "Copy error", exact: true }))
      .toBeVisible();
    await screen.rerender(<ThreadErrorBanner error={null} />);
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  });

  it("only offers existing unblock recovery for quarantine and never resends errors", async () => {
    const onUnblock = vi.fn();
    const onDismiss = vi.fn();
    const screen = await render(
      <ThreadErrorBanner error={LONG_ERROR} onUnblock={onUnblock} onDismiss={onDismiss} />,
    );
    await expect
      .element(page.getByRole("button", { name: "Retry", exact: true }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Unblock thread" }))
      .not.toBeInTheDocument();

    const quarantine = formatProviderDeliveryBlockDetail("Acceptance is uncertain");
    await screen.rerender(
      <ThreadErrorBanner error={quarantine} onUnblock={onUnblock} onDismiss={onDismiss} />,
    );
    await page.getByRole("button", { name: "Unblock thread" }).click();
    expect(onUnblock).toHaveBeenCalledExactlyOnceWith();
    await screen.rerender(
      <ThreadErrorBanner error={quarantine} onUnblock={onUnblock} unblocking />,
    );
    await expect.element(page.getByRole("button", { name: "Unblocking…" })).toBeDisabled();

    await screen.rerender(<ThreadErrorBanner error={quarantine} onDismiss={onDismiss} />);
    await expect
      .element(page.getByRole("button", { name: "Unblock thread" }))
      .not.toBeInTheDocument();
    await page.getByRole("button", { name: "Dismiss error" }).click();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onUnblock).toHaveBeenCalledTimes(1);
  });
});
