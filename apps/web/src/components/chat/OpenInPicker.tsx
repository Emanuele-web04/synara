// FILE: OpenInPicker.tsx
// Purpose: Render the chat/file header "Open In" controls for the active editor target.
// Layer: Chat header action
// Depends on: shared editor metadata, native shell bridge, and preferred editor state.

import { type EditorId, type ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { memo } from "react";
import { useEditorLaunchers } from "~/hooks/useEditorLaunchers";
import { ChevronDownIcon, PlusIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import {
  Menu,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuShortcut,
  MenuTrigger,
} from "../ui/menu";
import { ComposerPickerMenuPopup } from "./ComposerPickerMenuPopup";
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
  openInTarget,
  onAddAction,
  labelMode = "responsive",
}: {
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  openInTarget: string | null;
  // Optional project "Add action" entry rendered at the bottom of the editor menu.
  onAddAction?: () => void;
  // "responsive" (default) hides the "Open" label until the `header-actions`
  // container is wide enough; "always" keeps it visible regardless. Surfaces
  // without that container (e.g. the file-preview header) pass "always" so the
  // label shows without needing an inline-size container that would collapse
  // the control's own width.
  labelMode?: "responsive" | "always";
}) {
  const {
    options,
    preferredEditor,
    primaryOption,
    openFavoriteShortcutLabel,
    setDefaultEditor,
    openInEditor,
  } = useEditorLaunchers({ keybindings, availableEditors, openInTarget });

  return (
    <ChatHeaderSplitGroup label="Open in editor">
      <ChatHeaderButton
        tone="outline"
        className={CHAT_HEADER_SPLIT_LEADING_CLASS_NAME}
        disabled={!preferredEditor || !openInTarget}
        onClick={() => openInEditor(preferredEditor)}
      >
        {primaryOption?.Icon && <primaryOption.Icon aria-hidden="true" className="size-3.5" />}
        <span
          className={cn(
            "font-normal",
            labelMode === "always"
              ? "ml-0.5"
              : "sr-only @sm/header-actions:not-sr-only @sm/header-actions:ml-0.5",
          )}
        >
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
          <MenuRadioGroup
            value={preferredEditor ?? ""}
            onValueChange={(value) => setDefaultEditor(value as EditorId)}
          >
            {options.map(({ label, Icon, value }) => (
              <MenuRadioItem
                key={value}
                preserveChildLayout
                trailing={
                  value === preferredEditor && openFavoriteShortcutLabel ? (
                    <MenuShortcut>{openFavoriteShortcutLabel}</MenuShortcut>
                  ) : null
                }
                value={value}
                onClick={() => openInEditor(value)}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="shrink-0">
                    <Icon aria-hidden="true" className="size-3.5 text-muted-foreground" />
                  </span>
                  <span className="truncate">{label}</span>
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
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
