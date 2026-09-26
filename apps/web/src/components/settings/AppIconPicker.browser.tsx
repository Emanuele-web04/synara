// FILE: AppIconPicker.browser.tsx
// Purpose: Verify the visual app-icon picker exposes and applies platform-supported choices.
// Layer: Browser UI test

import "../../index.css";

import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { AppIconPicker } from "./AppIconPicker";

it("shows a loading state and ignores extra clicks while an apply is in flight", async () => {
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const onValueChange = vi.fn(() => pending);
  const mounted = await render(
    <AppIconPicker platform="Win32" value="default" onValueChange={onValueChange} />,
  );

  const iconButton = mounted.getByRole("button", { name: "Icon", exact: true });
  const defaultIconButton = mounted.getByRole("button", { name: "Default icon" });
  await iconButton.click();
  await expect.element(mounted.getByRole("status", { name: "Updating app icon" })).toBeVisible();
  await expect.element(defaultIconButton).toBeDisabled();
  await expect.element(iconButton).toBeDisabled();
  expect(onValueChange).toHaveBeenCalledTimes(1);

  release?.();
  await vi.waitFor(() => expect.element(defaultIconButton).toBeEnabled());
  expect(onValueChange).toHaveBeenCalledTimes(1);
});

it("clears the loading state without leaking a rejected apply", async () => {
  const applyError = new Error("native icon apply failed");
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    event.preventDefault();
    unhandledRejections.push(event.reason);
  };
  window.addEventListener("unhandledrejection", onUnhandledRejection);

  try {
    const mounted = await render(
      <AppIconPicker
        platform="Win32"
        value="default"
        onValueChange={() => Promise.reject(applyError)}
      />,
    );
    const iconButton = mounted.getByRole("button", { name: "Icon", exact: true });

    await iconButton.click();
    await vi.waitFor(() => expect.element(iconButton).toBeEnabled());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(unhandledRejections).toEqual([]);
  } finally {
    window.removeEventListener("unhandledrejection", onUnhandledRejection);
  }
});

it("offers the dark icon on macOS", async () => {
  const onValueChange = vi.fn();
  const mounted = await render(
    <AppIconPicker platform="MacIntel" value="default" onValueChange={onValueChange} />,
  );

  const darkIconButton = mounted.getByRole("button", { name: "Dark icon" });
  await expect.element(darkIconButton).toBeVisible();
  await darkIconButton.click();

  expect(onValueChange).toHaveBeenCalledWith("dark");
});

it("hides the unsupported dark icon off macOS", async () => {
  const mounted = await render(
    <AppIconPicker platform="Win32" value="default" onValueChange={vi.fn()} />,
  );

  await expect.element(mounted.getByRole("button", { name: "Dark icon" })).not.toBeInTheDocument();
});
