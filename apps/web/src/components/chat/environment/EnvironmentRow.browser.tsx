// FILE: EnvironmentRow.browser.tsx
// Purpose: Browser-level regression tests for Environment panel disclosure behavior.
// Layer: Vitest browser tests

import "../../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { EnvironmentCollapsibleSection } from "./EnvironmentRow";

describe("EnvironmentCollapsibleSection", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("uses the shared panel and chevron motion while exposing expanded state", async () => {
    await render(
      <EnvironmentCollapsibleSection label="Pinned">
        <span>Section content</span>
      </EnvironmentCollapsibleSection>,
    );

    const trigger = document.querySelector<HTMLElement>('[data-slot="collapsible-trigger"]');
    const panel = document.querySelector<HTMLElement>('[data-slot="collapsible-panel"]');
    const chevron = trigger?.querySelector<SVGElement>("svg");

    expect(trigger?.getAttribute("aria-expanded")).toBe("true");
    expect(panel?.className).toContain("duration-220");
    expect(chevron?.getAttribute("class")).toContain("duration-220");
    expect(chevron?.getAttribute("class")).toContain("rotate-90");

    await page.getByRole("button", { name: "Pinned" }).click();

    await vi.waitFor(() => expect(trigger?.getAttribute("aria-expanded")).toBe("false"));
    expect(chevron?.getAttribute("class")).not.toContain("rotate-90");
  });
});
