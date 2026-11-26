// FILE: useEditorLaunchers.ts
// Purpose: Editor-launch logic shared by the chat-header "Open in" split button and the
//          Environment panel "Editor" section — resolves installed editors, tracks the
//          preferred one, and opens the requested target path in an editor. The global open-favorite
//          shortcut lives in useOpenFavoriteEditorShortcut so it survives whether or not
//          these surfaces are mounted. Rendering is left entirely to the call sites.
// Layer: Chat editor action hook

import type { EditorId, ResolvedKeybindingsConfig } from "@synara/contracts";
import { REMOTE_NATIVE_UNAVAILABLE } from "@synara/shared/remoteCapabilities";

import { toastManager } from "../components/ui/toast";
import {
  type EditorOption,
  resolveAvailableEditorOptions,
  resolveEditorOption,
} from "../editorMetadata";
import { usePreferredEditor } from "../editorPreferences";
import { shortcutLabelForCommand } from "../keybindings";
import { readExecutionContext } from "../lib/hosts/executionContext";
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
  const installedOptions = resolveAvailableEditorOptions(navigator.platform, availableEditors);
  const remote = Boolean(readExecutionContext()?.remote);
  const options = remote
    ? []
    : defaultEditor && !installedOptions.some(({ value }) => value === defaultEditor)
      ? [resolveEditorOption(defaultEditor, navigator.platform), ...installedOptions]
      : installedOptions;
  const primaryOption = options.find(({ value }) => value === effectivePreferred) ?? null;
  const setDefaultEditor = (editorId: EditorId) => {
    if (isContextDefault) return;
    setPreferredEditor(editorId);
  };

  const openInEditor = (editorId: EditorId | null) => {
    if (remote) {
      toastManager.add({
        type: "error",
        title: "Could not open editor",
        description: REMOTE_NATIVE_UNAVAILABLE,
      });
      return;
    }
    const api = readNativeApi();
    if (!api || !openInTarget) return;
    const editor = editorId ?? effectivePreferred;
    if (!editor) return;
    void api.shell
      .openInEditor(openInTarget, editor)
      .then(() => setDefaultEditor(editor))
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Could not open editor",
          description: error instanceof Error ? error.message : "Unable to open this editor.",
        });
      });
  };

  const openFavoriteShortcutLabel = shortcutLabelForCommand(keybindings, "editor.openFavorite");

  return {
    options,
    preferredEditor: effectivePreferred,
    primaryOption,
    openFavoriteShortcutLabel,
    openInEditor,
  };
}
