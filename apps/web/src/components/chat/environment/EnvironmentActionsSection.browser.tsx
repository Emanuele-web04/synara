// FILE: EnvironmentActionsSection.browser.tsx
// Purpose: Browser regressions for the Environment panel's Actions section — the surface
//          that now owns creating the first project action after the top bar slot became
//          the New thread button.
// Layer: Browser UI test

import "../../../index.css";

import { type ProjectScript, type ResolvedKeybindingsConfig } from "@synara/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { NewProjectScriptInput } from "../ProjectActionDialog";
import { EnvironmentActionsSection } from "./EnvironmentActionsSection";

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];

async function mountActionsSection(scripts: ProjectScript[] = []) {
  const onRunScript = vi.fn();
  const onAddScript = vi.fn<(input: NewProjectScriptInput) => void>();
  const onUpdateScript = vi.fn<(scriptId: string, input: NewProjectScriptInput) => void>();
  const onDeleteScript = vi.fn<(scriptId: string) => void>();
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(
    <EnvironmentActionsSection
      scripts={scripts}
      keybindings={EMPTY_KEYBINDINGS}
      onRunScript={onRunScript}
      onAddScript={onAddScript}
      onUpdateScript={onUpdateScript}
      onDeleteScript={onDeleteScript}
    />,
    { container: host },
  );

  return {
    onRunScript,
    onAddScript,
    onUpdateScript,
    onDeleteScript,
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

describe("EnvironmentActionsSection", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("points at the empty state until an action exists", async () => {
    const section = await mountActionsSection();
    try {
      expect(document.body.textContent).toContain("No actions yet.");
      expect(page.getByRole("button", { name: "Run Setup" }).elements()).toHaveLength(0);
    } finally {
      await section.cleanup();
    }
  });

  it("runs an action from its row", async () => {
    const script: ProjectScript = {
      id: "test",
      name: "Test",
      command: "bun test",
      icon: "test",
      runOnWorktreeCreate: false,
    };
    const section = await mountActionsSection([script]);
    try {
      await page.getByRole("button", { name: "Run Test" }).click();
      expect(section.onRunScript).toHaveBeenCalledWith(script);
    } finally {
      await section.cleanup();
    }
  });

  it("creates an action through the shared dialog", async () => {
    const section = await mountActionsSection();
    try {
      await page.getByRole("button", { name: "Add action" }).click();
      await expect.poll(() => document.body.textContent).toContain("Add Action");

      await page.getByLabelText("Name").fill("Deploy");
      await page.getByLabelText("Command").fill("bun run deploy");
      await page.getByRole("button", { name: "Save action" }).click();

      expect(section.onAddScript).toHaveBeenCalledWith({
        name: "Deploy",
        command: "bun run deploy",
        icon: "play",
        runOnWorktreeCreate: false,
        keybinding: null,
      });
    } finally {
      await section.cleanup();
    }
  });
});
