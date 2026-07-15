// FILE: OpenInPicker.tsx
// Purpose: Render the chat/file header "Open In" controls for the active editor target.
// Layer: Chat header action
// Depends on: shared editor metadata, native shell bridge, and preferred editor state.

import { type EditorId, type ResolvedKeybindingsConfig } from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import { memo } from "react";
import { useEditorLaunchers } from "~/hooks/useEditorLaunchers";
import { ChevronDownIcon } from "~/lib/icons";
import { serverConfigQueryOptions } from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";
import {
  Menu,
  MenuRadioGroup,
  MenuRadioItem,
  MenuShortcut,
  MenuTrigger,
  MenuItem,
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

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];
const EMPTY_AVAILABLE_EDITORS: ReadonlyArray<EditorId> = [];

export const OpenInPicker = memo(function OpenInPicker({
  keybindings: keybindingsProp,
  availableEditors: availableEditorsProp,
  openInTarget,
  labelMode = "responsive",
  defaultEditor,
}: {
  // Editor config is optional: callers that already hold it (e.g. the chat
  // header) pass it through, while standalone surfaces (file-preview headers)
  // omit it and let the picker self-fetch. react-query dedupes by key with an
  // infinite stale time, so multiple self-fetching pickers share one request.
  keybindings?: ResolvedKeybindingsConfig;
  availableEditors?: ReadonlyArray<EditorId>;
  openInTarget: string | null;
  // "responsive" (default) hides the "Open" label until the `header-actions`
  // inline-size container (declared on an ancestor — the chat header and the
  // file-preview header both do) is wide enough; "always" keeps it visible
  // regardless, for surfaces that don't establish that container.
  labelMode?: "responsive" | "always";
  // Pins the primary "Open" action to a specific editor for this surface without
  // mutating the shared preferred-editor setting. The PDF viewer uses this to default
  // to the OS viewer (e.g. Preview) while still listing installed editors.
  defaultEditor?: EditorId;
}) {
  // Only subscribe to the config query when the caller did not supply config.
  const needsConfig = keybindingsProp === undefined || availableEditorsProp === undefined;
  const serverConfigQuery = useQuery({ ...serverConfigQueryOptions(), enabled: needsConfig });
  const keybindings = keybindingsProp ?? serverConfigQuery.data?.keybindings ?? EMPTY_KEYBINDINGS;
  const availableEditors =
    availableEditorsProp ?? serverConfigQuery.data?.availableEditors ?? EMPTY_AVAILABLE_EDITORS;

  const {
    options,
    preferredEditor,
    primaryOption,
    openFavoriteShortcutLabel,
    setDefaultEditor,
    openInEditor,
  } = useEditorLaunchers({ keybindings, availableEditors, openInTarget, defaultEditor });

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
        </ComposerPickerMenuPopup>
      </Menu>
    </ChatHeaderSplitGroup>
  );
});
