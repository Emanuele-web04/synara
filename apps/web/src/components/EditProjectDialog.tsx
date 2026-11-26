// FILE: EditProjectDialog.tsx
// Purpose: Edit a project's local name, its look (emoji, or icon and color), and the extra
//          source folders of an ordinary project in one place.
// Layer: UI component
// Exports: EditProjectDialog, EditProjectValue

import { useEffect, useId, useRef, useState } from "react";

import { isElectron } from "~/env";
import { useAdditionalProjectFolders } from "~/hooks/useAdditionalProjectFolders";
import type { ProjectAppearance } from "~/lib/projectAppearance";
import { readNativeApi } from "~/nativeApi";
import { PROJECT_DIALOG_FIELD_CONTROL_CLASS_NAME } from "./CreateGitHubProjectFields";
import { ProjectAppearancePicker } from "./ProjectAppearancePicker";
import { ProjectFolderAddRow, ProjectFolderList } from "./ProjectFolderList";
import { ProjectSidebarIcon } from "./ProjectSidebarIcon";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./ui/input-group";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { useTranslation } from "~/i18n";

export interface EditProjectValue {
  /** Empty clears the local name, so the project shows its folder name again. */
  readonly name: string;
  readonly appearance: ProjectAppearance | null;
  /** Extra source folders after the primary one; present only when the dialog edits them. */
  readonly additionalFolders?: ReadonlyArray<string>;
}

export interface EditProjectDialogProps {
  open: boolean;
  cwd: string;
  /** Placeholder for the name field: what the project is called with no local name. */
  folderName: string;
  initialValue: EditProjectValue;
  /**
   * Shows the source folders (primary first, then `initialValue.additionalFolders`) so
   * folders can be added or removed. Only ordinary projects span several folders.
   */
  editFolders?: boolean;
  onOpenChange: (open: boolean) => void;
  /** A rejected save keeps the dialog open and shows the error. */
  onSave: (value: EditProjectValue) => void | Promise<void>;
}

export function EditProjectDialog({
  open,
  cwd,
  folderName,
  initialValue,
  editFolders = false,
  onOpenChange,
  onSave,
}: EditProjectDialogProps) {
  const { t } = useTranslation();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("workspace:editProject")}</DialogTitle>
        </DialogHeader>
        {/* Field state lives below DialogPopup, which unmounts its children after the close
            transition, so each open seeds a fresh draft from initialValue. */}
        <EditProjectForm
          cwd={cwd}
          folderName={folderName}
          initialValue={initialValue}
          editFolders={editFolders}
          onOpenChange={onOpenChange}
          onSave={onSave}
        />
      </DialogPopup>
    </Dialog>
  );
}

