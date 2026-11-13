import "../../index.css";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { expect, it, vi } from "vitest";
import { ComputerPicker, type ComputerChoice } from "./ComputerPicker";

const computers: ComputerChoice[] = [
  { id: "local", label: "This computer", detail: "MacBook Pro", available: true },
  {
    id: "mini",
    label: "Macmini-di-Emanuele.local with a long name",
    detail: "Unavailable",
    available: false,
    reconnectable: true,
  },
];

it("reveals Reconnect on an unavailable computer and redials it without closing the menu", async () => {
  await page.viewport(900, 650);
  let finish!: () => void;
  const onReconnect = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const onChange = vi.fn();
  await render(
    <div className="bg-background p-3 text-foreground">
      <ComputerPicker
        computers={computers}
        value="local"
        purpose="Run on"
        onChange={onChange}
        onManage={() => {}}
        onReconnect={onReconnect}
      />
    </div>,
  );
  await page.getByRole("button", { name: "Run on: This computer" }).click();
  const row = page.getByRole("menuitem", { name: /Macmini-di-Emanuele/ });
  const action = row.getByText("Reconnect", { exact: true });
  await expect.poll(() => getComputedStyle(action.element().parentElement!).opacity).toBe("0");
  await row.hover();
  await expect.poll(() => getComputedStyle(action.element().parentElement!).opacity).toBe("1");
  // The label yields the action's width and fades under it instead of overlapping.
  const label = row.getByText(/Macmini-di-Emanuele/).element();
  expect(label.className).toContain("truncate-fade");
  expect(label.getBoundingClientRect().right).toBeLessThanOrEqual(
    action.element().getBoundingClientRect().left + 1,
  );

  await row.click();
  expect(onReconnect).toHaveBeenCalledWith("mini");
  expect(onChange).not.toHaveBeenCalled();
  await expect.element(row.getByText("Reconnecting…")).toBeVisible();
  finish();
  await expect.element(row.getByText("Unavailable")).toBeVisible();
  await expect.element(page.getByRole("menuitem", { name: /This computer/ })).toBeVisible();
});

it("keeps an unavailable computer disabled when the surface cannot reconnect it", async () => {
  await render(
    <ComputerPicker computers={computers} value="local" onChange={() => {}} onManage={() => {}} />,
  );
  await page.getByRole("button", { name: "Computer: This computer" }).click();
  await expect
    .element(page.getByRole("menuitem", { name: /Macmini-di-Emanuele/ }))
    .toHaveAttribute("aria-disabled", "true");
  await expect.element(page.getByText("Reconnect", { exact: true })).not.toBeInTheDocument();
});
