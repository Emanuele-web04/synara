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

let session = 0;

function targetFor(rowId: string, source = SOURCE): ShortcutRecorderTarget {
  const row = buildShortcutEditorRows(source).find((candidate) => candidate.id === rowId);
  if (!row) throw new Error(`no row ${rowId}`);
  session += 1;
  return { row, binding: row.bindings[0] ?? null, session };
}

async function renderRecorder(rowId: string, source = SOURCE) {
  const onApply = vi.fn(async (_edits: ServerKeybindingEdit[]) => true);
  const onOpenChange = vi.fn();
  await render(
    <ShortcutRecorderDialog
      open
      target={targetFor(rowId, source)}
      source={source}
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

it("records and moves the file-search chord instead of treating it as fixed", async () => {
  const search: ResolvedKeybindingRule = {
    ...modRule("search.files", "p"),
    whenAst: { type: "not", node: { type: "identifier", name: "terminalFocus" } },
  };
  const source: ShortcutEditorSource = {
    ...SOURCE,
    keybindings: [...KEYBINDINGS, search],
    defaultKeybindings: [...KEYBINDINGS, search],
  };
  const { onApply } = await renderRecorder("terminal.toggle", source);

  await userEvent.keyboard("{Control>}p{/Control}");
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("Ctrl+P already runs “Search files”. Saving moves it here.");
  await userEvent.keyboard("{Enter}");

  await vi.waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
  expect(onApply.mock.calls[0]?.[0]).toEqual([
    { type: "remove", rule: { command: "search.files", key: "mod+p", when: "!terminalFocus" } },
    {
      type: "set",
      rule: { command: "terminal.toggle", key: "mod+p" },
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
  const target = targetFor("terminal.toggle");
  function RecorderHarness() {
    const [open, setOpen] = useState(true);
    return (
      <ShortcutRecorderDialog
        open={open}
        target={target}
        source={SOURCE}
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

it("starts fresh when reopened while it is still closing, and frees the keys at once", async () => {
  const pressed = { key: "j", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false };
  const options = { platform: SOURCE.platform };
  const props = { source: SOURCE, onOpenChange: () => {}, onApply: async () => true };
  const first = targetFor("terminal.toggle");
  const screen = await render(<ShortcutRecorderDialog open target={first} {...props} />);
  await userEvent.keyboard("{Control>}k{/Control}");
  await expect.element(page.getByRole("status")).toHaveTextContent("Ctrl+K is available.");

  // Closing hands the keyboard back before the closing animation ends.
  await screen.rerender(<ShortcutRecorderDialog open={false} target={first} {...props} />);
  expect(resolveShortcutCommand(pressed, KEYBINDINGS, options)).toBe("terminal.toggle");

  await screen.rerender(
    <ShortcutRecorderDialog open target={targetFor("sidebar.toggle")} {...props} />,
  );
  await expect.element(page.getByRole("dialog")).toHaveTextContent("Toggle sidebar");
  await expect.element(page.getByRole("status")).not.toHaveTextContent("Ctrl+K");
  await expect.element(page.getByRole("button", { name: "Save" })).toBeDisabled();
});

it("stops a save when the shortcut changed elsewhere while it was open", async () => {
  const props = { onOpenChange: () => {}, onApply: vi.fn(async () => true) };
  const target = targetFor("terminal.toggle");
  const screen = await render(
    <ShortcutRecorderDialog open target={target} source={SOURCE} {...props} />,
  );
  await userEvent.keyboard("{Control>}k{/Control}");
  await expect.element(page.getByRole("button", { name: "Save" })).toBeEnabled();

  const changed = { ...SOURCE, keybindings: [modRule("terminal.toggle", "l"), KEYBINDINGS[1]!] };
  await screen.rerender(
    <ShortcutRecorderDialog open target={target} source={changed} {...props} />,
  );

  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("This shortcut changed while the dialog was open.");
  await expect.element(page.getByRole("button", { name: "Save" })).toBeDisabled();
  expect(props.onApply).not.toHaveBeenCalled();
});

it("does not call a refetch of the same bindings a change", async () => {
  const props = { onOpenChange: () => {}, onApply: vi.fn(async () => true) };
  const target = targetFor("terminal.toggle");
  const screen = await render(
    <ShortcutRecorderDialog open target={target} source={SOURCE} {...props} />,
  );
  await userEvent.keyboard("{Control>}k{/Control}");

  const refetched = structuredClone(SOURCE);
  await screen.rerender(
    <ShortcutRecorderDialog open target={target} source={refetched} {...props} />,
  );

  await expect.element(page.getByRole("status")).toHaveTextContent("Ctrl+K is available.");
  await expect.element(page.getByRole("button", { name: "Save" })).toBeEnabled();
});

it("does not close a newer dialog when an earlier save finishes late", async () => {
  let finishSave: (applied: boolean) => void = () => {};
  const onApply = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finishSave = resolve;
      }),
  );
  const onOpenChange = vi.fn();
  const props = { source: SOURCE, onOpenChange, onApply };
  const first = targetFor("terminal.toggle");
  const screen = await render(<ShortcutRecorderDialog open target={first} {...props} />);
  await userEvent.keyboard("{Control>}k{/Control}");
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));

  // Escape closed it mid-save, and the user opened another row.
  await screen.rerender(<ShortcutRecorderDialog open={false} target={first} {...props} />);
  await screen.rerender(
    <ShortcutRecorderDialog open target={targetFor("sidebar.toggle")} {...props} />,
  );
  finishSave(true);
  await new Promise((resolve) => setTimeout(resolve, 50));

  expect(onOpenChange).not.toHaveBeenCalled();
  await expect.element(page.getByRole("dialog")).toHaveTextContent("Toggle sidebar");
});

it("says which shortcut a reset takes back before doing it", async () => {
  // Toggle sidebar picked up Toggle terminal's shipped Ctrl+J, leaving it unassigned.
  const unassigned = modRule("terminal.toggle", "unassigned");
  const moved: ShortcutEditorSource = {
    ...SOURCE,
    keybindings: [
      modRule("sidebar.toggle", "j"),
      { ...unassigned, shortcut: { ...unassigned.shortcut, modKey: false } },
    ],
  };
  const { onApply } = await renderRecorder("terminal.toggle", moved);

  await page.getByRole("button", { name: "Reset to default" }).click();
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("Resetting takes back Ctrl+J from “Toggle sidebar”.");
  expect(onApply).not.toHaveBeenCalled();

  await page.getByRole("button", { name: "Reset anyway" }).click();
  await vi.waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
  expect(onApply.mock.calls[0]?.[0]).toEqual([
    { type: "remove", rule: { command: "sidebar.toggle", key: "mod+j" } },
    { type: "reset", command: "terminal.toggle" },
  ]);
});

it("warns when the chord types a character on the user's keyboard", async () => {
  await renderRecorder("terminal.toggle");

  // AltGr+Q types "@" on a German keyboard; the shortcut is recorded on the Q key.
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "@", code: "KeyQ", ctrlKey: true, altKey: true }),
  );
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("On your keyboard, Ctrl+Alt+Q types “@”.");
  await expect.element(page.getByRole("button", { name: "Save" })).toBeEnabled();
});