function EditProjectForm({
  cwd,
  folderName,
  initialValue,
  editFolders,
  onOpenChange,
  onSave,
}: Omit<EditProjectDialogProps, "open">) {
  const { t } = useTranslation();

  const [name, setName] = useState(initialValue.name);
  const [appearance, setAppearance] = useState(initialValue.appearance);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [isPickingFolder, setIsPickingFolder] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // The primary folder stays fixed here (Change project path moves it); extra ones come and go.
  const { additionalFolders, addFolder, removeFolder } = useAdditionalProjectFolders({
    primary: cwd,
    initial: initialValue.additionalFolders ?? [],
    onProblem: setFormError,
  });
  const nameInputId = useId();
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Deferred a frame: the dialog moves focus itself on open. Matches RenameDialog.
    const frame = window.requestAnimationFrame(() => {
      const nameInput = document.getElementById(nameInputId);
      if (nameInput instanceof HTMLInputElement) {
        nameInput.focus();
        nameInput.select();
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [nameInputId]);

  const browseFolder = async () => {
    const api = readNativeApi();
    if (!api || isPickingFolder || saving) return;
    setIsPickingFolder(true);
    // No try/finally: the React Compiler skips optimizing components that use it.
    try {
      const picked = await api.dialogs.pickFolder();
      if (picked) addFolder(picked);
    } catch (error) {
      setFormError(
        error instanceof Error
          ? error.message
          : t("workspace:projectPicker_unableToOpenFolderPicker"),
      );
    }
    setIsPickingFolder(false);
  };

  const save = async () => {
    if (saving) return;
    // Built outside the try: a conditional spread inside it makes the React Compiler bail out.
    const value: EditProjectValue = {
      name: name.trim(),
      appearance,
      ...(editFolders ? { additionalFolders } : {}),
    };
    setSaving(true);
    setFormError(null);
    try {
      await onSave(value);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : t("workspace:anUnknownErrorOccurred"));
      setSaving(false);
      return;
    }
    setSaving(false);
    onOpenChange(false);
  };

  return (
    <>
      <DialogPanel>
        {/* The popup is a sibling of the form, not a child of the field: React bubbles
            portal events through the component tree, so inside InputGroupAddon every click
            on the picker's empty space reached the addon's handler and pulled focus into
            the name input. */}
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            {/* Same field as Add project's folder path: the glyph sits in a leading cell,
                here as the button that opens the picker. */}
            <InputGroup className={PROJECT_DIALOG_FIELD_CONTROL_CLASS_NAME}>
              {/* Rounded and clipped like the field: the button's hover / open fill would otherwise
                square off past the field's corners. */}
              <InputGroupAddon className="w-10 self-stretch overflow-hidden rounded-s-[inherit] border-e border-foreground/12 ps-0 has-[>button]:ms-0">
                <PopoverTrigger
                  render={
                    <button
                      type="button"
                      aria-label={t("workspace:scripts_chooseIcon")}
                      className="flex size-full cursor-pointer items-center justify-center rounded-s-[inherit] text-muted-foreground outline-hidden transition-colors hover:bg-foreground/5 focus-visible:bg-foreground/6 data-popup-open:bg-foreground/6"
                    />
                  }
                >
                  <span className="relative flex size-4 items-center justify-center">
                    <ProjectSidebarIcon cwd={cwd} expanded={false} appearance={appearance} />
                  </span>
                </PopoverTrigger>
              </InputGroupAddon>
              <InputGroupInput
                id={nameInputId}
                aria-label={t("workspace:projectName")}
                value={name}
                placeholder={folderName}
                onChange={(event) => setName(event.target.value)}
              />
            </InputGroup>
          </form>
          <PopoverPopup
            align="start"
            side="bottom"
            sideOffset={8}
            initialFocus={searchInputRef}
            // Opaque like the dialog it opens over: the frosted default lets the
            // dialog's own buttons show through the grid.
            className="w-[22.5rem] bg-popover"
          >
            <ProjectAppearancePicker
              value={appearance}
              searchInputRef={searchInputRef}
              onChange={setAppearance}
              onEmojiPicked={() => setPickerOpen(false)}
            />
          </PopoverPopup>
        </Popover>
        {editFolders ? (
          <ProjectFolderList
            className="mt-4"
            folders={[cwd, ...additionalFolders]}
            disabled={saving || isPickingFolder}
            primaryLocked
            onRemove={removeFolder}
            addRow={
              <ProjectFolderAddRow
                picker={isElectron}
                disabled={saving || isPickingFolder}
                picking={isPickingFolder}
                onBrowse={() => void browseFolder()}
                onAdd={addFolder}
                onInputChange={() => setFormError(null)}
              />
            }
          />
        ) : null}
        {formError ? (
          <p role="alert" className="mt-3 text-ui-xs text-destructive">
            {formError}
          </p>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" size="sm" disabled={saving} onClick={() => onOpenChange(false)}>
          {t("common:form_cancel")}
        </Button>
        <Button size="sm" disabled={saving} onClick={() => void save()}>
          {t("computer:form_save")}
        </Button>
      </DialogFooter>
    </>
  );
}
