import "../../index.css";

import type { ResolvedKeybindingRule, ServerKeybindingEdit } from "@synara/contracts";
import { page, userEvent } from "vitest/browser";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useState } from "react";

import { buildShortcutEditorRows, type ShortcutEditorSource } from "~/keybindingEditor";
import { resolveShortcutCommand } from "~/keybindings";

import { ShortcutRecorderDialog, type ShortcutRecorderTarget } from "./ShortcutRecorderDialog";

function modRule(command: ResolvedKeybindingRule["command"], key: string): ResolvedKeybindingRule {
  return {
    command,
    shortcut: { key, modKey: true, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false },
  };
}

const KEYBINDINGS = [modRule("terminal.toggle", "j"), modRule("sidebar.toggle", "b")];
// A non-mac platform keeps the chords below on Ctrl, which every test browser delivers.
const SOURCE: ShortcutEditorSource = {
  keybindings: KEYBINDINGS,
  defaultKeybindings: KEYBINDINGS,
  platform: "Linux x86_64",
};

function targetFor(rowId: string): ShortcutRecorderTarget {
  const row = buildShortcutEditorRows(SOURCE).find((candidate) => candidate.id === rowId);
  if (!row) throw new Error(`no row ${rowId}`);
  return { row, binding: row.bindings[0] ?? null, source: SOURCE };
}

async function renderRecorder(rowId: string) {
  const onApply = vi.fn(async (_edits: ServerKeybindingEdit[]) => true);
  const onOpenChange = vi.fn();
  await render(
    <ShortcutRecorderDialog
      open
      target={targetFor(rowId)}
      onOpenChange={onOpenChange}
      onApply={onApply}
    />,
  );
  await expect.element(page.getByRole("dialog")).toBeVisible();
  return { onApply, onOpenChange };
}

it("records the pressed keys and saves them with Enter", async () => {
  const { onApply, onOpenChange } = await renderRecorder("terminal.toggle");

  await userEvent.keyboard("{Control>}{Shift>}k{/Shift}{/Control}");
  await expect.element(page.getByRole("status")).toHaveTextContent("Ctrl+Shift+K is available.");
  await userEvent.keyboard("{Enter}");

  await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  expect(onApply.mock.calls).toEqual([
    [
      [
        {
          type: "set",
          rule: { command: "terminal.toggle", key: "mod+shift+k" },
          replacing: { command: "terminal.toggle", key: "mod+j" },
        },
      ],
    ],
  ]);
});

it("says which command a shortcut is taken from before saving", async () => {
  const { onApply } = await renderRecorder("terminal.toggle");

  await userEvent.keyboard("{Control>}b{/Control}");
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("Ctrl+B already runs “Toggle sidebar”. Saving moves it here.");
  await page.getByRole("button", { name: "Save" }).click();

  await vi.waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
  expect(onApply.mock.calls[0]?.[0]).toEqual([
    { type: "remove", rule: { command: "sidebar.toggle", key: "mod+b" } },
    {
      type: "set",
      rule: { command: "terminal.toggle", key: "mod+b" },
      replacing: { command: "terminal.toggle", key: "mod+j" },
    },
  ]);
});

it("keeps a key that cannot be bound from being saved", async () => {
  const { onApply } = await renderRecorder("terminal.toggle");

  await userEvent.keyboard("k");
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("Add Ctrl or Alt to that key, or use an F-key on its own.");
  await expect.element(page.getByRole("button", { name: "Save" })).toBeDisabled();
  await userEvent.keyboard("{Enter}");

  expect(onApply).not.toHaveBeenCalled();
});

it("holds shortcuts while recording and resumes them after Escape cancels", async () => {
  const pressed = { key: "j", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false };
  const options = { platform: SOURCE.platform };
  expect(resolveShortcutCommand(pressed, KEYBINDINGS, options)).toBe("terminal.toggle");

  const onApply = vi.fn(async () => true);
  function RecorderHarness() {
    const [open, setOpen] = useState(true);
    return (
      <ShortcutRecorderDialog
        open={open}
        target={targetFor("terminal.toggle")}
        onOpenChange={setOpen}
        onApply={onApply}
      />
    );
  }
  await render(<RecorderHarness />);
  await expect.element(page.getByRole("dialog")).toBeVisible();
  expect(resolveShortcutCommand(pressed, KEYBINDINGS, options)).toBeNull();

  await userEvent.keyboard("{Control>}k{/Control}");
  await expect.element(page.getByRole("button", { name: "Save" })).toBeEnabled();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(onApply).not.toHaveBeenCalled();
  expect(resolveShortcutCommand(pressed, KEYBINDINGS, options)).toBe("terminal.toggle");
});
