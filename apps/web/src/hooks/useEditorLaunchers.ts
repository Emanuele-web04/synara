// FILE: useEditorLaunchers.ts
// Purpose: Editor-launch logic shared by the chat-header "Open in" split button and the
//          Environment panel "Editor" section — resolves installed editors, tracks the
//          preferred one, and opens the project in an editor. The global open-favorite
//          shortcut lives in useOpenFavoriteEditorShortcut so it survives whether or not
//          these surfaces are mounted. Rendering is left entirely to the call sites.
// Layer: Chat editor action hook

import type { EditorId, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { type EditorOption, resolveAvailableEditorOptions } from "../editorMetadata";
import { usePreferredEditor } from "../editorPreferences";
import { shortcutLabelForCommand } from "../keybindings";
import { readNativeApi } from "../nativeApi";

export interface EditorLaunchers {
  /** Installed editors for the current platform, in catalog order. */
  options: ReadonlyArray<EditorOption>;
  /** Currently preferred editor (last used / first installed), or null when none. */
  preferredEditor: EditorId | null;
  /** The option matching {@link preferredEditor}, or null. */
  primaryOption: EditorOption | null;
  /** Shortcut label for "open favorite editor", or null when unbound. */
  openFavoriteShortcutLabel: string | null;
  /** Open the project cwd in the given editor (or the preferred one when null). */
  openInEditor: (editorId: EditorId | null) => void;
}

export function useEditorLaunchers({
  keybindings,
  availableEditors,
  openInCwd,
}: {
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  openInCwd: string | null;
}): EditorLaunchers {
  const [preferredEditor, setPreferredEditor] = usePreferredEditor(availableEditors);
  const options = useMemo(
    () => resolveAvailableEditorOptions(navigator.platform, availableEditors),
    [availableEditors],
  );
  const primaryOption = options.find(({ value }) => value === preferredEditor) ?? null;

  const openInEditor = useCallback(
    (editorId: EditorId | null) => {
      const api = readNativeApi();
      if (!api || !openInCwd) return;
      const editor = editorId ?? preferredEditor;
      if (!editor) return;
      void api.shell.openInEditor(openInCwd, editor);
      setPreferredEditor(editor);
    },
    [preferredEditor, openInCwd, setPreferredEditor],
  );

  const openFavoriteShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "editor.openFavorite"),
    [keybindings],
  );

  return { options, preferredEditor, primaryOption, openFavoriteShortcutLabel, openInEditor };
}
