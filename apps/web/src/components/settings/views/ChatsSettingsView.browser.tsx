// FILE: ChatsSettingsView.browser.tsx
// Purpose: Prove the transcript-detail segmented control changes aria state and stores its
//          value on a real click, instead of only after a manual localStorage write + reload.
// Layer: Browser UI test

import "../../../index.css";

import { type AppSettings, AppSettingsSchema } from "~/appSettings";
import { useState } from "react";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ChatsSettingsView } from "./ChatsSettingsView";

const DEFAULTS = AppSettingsSchema.makeUnsafe({});
const INITIAL: AppSettings = { ...DEFAULTS, transcriptDetail: "standard" };

function SettingsHarness({ onUpdate }: { onUpdate: (patch: Partial<AppSettings>) => void }) {
  const [settings, setSettings] = useState(INITIAL);
  return (
    <ChatsSettingsView
      settings={settings}
      defaults={DEFAULTS}
      updateSettings={(patch) => {
        onUpdate(patch);
        setSettings((current) => ({ ...current, ...patch }));
      }}
    />
  );
}

function transcriptDetailOption(name: string) {
  return page
    .getByRole("radiogroup", { name: "Transcript detail" })
    .getByRole("radio", { name, exact: true });
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  document.body.innerHTML = "";
});

it("stores the transcript detail level when an option is clicked", async () => {
  const onUpdate = vi.fn();
  await render(<SettingsHarness onUpdate={onUpdate} />);

  expect(transcriptDetailOption("Standard").element().getAttribute("aria-checked")).toBe("true");
  expect(transcriptDetailOption("Full").element().getAttribute("aria-checked")).toBe("false");

  await transcriptDetailOption("Full").click();

  await expect.element(transcriptDetailOption("Full")).toHaveAttribute("aria-checked", "true");
  expect(transcriptDetailOption("Standard").element().getAttribute("aria-checked")).toBe("false");
  expect(onUpdate).toHaveBeenLastCalledWith({ transcriptDetail: "full" });

  await transcriptDetailOption("Messages").click();

  await expect.element(transcriptDetailOption("Messages")).toHaveAttribute("aria-checked", "true");
  expect(transcriptDetailOption("Full").element().getAttribute("aria-checked")).toBe("false");
  expect(onUpdate).toHaveBeenLastCalledWith({ transcriptDetail: "messages" });

  expect(onUpdate.mock.calls).toEqual([
    [{ transcriptDetail: "full" }],
    [{ transcriptDetail: "messages" }],
  ]);
});

it("only changes the value from the option button, not from the row around it", async () => {
  const onUpdate = vi.fn();
  await render(<SettingsHarness onUpdate={onUpdate} />);

  const row = document.getElementById("setting-transcript-detail");
  expect(row).not.toBeNull();
  expect(transcriptDetailOption("Full").element().tagName).toBe("BUTTON");

  const description = userEvent.click(row!.querySelector("p")!);
  await description;

  expect(onUpdate).not.toHaveBeenCalled();
  expect(transcriptDetailOption("Standard").element().getAttribute("aria-checked")).toBe("true");
});
