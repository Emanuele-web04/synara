// FILE: ComposerExtrasMenu.tsx
// Purpose: Hosts the composer `+` menu for attachments and quick composer mode toggles.
// Layer: Chat composer presentation
// Depends on: shared menu primitives, icon buttons, and caller-owned composer state callbacks.

import { type ProviderInteractionMode } from "@synara/contracts";
import { useId, useRef, type ChangeEvent } from "react";
import { GoTasklist } from "react-icons/go";

import { splitComposerDropzoneFiles } from "~/hooks/useComposerDropzone";
import { PaperclipIcon, PlusIcon } from "~/lib/icons";
import { ComposerPickerMenuPopup, ComposerPickerMenuSubPopup } from "./ComposerPickerMenuPopup";
import { Button } from "../ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";

export const ComposerExtrasMenu = function ComposerExtrasMenu(props: {
  interactionMode: ProviderInteractionMode;
  supportsFastMode: boolean;
  fastModeEnabled: boolean;
  onAddPhotos: (files: File[]) => void;
  onAddFiles: (files: File[]) => void;
  onToggleFastMode: () => void;
  onSetPlanMode: (enabled: boolean) => void;
}) {
  const inputId = useId();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Reset the hidden input so selecting the same file twice still emits a change event.
  const handleFileInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const { imageFiles, genericFiles } = splitComposerDropzoneFiles(event.target.files ?? []);
    if (imageFiles.length > 0) {
      props.onAddPhotos(imageFiles);
    }
    if (genericFiles.length > 0) {
      props.onAddFiles(genericFiles);
    }
    event.target.value = "";
  };

  return (
    <>
      <input
        id={inputId}
        ref={fileInputRef}
        data-testid="composer-photo-input"
        aria-label="Add attachment"
        type="file"
        multiple
        className="sr-only"
        onChange={handleFileInputChange}
      />
      <Menu>
        <MenuTrigger
          render={
            <Button
              size="icon-sm"
              variant="chrome"
              className="shrink-0 rounded-md"
              aria-label="Composer extras"
            />
          }
        >
          <PlusIcon aria-hidden="true" className="size-4" />
        </MenuTrigger>
        <ComposerPickerMenuPopup align="start">
          <MenuItem
            onClick={() => {
              fileInputRef.current?.click();
            }}
          >
            <PaperclipIcon className="size-4 shrink-0" />
            Add attachment
          </MenuItem>

          <MenuSeparator />
          <MenuCheckboxItem
            checked={props.interactionMode === "plan"}
            variant="switch"
            onCheckedChange={(checked) => {
              props.onSetPlanMode(checked === true);
            }}
          >
            <span className="inline-flex items-center gap-2">
              <GoTasklist className="size-4 shrink-0" />
              Plan mode
            </span>
          </MenuCheckboxItem>

          {props.supportsFastMode ? (
            <>
              <MenuSeparator />
              <MenuSub>
                <MenuSubTrigger>Fast</MenuSubTrigger>
                <ComposerPickerMenuSubPopup>
                  <MenuRadioGroup
                    value={props.fastModeEnabled ? "fast" : "normal"}
                    onValueChange={(value) => {
                      const shouldEnableFast = value === "fast";
                      if (shouldEnableFast === props.fastModeEnabled) return;
                      props.onToggleFastMode();
                    }}
                  >
                    <MenuRadioItem value="normal">Default</MenuRadioItem>
                    <MenuRadioItem value="fast">Fast</MenuRadioItem>
                  </MenuRadioGroup>
                </ComposerPickerMenuSubPopup>
              </MenuSub>
            </>
          ) : null}
        </ComposerPickerMenuPopup>
      </Menu>
    </>
  );
};
