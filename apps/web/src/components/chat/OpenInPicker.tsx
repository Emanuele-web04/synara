// FILE: OpenInPicker.tsx
// Purpose: Render the chat header "Open In" controls for the currently active project.
// Layer: Chat header action
// Depends on: shared editor metadata, native shell bridge, and preferred editor state.

import { type EditorId, type ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { memo, useCallback, useEffect, useMemo } from "react";
import { isOpenFavoriteEditorShortcut, shortcutLabelForCommand } from "../../keybindings";
import { usePreferredEditor } from "../../editorPreferences";
import { resolveAvailableEditorOptions } from "../../editorMetadata";
import { ChevronDownIcon, PlusIcon } from "~/lib/icons";
import { Menu, MenuItem, MenuSeparator, MenuShortcut, MenuTrigger } from "../ui/menu";
import { ComposerPickerMenuPopup } from "./ComposerPickerMenuPopup";
import { readNativeApi } from "~/nativeApi";
import {
  ChatHeaderButton,
  ChatHeaderIconButton,
  ChatHeaderSplitDivider,
  ChatHeaderSplitGroup,
  CHAT_HEADER_SPLIT_LEADING_CLASS_NAME,
  CHAT_HEADER_SPLIT_TRAILING_CLASS_NAME,
} from "./chatHeaderControls";

export const OpenInPicker = memo(function OpenInPicker({
  keybindings,
  availableEditors,
  openInCwd,
  onAddAction,
}: {
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  openInCwd: string | null;
  // Optional project "Add action" entry rendered at the bottom of the editor menu.
  onAddAction?: () => void;
}) {
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

  const openFavoriteEditorShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "editor.openFavorite"),
    [keybindings],
  );

  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      const api = readNativeApi();
      if (!isOpenFavoriteEditorShortcut(e, keybindings)) return;
      if (!api || !openInCwd) return;
      if (!preferredEditor) return;

      e.preventDefault();
      void api.shell.openInEditor(openInCwd, preferredEditor);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [preferredEditor, keybindings, openInCwd]);

  return (
    <ChatHeaderSplitGroup label="Open in editor">
      <ChatHeaderButton
        tone="outline"
        className={CHAT_HEADER_SPLIT_LEADING_CLASS_NAME}
        disabled={!preferredEditor || !openInCwd}
        onClick={() => openInEditor(preferredEditor)}
      >
        {primaryOption?.Icon && <primaryOption.Icon aria-hidden="true" className="size-3.5" />}
        <span className="sr-only font-normal @sm/header-actions:not-sr-only @sm/header-actions:ml-0.5">
          Open
        </span>
      </ChatHeaderButton>
      <ChatHeaderSplitDivider />
      <Menu>
        <MenuTrigger
          render={
            <ChatHeaderIconButton
              label="Editor options"
              tone="outline"
              className={CHAT_HEADER_SPLIT_TRAILING_CLASS_NAME}
            />
          }
        >
          <ChevronDownIcon aria-hidden="true" className="size-3.5" />
        </MenuTrigger>
        <ComposerPickerMenuPopup align="end" side="bottom" className="w-44 min-w-44">
          {options.length === 0 && <MenuItem disabled>No installed editors found</MenuItem>}
          {options.map(({ label, Icon, value }) => (
            <MenuItem key={value} onClick={() => openInEditor(value)}>
              <span className="shrink-0">
                <Icon aria-hidden="true" className="size-3.5 text-muted-foreground" />
              </span>
              {label}
              {value === preferredEditor && openFavoriteEditorShortcutLabel && (
                <MenuShortcut>{openFavoriteEditorShortcutLabel}</MenuShortcut>
              )}
            </MenuItem>
          ))}
          {onAddAction ? (
            <>
              <MenuSeparator className="mx-1" />
              <MenuItem onClick={onAddAction}>
                <span className="shrink-0">
                  <PlusIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
                </span>
                Add action
              </MenuItem>
            </>
          ) : null}
        </ComposerPickerMenuPopup>
      </Menu>
    </ChatHeaderSplitGroup>
  );
});
