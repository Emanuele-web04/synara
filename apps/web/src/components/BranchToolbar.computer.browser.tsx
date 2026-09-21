import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { RuntimeUsageControls } from "./BranchToolbar";

afterEach(() => cleanup());

describe("task-invoked Computer", () => {
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
  });

  it("does not add a Computer badge to the composer", async () => {
    await render(
      <RuntimeUsageControls runtimeMode="approval-required" onRuntimeModeChange={() => {}} />,
    );
    await expect.element(page.getByText(/Computer/)).not.toBeInTheDocument();
  });
});
