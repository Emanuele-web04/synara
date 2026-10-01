import "../../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { KeyboardShortcutsSettingsPanel } from "./KeyboardShortcutsSettingsPanel";
import { createBrowserTestServerConfig } from "../../test/browserHarness";
import { serverQueryKeys } from "../../lib/serverReactQuery";

const server = vi.hoisted(() => ({ upsertKeybinding: vi.fn() }));
vi.mock("../../nativeApi", () => ({ ensureNativeApi: () => ({ server }) }));
let screen: Awaited<ReturnType<typeof render>>;
afterEach(async () => {
  await screen?.unmount();
});

it.each([
  ["composer.voice.toggle", "Dictation: start/stop"],
  ["composer.voice.hold", "Dictation: hold to talk"],
])("assigns Option+Space to %s through the existing editor", async (command, label) => {
  const client = new QueryClient();
  client.setQueryData(
    serverQueryKeys.config(),
    createBrowserTestServerConfig("2026-10-01T00:00:00Z"),
  );
  server.upsertKeybinding.mockResolvedValue({
    keybindings: [
      {
        command,
        shortcut: {
          key: " ",
          altKey: true,
          modKey: false,
          ctrlKey: false,
          metaKey: false,
          shiftKey: false,
        },
      },
    ],
    issues: [],
  });
  screen = await render(
    <QueryClientProvider client={client}>
      <KeyboardShortcutsSettingsPanel />
    </QueryClientProvider>,
  );
  await page.getByRole("button", { name: "Set keybinding", exact: true }).click();
  await page.getByRole("combobox", { name: "Command for new keybinding" }).selectOptions(command);
  const input = document.querySelector<HTMLInputElement>(
    'input[aria-label="Press a key or combination"]',
  )!;
  input.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "\u00a0",
      code: "Space",
      altKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
  await expect.poll(() => input.value).toBe("alt+space");
  await page.getByRole("button", { name: "Save keybinding", exact: true }).click();
  await expect.element(page.getByText(label, { exact: true })).toBeVisible();
  expect(server.upsertKeybinding).toHaveBeenLastCalledWith({ rule: { command, key: "alt+space" } });
  await page.getByRole("searchbox", { name: "Search shortcuts" }).fill(label);
  await expect.element(page.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
});
