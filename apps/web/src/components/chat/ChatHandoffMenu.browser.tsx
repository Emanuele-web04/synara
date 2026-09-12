import "../../index.css";

import { page, userEvent } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { TooltipProvider } from "../ui/tooltip";
import { ChatHandoffMenu } from "./ChatHandoffMenu";
import { ProviderHandoffTrail } from "./ProviderHandoffTrail";

beforeEach(async () => {
  await page.viewport(1000, 800);
});

const defaults = {
  compact: false,
  handoffActionLabel: "Hand off",
  handoffPending: false,
  handoffDisabled: false,
  handoffActionTargetProviders: ["claudeAgent", "grok"] as const,
};

async function renderMenu(enabled: boolean) {
  const onCreateHandoff = vi.fn();
  await render(
    <TooltipProvider>
      <ChatHandoffMenu
        {...defaults}
        continuousHandoffEnabled={enabled}
        onCreateHandoff={onCreateHandoff}
      />
    </TooltipProvider>,
  );
  await page.getByRole("button", { name: "Hand off", exact: true }).click();
  return onCreateHandoff;
}

describe("provider handoff menu", () => {
  it("keeps direct new-conversation handoffs when the setting is off", async () => {
    const onCreateHandoff = await renderMenu(false);
    await expect.element(page.getByRole("menuitem", { name: "Claude", exact: true })).toBeVisible();
    expect(document.body.textContent).not.toContain("Continue here");
    await page.getByRole("menuitem", { name: "Claude", exact: true }).click();
    expect(onCreateHandoff).toHaveBeenCalledWith("claudeAgent", "new-thread");
  });

  it.each(["Continue here", "New conversation"] as const)(
    "selects the %s outcome",
    async (outcome) => {
      const onCreateHandoff = await renderMenu(true);
      await page.getByRole("menuitem", { name: outcome, exact: true }).click();
      await page.getByRole("menuitem", { name: "Grok", exact: true }).click();
      expect(onCreateHandoff).toHaveBeenCalledWith(
        "grok",
        outcome === "Continue here" ? "continue" : "new-thread",
      );
      await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
    },
  );

  it("dismisses with Escape without dispatching", async () => {
    const onCreateHandoff = await renderMenu(true);
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
    expect(onCreateHandoff).not.toHaveBeenCalled();
  });

  it("disables handoffs while a switch is pending", async () => {
    await render(
      <TooltipProvider>
        <ChatHandoffMenu
          {...defaults}
          handoffPending
          handoffDisabled
          continuousHandoffEnabled
          onCreateHandoff={vi.fn()}
        />
      </TooltipProvider>,
    );
    await expect
      .element(page.getByRole("button", { name: "Hand off", exact: true }))
      .toBeDisabled();
  });
});

it("exposes the entire compressed provider route on keyboard focus", async () => {
  const trail = Array.from({ length: 15 }, (_, index) => ({
    provider: index % 2 === 0 ? ("codex" as const) : ("claudeAgent" as const),
    isReturn: index > 1,
  }));
  await render(
    <TooltipProvider delay={0}>
      <ProviderHandoffTrail
        trail={trail}
        compact
        fallbackLabel={null}
        fallbackSourceProvider={null}
        fallbackTargetProvider={null}
      />
    </TooltipProvider>,
  );
  const trigger = document.querySelector<HTMLElement>('[data-slot="tooltip-trigger"]');
  expect(trigger?.tabIndex).toBe(0);
  await userEvent.tab();
  await expect.element(page.getByText("Provider path", { exact: true })).toBeVisible();
  const routeText =
    page.getByText("Provider path", { exact: true }).element().parentElement?.textContent ?? "";
  expect(routeText.match(/Codex/g)).toHaveLength(8);
  expect(routeText.match(/Claude/g)).toHaveLength(7);
  expect(trigger?.getAttribute("aria-label")).toContain("returned to Codex");
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByText("Provider path", { exact: true })).not.toBeInTheDocument();
});
