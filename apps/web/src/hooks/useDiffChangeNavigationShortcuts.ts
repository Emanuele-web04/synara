import type { ResolvedKeybindingsConfig } from "@synara/contracts";
import { useEffect } from "react";

import { isEditableEventTarget } from "../lib/editableEventTarget";
import { isTerminalFocused } from "../lib/terminalFocus";
import { resolveShortcutCommand } from "../keybindings";
import type { DiffChangeNavigationDirection } from "../components/DiffPanel.logic";

export function useDiffChangeNavigationShortcuts({
  keybindings,
  enabled,
  onNavigate,
}: {
  keybindings: ResolvedKeybindingsConfig;
  enabled: boolean;
  onNavigate: (direction: DiffChangeNavigationDirection) => void;
}): void {
  useEffect(() => {
    if (!enabled) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (isEditableEventTarget(event)) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: { terminalFocus: isTerminalFocused() },
      });
      if (command !== "diff.change.next" && command !== "diff.change.previous") return;
      event.preventDefault();
      event.stopPropagation();
      onNavigate(command === "diff.change.next" ? "next" : "previous");
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [enabled, keybindings, onNavigate]);
}
