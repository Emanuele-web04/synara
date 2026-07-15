// FILE: EnvironmentEditorSection.tsx
// Purpose: "Editor" section of the Environment panel — the in-app Editor view as the
//          default first row, followed by the "Open in <editor>" external-launcher picker
//          (same skin as Commit and Push / env pickers). The menu lists every installed
//          editor (same entries as the header OpenInPicker).
// Layer: Environment panel section

import type { EditorId, ResolvedKeybindingsConfig } from "@synara/contracts";

import { useEditorLaunchers } from "~/hooks/useEditorLaunchers";
import { LayoutSidebarIcon } from "~/lib/icons";

import { ComposerPickerMenuPopup } from "../ComposerPickerMenuPopup";
import { Menu, MenuRadioGroup, MenuRadioItem, MenuShortcut, MenuTrigger } from "../../ui/menu";
import {
  ENVIRONMENT_ROW_CLASS_NAME,
  ENVIRONMENT_ROW_ICON_CLASS_NAME,
  EnvironmentRow,
  EnvironmentRowBody,
  EnvironmentLabeledSection,
  EnvironmentRowChevron,
} from "./EnvironmentRow";

export function EnvironmentEditorSection({
  keybindings,
  availableEditors,
  openInTarget,
  onOpenEditorView,
}: {
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  openInTarget: string | null;
  /** Open the in-app editor workspace view; omitted on surfaces that can't host it. */
  onOpenEditorView?: () => void;
}) {
  const {
    options,
    preferredEditor,
    primaryOption,
    openFavoriteShortcutLabel,
    setDefaultEditor,
    openInEditor,
  } = useEditorLaunchers({
    keybindings,
    availableEditors,
    openInTarget,
  });

  // Render the section whenever there is at least one entry to show — the in-app
  // editor view, an external editor, or both.
  if (options.length === 0 && !onOpenEditorView) {
    return null;
  }

  const activeOption = primaryOption ?? options[0] ?? null;
  const ActiveIcon = activeOption?.Icon;

  return (
    <EnvironmentLabeledSection label="Editor">
      {onOpenEditorView ? (
        <EnvironmentRow
          icon={<LayoutSidebarIcon aria-hidden className={ENVIRONMENT_ROW_ICON_CLASS_NAME} />}
          label="Editor view"
          onClick={onOpenEditorView}
        />
      ) : null}
      {options.length === 0 ? null : (
        <Menu>
          <MenuTrigger
            disabled={!openInTarget}
            render={<button type="button" className={ENVIRONMENT_ROW_CLASS_NAME} />}
          >
            <EnvironmentRowBody
              icon={
                ActiveIcon ? (
                  <ActiveIcon aria-hidden className={ENVIRONMENT_ROW_ICON_CLASS_NAME} />
                ) : null
              }
              label={activeOption ? `Open in ${activeOption.label}` : "Open in editor"}
              trailing={<EnvironmentRowChevron />}
            />
          </MenuTrigger>
          <ComposerPickerMenuPopup align="start" side="bottom" className="w-44 min-w-44">
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
                      <Icon aria-hidden className="size-3.5 text-muted-foreground" />
                    </span>
                    <span className="truncate">{label}</span>
                  </span>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </ComposerPickerMenuPopup>
        </Menu>
      )}
    </EnvironmentLabeledSection>
  );
}
