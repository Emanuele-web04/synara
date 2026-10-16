import "../../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { EditorExtensionsInput, EditorExtensionsResult } from "@synara/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { EditorExtensionsSettingsPanel } from "./EditorExtensionsSettingsPanel";

const tasks: (() => void)[] = [];
afterEach(async () => {
  await cleanup();
  for (const task of tasks.splice(0).reverse()) task();
});
const extension = {
  namespace: "example",
  name: "formatter",
  version: "1.0.0",
  displayName: "Example formatter",
  description: "Formatting tools",
  downloadCount: 1234,
};
const digest = "a".repeat(64);
async function mount(failure = false) {
  let state: EditorExtensionsResult = {
    apiVersion: "1.138.0",
    extensions: [],
    registryResults: [],
    trustedWorkspaces: [],
    runtime: "not-built",
  };
  let failCatalog = failure;
  const api = vi.fn(async (input: EditorExtensionsInput): Promise<EditorExtensionsResult> => {
    if (input.operation === "catalog") {
      if (failCatalog) {
        failCatalog = false;
        throw new Error("Registry temporarily unavailable");
      }
      return {
        ...state,
        registryResults: input.query === "missing" ? [] : [extension],
        registryTotal: input.query === "missing" ? 0 : 1,
      };
    }
    if (input.operation === "details")
      return { ...state, registryDetails: { ...extension, license: "MIT", apiRange: "^1.80.0" } };
    if (input.operation === "install")
      state = {
        ...state,
        extensions: [
          {
            id: "example.formatter",
            version: "1.0.0",
            displayName: extension.displayName,
            description: extension.description,
            digest,
            source: "open-vsx",
            enabled: false,
            approved: false,
            dependencies: [],
          },
        ],
      };
    if (input.operation === "setEnabled") {
      if (
        !input.consent?.some((entry) => entry.digest === digest && entry.id === "example.formatter")
      )
        throw new Error("Approval required");
      state = {
        ...state,
        extensions: state.extensions.map((entry) => ({ ...entry, enabled: true, approved: true })),
      };
    }
    return state;
  });
  const descriptor = Object.getOwnPropertyDescriptor(window, "nativeApi");
  Object.defineProperty(window, "nativeApi", {
    configurable: true,
    value: { editor: { extensions: api } },
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  tasks.push(() => {
    client.clear();
    if (descriptor) Object.defineProperty(window, "nativeApi", descriptor);
    else Reflect.deleteProperty(window, "nativeApi");
  });
  await render(
    <QueryClientProvider client={client}>
      <div style={{ width: 850 }}>
        <EditorExtensionsSettingsPanel />
      </div>
    </QueryClientProvider>,
  );
  return api;
}

it("loads a discoverable catalog, narrows categories and searches without submitting", async () => {
  const api = await mount();
  await expect
    .element(page.getByRole("button", { name: "Details for Example formatter" }))
    .toBeVisible();
  await page.getByRole("button", { name: "Formatters", exact: true }).click();
  await expect
    .poll(() =>
      api.mock.calls.some(
        ([input]) => input.operation === "catalog" && input.category === "Formatters",
      ),
    )
    .toBe(true);
  await page.getByRole("textbox", { name: "Search Open VSX" }).fill("missing");
  await expect.element(page.getByText("No matching extensions", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect
    .element(page.getByRole("button", { name: "Details for Example formatter" }))
    .toBeVisible();
});

it("shows a retryable registry error without hiding installed packages", async () => {
  await mount(true);
  await expect.element(page.getByText("Registry temporarily unavailable")).toBeVisible();
  await page.getByRole("radio", { name: /^Installed/ }).click();
  await expect
    .element(page.getByText("No editor extensions installed.", { exact: true }))
    .toBeVisible();
  await page.getByRole("radio", { name: "Marketplace", exact: true }).click();
  // Re-enabling a failed query may itself refetch. Retry only when still shown.
  await expect
    .element(page.getByRole("button", { name: "Details for Example formatter" }))
    .toBeVisible();
});

it("opens native details, restores focus, and requires explicit approval after install", async () => {
  const api = await mount();
  const detailsButton = page.getByRole("button", { name: "Details for Example formatter" });
  await detailsButton.click();
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await expect.element(page.getByText("MIT", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect.poll(() => document.activeElement === detailsButton.element()).toBe(true);
  await page.getByRole("button", { name: "Install", exact: true }).click();
  await expect
    .element(page.getByText("Package installed disabled. Review it in Installed before enabling."))
    .toBeVisible();
  expect(api.mock.calls.some(([input]) => input.operation === "setEnabled")).toBe(false);
  await page.getByRole("radio", { name: /^Installed/ }).click();
  await page.getByRole("button", { name: "Enable", exact: true }).click();
  await expect.element(page.getByRole("alertdialog")).toBeVisible();
  expect(api.mock.calls.some(([input]) => input.operation === "setEnabled")).toBe(false);
  await page.getByRole("button", { name: "Enable approved versions", exact: true }).click();
  await expect.element(page.getByRole("button", { name: "Disable", exact: true })).toBeVisible();
  const approved = api.mock.calls.find(([input]) => input.operation === "setEnabled")?.[0];
  expect(approved?.consent).toEqual([{ id: "example.formatter", digest }]);
  expect(api.mock.calls.some(([input]) => input.operation === "setTrust")).toBe(false);
});
