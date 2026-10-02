// FILE: EditProjectDialog.tsx
// Purpose: Edit a project's local name and its look (emoji, or icon and color) in one place.
// Layer: UI component
// Exports: EditProjectDialog, EditProjectValue

import type { ProjectId } from "@synara/contracts";
import { useEffect, useId, useRef, useState } from "react";

import type { ProjectAppearance } from "~/lib/projectAppearance";
import { PROJECT_DIALOG_FIELD_CONTROL_CLASS_NAME } from "./CreateGitHubProjectFields";
import { ProjectAppearancePicker } from "./ProjectAppearancePicker";
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

export interface EditProjectValue {
  /** Empty clears the local name, so the project shows its folder name again. */
  readonly name: string;
  readonly appearance: ProjectAppearance | null;
}

export interface EditProjectDialogProps {
  open: boolean;
  projectId?: ProjectId | null | undefined;
  /** Placeholder for the name field: what the project is called with no local name. */
  folderName: string;
  initialValue: EditProjectValue;
  onOpenChange: (open: boolean) => void;
  onSave: (value: EditProjectValue) => void;
}

export function EditProjectDialog({
  open,
  projectId,
  folderName,
  initialValue,
  onOpenChange,
  onSave,
}: EditProjectDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Edit project</DialogTitle>
        </DialogHeader>
        {/* Field state lives below DialogPopup, which unmounts its children after the close
            transition, so each open seeds a fresh draft from initialValue. */}
        <EditProjectForm
          projectId={projectId}
          folderName={folderName}
          initialValue={initialValue}
          onOpenChange={onOpenChange}
          onSave={onSave}
        />
      </DialogPopup>
    </Dialog>
  );
}

function EditProjectForm({
  projectId,
  folderName,
  initialValue,
  onOpenChange,
  onSave,
}: Omit<EditProjectDialogProps, "open">) {
  const [name, setName] = useState(initialValue.name);
  const [appearance, setAppearance] = useState(initialValue.appearance);
  const [pickerOpen, setPickerOpen] = useState(false);
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

  const save = () => {
    onSave({ name: name.trim(), appearance });
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
              save();
            }}
          >
            {/* Same field as Add project's folder path: the glyph sits in a leading cell,
                here as the button that opens the picker. */}
            <InputGroup className={PROJECT_DIALOG_FIELD_CONTROL_CLASS_NAME}>
              <InputGroupAddon className="w-10 self-stretch border-e border-foreground/12 ps-0 has-[>button]:ms-0">
                <PopoverTrigger
                  render={
                    <button
                      type="button"
                      aria-label="Choose icon"
                      className="flex size-full cursor-pointer items-center justify-center rounded-s-[inherit] text-muted-foreground outline-hidden transition-colors hover:bg-foreground/5 focus-visible:bg-foreground/6 data-popup-open:bg-foreground/6"
                    />
                  }
                >
                  <span className="relative flex size-4 items-center justify-center">
                    <ProjectSidebarIcon
                      projectId={projectId}
                      expanded={false}
                      appearance={appearance}
                    />
                  </span>
                </PopoverTrigger>
              </InputGroupAddon>
              <InputGroupInput
                id={nameInputId}
                aria-label="Project name"
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
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button size="sm" onClick={save}>
          Save
        </Button>
      </DialogFooter>
    </>
  );
}
