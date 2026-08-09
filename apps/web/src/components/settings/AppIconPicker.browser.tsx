// FILE: AppIconPicker.browser.tsx
// Purpose: Verify the visual app-icon picker exposes and applies the two supported choices.
// Layer: Browser UI test

import "../../index.css";

import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { AppIconPicker } from "./AppIconPicker";

it("labels the new artwork as Icon and selects it", async () => {
  const onValueChange = vi.fn();
  const mounted = await render(<AppIconPicker value="default" onValueChange={onValueChange} />);

  await expect.element(mounted.getByRole("button", { name: "Default icon" })).toBeVisible();
  const iconButton = mounted.getByRole("button", { name: "Icon", exact: true });
  const buttonRect = iconButton.element().getBoundingClientRect();
  const artworkRect = iconButton.element().querySelector("img")?.getBoundingClientRect();

  expect(buttonRect.width).toBe(64);
  expect(artworkRect?.width).toBe(44);
  expect(artworkRect?.left).toBe(buttonRect.left + 10);
  expect(artworkRect?.top).toBe(buttonRect.top + 10);

  await iconButton.click();

  expect(onValueChange).toHaveBeenCalledWith("icon");
});
