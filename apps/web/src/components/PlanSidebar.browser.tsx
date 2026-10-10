import "../index.css";

import { OrchestrationProposedPlanId } from "@synara/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import PlanSidebar, { type PlanSidebarProps } from "./PlanSidebar";

const props: PlanSidebarProps = {
  activeTaskList: {
    createdAt: "2026-10-05T10:00:00Z",
    turnId: null,
    tasks: [{ task: "Keep existing panel actions", status: "inProgress" }],
  },
  activeProposedPlan: {
    id: OrchestrationProposedPlanId.makeUnsafe("sidebar-plan"),
    createdAt: "2026-10-05T10:00:00Z",
    updatedAt: "2026-10-05T10:00:00Z",
    turnId: null,
    planMarkdown: "# Shared panel headers\n\nRead the [reference](https://example.com).",
    implementedAt: null,
    implementationThreadId: null,
  },
  markdownCwd: undefined,
  workspaceRoot: undefined,
  timestampFormat: "locale",
  onClose: () => {},
};

afterEach(() => {
  document.documentElement.style.removeProperty("--app-font-size-ui-lg");
});

it("exposes disclosure state and hides collapsed plan links from keyboard navigation", async () => {
  const screen = await render(
    <div style={{ height: 500 }}>
      <PlanSidebar {...props} />
    </div>,
  );
  try {
    const toggle = screen.getByRole("button", { name: "Shared panel headers" });
    await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
    toggle.element().focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(toggle).toHaveAttribute("aria-expanded", "true");
    const link = screen.getByRole("link", { name: "reference" });
    await expect.element(link).toBeVisible();
    const linkElement = link.element();
    await userEvent.keyboard(" ");
    await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
    const region = linkElement.closest<HTMLElement>("[inert][aria-hidden='true']")!;
    expect(region).not.toBeNull();
    linkElement.focus();
    expect(document.activeElement).toBe(toggle.element());
    await expect.poll(() => region.getBoundingClientRect().height).toBe(0);
    await toggle.click();
    await expect.element(link).toBeVisible();
  } finally {
    await screen.unmount();
  }
});

it("keeps plan actions and close reachable at the existing width with larger UI text", async () => {
  document.documentElement.style.setProperty("--app-font-size-ui-lg", "18px");
  const onClose = vi.fn();
  const screen = await render(
    <div style={{ height: 500 }}>
      <PlanSidebar {...props} onClose={onClose} />
    </div>,
  );
  try {
    const header = screen.container.querySelector("header")!;
    expect(header).not.toBeNull();
    const bounds = header.getBoundingClientRect();
    for (const name of [
      "Download to .plan folder",
      "Export markdown file",
      "Copy as markdown",
      "Close plan sidebar",
    ]) {
      const button = screen.getByRole("button", { name });
      await expect.element(button).toBeVisible();
      const rect = button.element().getBoundingClientRect();
      expect(rect.left).toBeGreaterThanOrEqual(bounds.left);
      expect(rect.right).toBeLessThanOrEqual(bounds.right);
    }
    await screen.getByRole("button", { name: "Close plan sidebar" }).click();
    expect(onClose).toHaveBeenCalledOnce();
  } finally {
    await screen.unmount();
  }
});
