// FILE: useEditorLaunchers.ts
// Purpose: Editor-launch logic shared by the chat-header "Open in" split button and the
//          Environment panel "Editor" section — resolves installed editors, tracks the
//          preferred one, and opens the requested target path in an editor. The global open-favorite
//          shortcut lives in useOpenFavoriteEditorShortcut so it survives whether or not
//          these surfaces are mounted. Rendering is left entirely to the call sites.
// Layer: Chat editor action hook

import type { EditorId, ResolvedKeybindingsConfig } from "@synara/contracts";
import { useCallback, useMemo } from "react";

import {
  type EditorOption,
  resolveAvailableEditorOptions,
  resolveEditorOption,
} from "../editorMetadata";
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
  /** Persist the editor used by primary open actions and the global shortcut. */
  setDefaultEditor: (editorId: EditorId) => void;
  /** Open the requested target path in the given editor (or the preferred one when null). */
  openInEditor: (editorId: EditorId | null) => void;
}

export function useEditorLaunchers({
  keybindings,
  availableEditors,
  openInTarget,
  defaultEditor,
}: {
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  openInTarget: string | null;
  // When set, this editor becomes the fixed primary action for this surface and is
  // ensured to appear in the option list even if it is not an installed editor.
  // Used by the PDF viewer to default "Open" to the OS viewer (e.g. Preview) without
  // touching the global code-editor preference shared by every other surface.
  defaultEditor?: EditorId | undefined;
}): EditorLaunchers {
  const [preferredEditor, setPreferredEditor] = usePreferredEditor(availableEditors);
  const isContextDefault = defaultEditor != null;
  // In context-default mode the primary action is pinned to `defaultEditor` and menu
  // selections are one-shot opens that must not overwrite the persisted preference.
  const effectivePreferred = defaultEditor ?? preferredEditor;
  const options = useMemo(() => {
    const installed = resolveAvailableEditorOptions(navigator.platform, availableEditors);
    if (defaultEditor && !installed.some(({ value }) => value === defaultEditor)) {
      return [resolveEditorOption(defaultEditor, navigator.platform), ...installed];
    }
    return installed;
  }, [availableEditors, defaultEditor]);
  const primaryOption = options.find(({ value }) => value === effectivePreferred) ?? null;
  const setDefaultEditor = useCallback(
    (editorId: EditorId) => {
      if (isContextDefault) return;
      setPreferredEditor(editorId);
    },
    [isContextDefault, setPreferredEditor],
  );

  const openInEditor = useCallback(
    (editorId: EditorId | null) => {
      const api = readNativeApi();
      if (!api || !openInTarget) return;
      const editor = editorId ?? effectivePreferred;
      if (!editor) return;
      void api.shell.openInEditor(openInTarget, editor);
      setDefaultEditor(editor);
    },
    [effectivePreferred, openInTarget, setDefaultEditor],
  );

  const openFavoriteShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "editor.openFavorite"),
    [keybindings],
  );

  return {
    options,
    preferredEditor: effectivePreferred,
    primaryOption,
    openFavoriteShortcutLabel,
    setDefaultEditor,
    openInEditor,
  };
}
