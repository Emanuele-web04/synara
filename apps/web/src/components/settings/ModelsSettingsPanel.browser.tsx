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
  await userEvent.keyboard("{Enter}");
  const selectedOption = page.getByRole("option", { name: "Repository conventions", exact: true });
  await expect.element(selectedOption).toHaveFocus();
  await userEvent.keyboard("{End}");
  const customOption = page.getByRole("option", { name: "Custom instructions", exact: true });
  await expect.element(customOption).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  const field = page.getByRole("textbox", { name: "Custom source control writing instructions" });
  await expect.element(field).toBeVisible();
  await field.fill("Keep titles concise.");
  await userEvent.tab();
  const row = picker.element().closest('[data-slot="settings-row"]')!;
  expect(row.getBoundingClientRect().right).toBeLessThanOrEqual(360);
  expect(field.element().getBoundingClientRect().right).toBeLessThanOrEqual(360);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(360);
});
