// previously inside useEditorLaunchers, so the shortcut silently stopped when no editor-launch surface was mounted — mount once from an always-present host

import type { EditorId, ResolvedKeybindingsConfig } from "@synara/contracts";
import { useEffect } from "react";

import { usePreferredEditor } from "../editorPreferences";
import { isOpenFavoriteEditorShortcut } from "../keybindings";
import { readNativeApi } from "../nativeApi";

export function useOpenFavoriteEditorShortcut({
  keybindings,
  availableEditors,
  openInTarget,
  enabled: enabledProp,
}: {
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  openInTarget: string | null;
  enabled?: boolean;
}): void {
  const enabled = enabledProp ?? true;
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
