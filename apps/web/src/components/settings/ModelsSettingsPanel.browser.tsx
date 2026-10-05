import "../../index.css";

import { useState } from "react";
import { page, userEvent } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: () => ({ data: { cwd: "/tmp" } }),
}));
vi.mock("~/hooks/useProviderModelCatalog", () => ({
  useProviderModelCatalog: () => ({ modelOptionsByProviderInstance: {} }),
}));

import { AppSettingsSchema, type AppSettings } from "~/appSettings";
import { ModelsSettingsPanel } from "./ModelsSettingsPanel";

const defaults = AppSettingsSchema.makeUnsafe({});

function Harness() {
  const [settings, setSettings] = useState(defaults);
  return (
    <div className="p-4">
      <ModelsSettingsPanel
        settings={settings}
        defaults={defaults}
        updateSettings={(patch: Partial<AppSettings>) =>
          setSettings((current) => ({ ...current, ...patch }))
        }
        resetEpoch={0}
        active
      />
    </div>
  );
}

afterEach(cleanup);

it("switches descriptions, saves custom text, preserves it across styles, and resets the row", async () => {
  await page.viewport(1280, 800);
  await render(<Harness />);
  const picker = page.getByRole("combobox", { name: "Source control writing style" });
  expect(document.body.textContent).toContain(
    "In each project, matches recent change descriptions and change request titles.",
  );
  await picker.click();
  await page.getByRole("option", { name: "Conventional Commits", exact: true }).click();
  expect(document.body.textContent).toContain(
    "Use Conventional Commit prefixes and keep change request text concise.",
  );
  await picker.click();
  await page.getByRole("option", { name: "Custom instructions", exact: true }).click();
  const field = page.getByRole("textbox", { name: "Custom source control writing instructions" });
  await field.fill("Use concise titles.\nUse short bullets.");
  await picker.click();
  await page.getByRole("option", { name: "Repository conventions", exact: true }).click();
  expect(document.querySelector("textarea")?.closest("[inert]")).not.toBeNull();
  await picker.click();
  await page.getByRole("option", { name: "Custom instructions", exact: true }).click();
  expect((field.element() as HTMLTextAreaElement).value).toBe(
    "Use concise titles.\nUse short bullets.",
  );
  await page.getByRole("button", { name: "Reset source control writing style to default" }).click();
  expect(picker.element().textContent).toContain("Repository conventions");
  await picker.click();
  await page.getByRole("option", { name: "Custom instructions", exact: true }).click();
  expect((field.element() as HTMLTextAreaElement).value).toBe("");
});

it("supports keyboard selection and keeps the custom editor within a narrow viewport", async () => {
  await page.viewport(360, 800);
  await render(<Harness />);
  const picker = page.getByRole("combobox", { name: "Source control writing style" });
  (picker.element() as HTMLElement).focus();
  await userEvent.keyboard("{Enter}{End}{Enter}");
  const field = page.getByRole("textbox", { name: "Custom source control writing instructions" });
  await expect.element(field).toBeVisible();
  await field.fill("Keep titles concise.");
  await userEvent.tab();
  const row = picker.element().closest('[data-slot="settings-row"]')!;
  expect(row.getBoundingClientRect().right).toBeLessThanOrEqual(360);
  expect(field.element().getBoundingClientRect().right).toBeLessThanOrEqual(360);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(360);
});

it("hides disabled providers and their saved models without losing configuration", async () => {
  const settings: AppSettings = {
    ...defaults,
    customCodexModels: ["private-codex-model"],
    customClaudeModels: ["private-claude-model"],
    disabledProviders: ["codex"],
  };
  const props = { defaults, settings, updateSettings: vi.fn(), resetEpoch: 0, active: true };
  const screen = await render(<ModelsSettingsPanel {...props} />);
  expect(document.body.textContent).not.toContain("private-codex-model");
  expect(document.body.textContent).toContain("private-claude-model");
  const picker = page.getByRole("combobox", { name: "Custom model provider", exact: true });
  expect(picker.element().textContent).not.toContain("Codex");
  await picker.click();
  expect(page.getByRole("option", { name: "Codex", exact: true }).elements()).toHaveLength(0);
  await userEvent.keyboard("{Escape}");
  await screen.rerender(
    <ModelsSettingsPanel {...props} settings={{ ...settings, disabledProviders: [] }} />,
  );
  expect(document.body.textContent).toContain("private-codex-model");
  expect(picker.element().textContent).toContain("Codex");
});

it("removes the custom model editor when all its providers are disabled", async () => {
  await render(
    <ModelsSettingsPanel
      defaults={defaults}
      settings={{ ...defaults, disabledProviders: [...defaults.providerOrder] }}
      updateSettings={vi.fn()}
      resetEpoch={0}
      active
    />,
  );
  expect(
    page.getByRole("combobox", { name: "Custom model provider", exact: true }).elements(),
  ).toHaveLength(0);
  expect(page.getByRole("button", { name: "Add", exact: true }).elements()).toHaveLength(0);
});
