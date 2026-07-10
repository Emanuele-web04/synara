// FILE: useOpenFavoriteEditorShortcut.ts
// Purpose: Register the global "open favorite editor" keyboard shortcut on its own, decoupled
//          from any editor-launch UI. Previously this lived inside useEditorLaunchers, so the
//          shortcut only worked while the Open-in button (or the Environment panel's Editor
//          section) was mounted — and it silently stopped working once the Environment panel
//          replaced the always-mounted Open-in button. Mount this once from an always-present
//          host (the chat header) and gate it with `enabled`.
// Layer: Chat editor action hook

import type { EditorId, ResolvedKeybindingsConfig } from "@synara/contracts";
import { useEffect } from "react";

import { usePreferredEditor } from "../editorPreferences";
import { isOpenFavoriteEditorShortcut } from "../keybindings";
import { readNativeApi } from "../nativeApi";

export function useOpenFavoriteEditorShortcut({
  keybindings,
  availableEditors,
  openInTarget,
  enabled = true,
}: {
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  openInTarget: string | null;
  /** When false the listener is not registered (e.g. temporary threads with no project). */
  enabled?: boolean;
}): void {
  const [preferredEditor] = usePreferredEditor(availableEditors);

  useEffect(() => {
    if (!enabled) return;
    const handler = (e: globalThis.KeyboardEvent) => {
      if (!isOpenFavoriteEditorShortcut(e, keybindings)) return;
      const api = readNativeApi();
      if (!api || !openInTarget || !preferredEditor) return;
      e.preventDefault();
      void api.shell.openInEditor(openInTarget, preferredEditor);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [enabled, preferredEditor, keybindings, openInTarget]);
}
