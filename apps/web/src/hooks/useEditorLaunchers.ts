import type { EditorId, ResolvedKeybindingsConfig } from "@synara/contracts";

import {
  type EditorOption,
  resolveAvailableEditorOptions,
  resolveEditorOption,
} from "../editorMetadata";
import { usePreferredEditor } from "../editorPreferences";
import { shortcutLabelForCommand } from "../keybindings";
import { readNativeApi } from "../nativeApi";

export interface EditorLaunchers {
  options: ReadonlyArray<EditorOption>;
  preferredEditor: EditorId | null;
  primaryOption: EditorOption | null;
  openFavoriteShortcutLabel: string | null;
  setDefaultEditor: (editorId: EditorId) => void;
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
  // a fixed editor pins the primary action for this surface only — the PDF viewer defaults "Open" to the OS viewer without touching the global preference
  defaultEditor?: EditorId | undefined;
}): EditorLaunchers {
  const [preferredEditor, setPreferredEditor] = usePreferredEditor(availableEditors);
  const isContextDefault = defaultEditor != null;
  // In context-default mode the primary action is pinned to `defaultEditor` and menu selections are one-shot opens that must not overwrite the persisted preference.
  const effectivePreferred = defaultEditor ?? preferredEditor;
  const installedOptions = resolveAvailableEditorOptions(navigator.platform, availableEditors);
  const options =
    defaultEditor && !installedOptions.some(({ value }) => value === defaultEditor)
      ? [resolveEditorOption(defaultEditor, navigator.platform), ...installedOptions]
      : installedOptions;
  const primaryOption = options.find(({ value }) => value === effectivePreferred) ?? null;
  const setDefaultEditor = (editorId: EditorId) => {
    if (isContextDefault) return;
    setPreferredEditor(editorId);
  };

  const openInEditor = (editorId: EditorId | null) => {
    const api = readNativeApi();
    if (!api || !openInTarget) return;
    const editor = editorId ?? effectivePreferred;
    if (!editor) return;
    void api.shell.openInEditor(openInTarget, editor);
    setDefaultEditor(editor);
  };

  const openFavoriteShortcutLabel = shortcutLabelForCommand(keybindings, "editor.openFavorite");

  return {
    options,
    preferredEditor: effectivePreferred,
    primaryOption,
    openFavoriteShortcutLabel,
    setDefaultEditor,
    openInEditor,
  };
}
