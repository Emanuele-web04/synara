import "../../../index.css";

import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { AppSettingsSchema, type AppSettings } from "~/appSettings";

import { DefaultNewChatAccountRow } from "./DefaultNewChatAccountRow";

const defaults = AppSettingsSchema.makeUnsafe({});

function settingsWith(patch: Partial<AppSettings>): AppSettings {
  return {
    ...defaults,
    providerInstances: {
      claude_work: { driver: "claudeAgent", displayName: "Work", enabled: true },
      claude_off: { driver: "claudeAgent", displayName: "Off", enabled: false },
    },
    ...patch,
  };
}

async function mount(settings: AppSettings) {
  const updateSettings = vi.fn();
  await render(
    <DefaultNewChatAccountRow
      settings={settings}
      defaults={defaults}
      updateSettings={updateSettings}
    />,
  );
  return updateSettings;
}

describe("DefaultNewChatAccountRow", () => {
  it("lists enabled accounts and stores both the agent and the account", async () => {
    const updateSettings = await mount(settingsWith({}));
    const select = page.getByRole("combobox", { name: "Agent and account" });
    await expect.element(select).toHaveTextContent("Codex");
    expect(
      page.getByRole("button", { name: "Reset agent and account to default" }).elements(),
    ).toHaveLength(0);

    await select.click();
    await expect.element(page.getByRole("option", { name: "Claude · Work" })).toBeVisible();
    await expect.element(page.getByRole("option", { name: "Claude", exact: true })).toBeVisible();
    expect(page.getByRole("option", { name: "Claude · Off" }).elements()).toHaveLength(0);

    await page.getByRole("option", { name: "Claude · Work" }).click();
    expect(updateSettings).toHaveBeenCalledExactlyOnceWith({
      defaultProvider: "claudeAgent",
      defaultProviderInstanceId: "claude_work",
    });
  });

  it("stores an agent's default account as empty", async () => {
    const updateSettings = await mount(
      settingsWith({ defaultProvider: "claudeAgent", defaultProviderInstanceId: "claude_work" }),
    );
    await page.getByRole("combobox", { name: "Agent and account" }).click();
    await page.getByRole("option", { name: "Codex", exact: true }).click();
    expect(updateSettings).toHaveBeenCalledExactlyOnceWith({
      defaultProvider: "codex",
      defaultProviderInstanceId: "",
    });
  });

  it("asks for an enabled account when the stored one is gone, and resets both fields", async () => {
    const updateSettings = await mount(
      settingsWith({ defaultProvider: "claudeAgent", defaultProviderInstanceId: "claude_off" }),
    );
    await expect
      .element(page.getByRole("combobox", { name: "Agent and account" }))
      .toHaveTextContent("Choose an enabled account");

    await page.getByRole("button", { name: "Reset agent and account to default" }).click();
    expect(updateSettings).toHaveBeenCalledExactlyOnceWith({
      defaultProvider: "codex",
      defaultProviderInstanceId: "",
    });
  });
});
