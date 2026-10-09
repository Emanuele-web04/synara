import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import "../index.css";
import { Dialog, DialogPopup, DialogTitle } from "../components/ui/dialog";
import { suspendShortcutDispatch } from "../keybindings";
import { useSettingsEscapeToHome } from "./useSettingsEscapeToHome";

let root: Root;
let host: HTMLDivElement;
let homeVisits: number;

function Harness({ enabled, dialogOpen = false }: { enabled: boolean; dialogOpen?: boolean }) {
  const [open, setOpen] = useState(dialogOpen);
  useSettingsEscapeToHome(enabled, () => {
    homeVisits += 1;
  });
  return (
    <>
      <button type="button">Section</button>
      <input aria-label="Search settings" />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup>
          <DialogTitle>Add account</DialogTitle>
        </DialogPopup>
      </Dialog>
    </>
  );
}

function render(enabled: boolean, dialogOpen = false) {
  flushSync(() => root.render(<Harness enabled={enabled} dialogOpen={dialogOpen} />));
}

function pressEscape(target: EventTarget, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key: "Escape",
    code: "Escape",
    bubbles: true,
    cancelable: true,
    ...init,
  });
  flushSync(() => target.dispatchEvent(event));
  return event;
}

beforeEach(() => {
  homeVisits = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

describe("useSettingsEscapeToHome", () => {
  it("goes Home on a bare Escape while Settings is open", () => {
    render(true);
    expect(pressEscape(host.querySelector("button")!).defaultPrevented).toBe(true);
    expect(homeVisits).toBe(1);
  });

  it("stays idle outside Settings and for chords, repeats, and composition", () => {
    render(false);
    pressEscape(document.body);
    render(true);
    pressEscape(document.body, { metaKey: true });
    pressEscape(document.body, { shiftKey: true });
    pressEscape(document.body, { repeat: true });
    pressEscape(document.body, { isComposing: true });
    expect(homeVisits).toBe(0);
  });

  it("leaves Escape to text fields, the shortcut recorder, and handlers that consume it", () => {
    render(true);
    pressEscape(host.querySelector("input")!);
    const resume = suspendShortcutDispatch();
    try {
      pressEscape(document.body);
    } finally {
      resume();
    }
    const button = host.querySelector("button")!;
    button.addEventListener("keydown", (event) => event.preventDefault(), { once: true });
    pressEscape(button);
    expect(homeVisits).toBe(0);
  });

  it("only closes an open dialog, then goes Home on the next Escape", async () => {
    render(true, true);
    await expect.poll(() => document.querySelector('[role="dialog"]')).not.toBeNull();
    pressEscape(document.activeElement ?? document.body);
    await expect.poll(() => document.querySelector('[role="dialog"]')).toBeNull();
    expect(homeVisits).toBe(0);
    pressEscape(document.body);
    expect(homeVisits).toBe(1);
  });
});
