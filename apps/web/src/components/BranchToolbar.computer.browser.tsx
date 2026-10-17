import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import "../index.css";
import { useState } from "react";
import { ProviderInstanceId, type RuntimeMode } from "@synara/contracts";
import { RuntimeUsageControls } from "./BranchToolbar";

afterEach(() => cleanup());

function Controls({ initialMode = "approval-required" }: { initialMode?: RuntimeMode }) {
  const [mode, setMode] = useState<RuntimeMode>(initialMode);
  return (
    <RuntimeUsageControls
      provider="codex"
      providerStatus={{
        provider: "codex",
        driver: "codex",
        instanceId: ProviderInstanceId.makeUnsafe("codex"),
        status: "ready",
        available: true,
        authStatus: "authenticated",
        checkedAt: "2026-10-11T00:00:00.000Z",
        supportsAutoRuntimeMode: true,
      }}
      runtimeMode={mode}
      onRuntimeModeChange={setMode}
    />
  );
}

describe("task-invoked Computer", () => {
  it("identifies a saved access mode that will apply after the active turn", async () => {
    await render(
      <RuntimeUsageControls
        runtimeMode="full-access"
        activeRuntimeMode="approval-required"
        onRuntimeModeChange={() => {}}
      />,
    );
    await expect
      .element(page.getByRole("button", { name: /Full access.*next turn/ }))
      .toBeVisible();
    expect(page.getByRole("button").element().getAttribute("title")).toContain("Ask for approval");
  });

  it("keeps access rules available without a persistent Computer switch", async () => {
    const onRuntime = vi.fn();
    await render(
      <RuntimeUsageControls runtimeMode="approval-required" onRuntimeModeChange={onRuntime} />,
    );
    await page.getByRole("button").click();
    await expect
      .element(page.getByRole("menuitemradio", { name: /Computer:/ }))
      .not.toBeInTheDocument();
    await page.getByRole("menuitemradio", { name: /Full access/ }).click();
    expect(onRuntime).toHaveBeenCalledExactlyOnceWith("full-access");
    await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
  });
  it("keeps permission descriptions in place when the selection changes", async () => {
    await render(<Controls />);
    await page.getByRole("button").click();
    const item = page.getByRole("menuitemradio", { name: /Full access/ });
    const description = item.element().querySelector(".runtime-mode-menu-description")!;
    const before = description.getBoundingClientRect();
    await item.click();
    await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
    await page.getByRole("button").click();
    await expect.element(item).toHaveAttribute("aria-checked", "true");
    const after = item
      .element()
      .querySelector(".runtime-mode-menu-description")!
      .getBoundingClientRect();
    expect(after.width).toBe(before.width);
    expect(after.x).toBe(before.x);
    expect(after.height).toBe(before.height);
  });
  it("distinguishes selection independently of the Full access accent", async () => {
    await render(<Controls initialMode="auto" />);
    await page.getByRole("button").click();
    const auto = page.getByRole("menuitemradio", { name: /Approve for me/ });
    const full = page.getByRole("menuitemradio", { name: /Full access/ });
    const approval = page.getByRole("menuitemradio", { name: /Ask for approval/ });
    expect(getComputedStyle(auto.element()).color).toBe(getComputedStyle(approval.element()).color);
    expect(getComputedStyle(full.element()).color).not.toBe(getComputedStyle(auto.element()).color);
    expect(getComputedStyle(auto.element()).backgroundColor).not.toBe(
      getComputedStyle(full.element()).backgroundColor,
    );
    await full.click();
    await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
    await page.getByRole("button").click();
    await expect.element(full).toHaveAttribute("aria-checked", "true");
    expect(getComputedStyle(full.element()).backgroundColor).not.toBe(
      getComputedStyle(auto.element()).backgroundColor,
    );
    await full.click();
    await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
  });
});
