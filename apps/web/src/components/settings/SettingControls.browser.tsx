import "../../index.css";

import { page } from "vitest/browser";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { SelectItem } from "../ui/select";
import { SettingsSelectControl } from "./SettingControls";

it("lets the user choose an enabled provider while the saved default is hidden", async () => {
  const onValueChange = vi.fn();
  await render(
    <SettingsSelectControl
      value={null}
      onValueChange={onValueChange}
      ariaLabel="Default provider"
      valueContent="Choose an enabled provider"
    >
      <SelectItem value="claudeAgent">Claude</SelectItem>
    </SettingsSelectControl>,
  );
  await page.getByRole("combobox", { name: "Default provider" }).click();
  expect(page.getByRole("option", { name: "Codex", exact: true }).elements()).toHaveLength(0);
  await page.getByRole("option", { name: "Claude", exact: true }).click();
  expect(onValueChange).toHaveBeenCalledWith("claudeAgent");
});

it("disables the empty default-provider selector when every provider is disabled", async () => {
  await render(
    <SettingsSelectControl
      value={null}
      disabled
      onValueChange={vi.fn()}
      ariaLabel="Default provider"
      valueContent="Choose an enabled provider"
    >
      {null}
    </SettingsSelectControl>,
  );
  await expect.element(page.getByRole("combobox", { name: "Default provider" })).toBeDisabled();
});
