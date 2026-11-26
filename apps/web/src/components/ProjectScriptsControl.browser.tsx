// FILE: ProjectScriptsControl.browser.tsx
// Purpose: Browser regressions for the chat-header project action control.
// Layer: Browser UI test

import "../index.css";

import { type ProjectScript, type ResolvedKeybindingsConfig } from "@synara/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import ProjectScriptsControl, { type NewProjectScriptInput } from "./ProjectScriptsControl";

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];

async function mountProjectScriptsControl(props?: {
  scripts?: ProjectScript[];
  preferredScriptId?: string | null;
}) {
  const onRunScript = vi.fn();
  const onAddScript = vi.fn<(input: NewProjectScriptInput) => void>();
  const onUpdateScript = vi.fn<(scriptId: string, input: NewProjectScriptInput) => void>();
  const onDeleteScript = vi.fn<(scriptId: string) => void>();
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(
    <ProjectScriptsControl
      scripts={props?.scripts ?? []}
      keybindings={EMPTY_KEYBINDINGS}
      preferredScriptId={props?.preferredScriptId ?? null}
      onRunScript={onRunScript}
      onAddScript={onAddScript}
      onUpdateScript={onUpdateScript}
      onDeleteScript={onDeleteScript}
    />,
    { container: host },
  );

  const cleanup = async () => {
    await screen.unmount();
    host.remove();
  };

  return {
    [Symbol.asyncDispose]: cleanup,
    cleanup,
    onRunScript,
    onAddScript,
    onUpdateScript,
    onDeleteScript,
  };
}

describe("ProjectScriptsControl", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders no header control until a script exists", async () => {
    await using _ = await mountProjectScriptsControl();

    // The slot is the header's New thread button now; the control itself stays empty, and
    // creating the first action moved to the Environment panel's Actions section.
    expect(page.getByRole("button", { name: "Add action" }).elements()).toHaveLength(0);
    expect(page.getByRole("button", { name: "Script actions" }).elements()).toHaveLength(0);
  });

  it("runs the primary action and exposes setup actions in the dropdown", async () => {
    const setupScript: ProjectScript = {
      id: "setup",
      name: "Setup",
      command: "bun install",
      icon: "configure",
      runOnWorktreeCreate: true,
    };
    await using control = await mountProjectScriptsControl({
      scripts: [setupScript],
      preferredScriptId: "setup",
    });

    await page.getByRole("button", { name: "Run Setup" }).click();
    expect(control.onRunScript).toHaveBeenCalledWith(setupScript);

    await page.getByLabelText("Script actions").click();
    await expect.poll(() => document.body.textContent).toContain("Setup (setup)");
    await expect.poll(() => document.body.textContent).toContain("Add action");
  });
});
