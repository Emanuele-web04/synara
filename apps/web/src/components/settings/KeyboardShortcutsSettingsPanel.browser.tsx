import "../../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { KeyboardShortcutsSettingsPanel } from "./KeyboardShortcutsSettingsPanel";
import { createBrowserTestServerConfig } from "../../test/browserHarness";
import { serverQueryKeys } from "../../lib/serverReactQuery";

const server = vi.hoisted(() => ({ editKeybindings: vi.fn() }));
vi.mock("../../nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../nativeApi")>()),
  ensureNativeApi: () => ({ server }),
}));
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
  server.editKeybindings.mockResolvedValue({
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
  await page.getByRole("searchbox", { name: "Search shortcuts" }).fill(label);
  await page.getByRole("button", { name: `Set a shortcut for ${label}`, exact: true }).click();
  await expect.element(page.getByRole("dialog")).toBeVisible();
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "\u00a0",
      code: "Space",
      altKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
  await expect.element(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(server.editKeybindings).toHaveBeenLastCalledWith({
    edits: [{ type: "set", rule: { command, key: "alt+space" } }],
  });
  await expect
    .element(
      page.getByRole("button", { name: new RegExp(`^Change the shortcut .* for ${label}$`) }),
    )
    .toBeVisible();
});
