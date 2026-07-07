// FILE: RenameDialog.tsx
// Purpose: Shared single-field rename dialog for threads and projects.
// Layer: Shared UI component
// Exports: RenameDialog

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";

export interface RenameDialogProps {
  open: boolean;
  title: string;
  description?: string | undefined;
  initialValue: string;
  /** Projects pass empty names to clear the local alias and fall back to folder name. */
  allowEmpty?: boolean | undefined;
  placeholder?: string | undefined;
  saveLabel?: string | undefined;
  onOpenChange: (open: boolean) => void;
  onSave: (next: string) => Promise<void> | void;
}

/**
 * Minimal centered rename dialog with a single text field and Cancel/Save
 * actions. Shared by chat-thread and project rename so both flows look and
 * behave identically instead of one being an inline input.
 */
export function RenameDialog({
  open,
  title,
  description,
  initialValue,
  allowEmpty = false,
  placeholder,
  saveLabel,
  onOpenChange,
  onSave,
}: RenameDialogProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState(initialValue);
  const [isSaving, setIsSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setIsSaving(false);
      return;
    }
    setValue(initialValue);
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [open, initialValue]);

  const trimmed = value.trim();
  const canSave = (allowEmpty || trimmed.length > 0) && !isSaving;

  const handleSubmit = async () => {
    if (!canSave) return;
    setIsSaving(true);
    try {
      await onSave(trimmed);
      onOpenChange(false);
    } catch {
      setIsSaving(false);
    }
  };

  const saveButtonLabel = saveLabel ?? t("common.save");
  const savingLabel = t("common.saving");
  const cancelLabel = t("common.cancel");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup surface="solid" className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <DialogPanel>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void handleSubmit();
            }}
          >
            <Input
              ref={inputRef}
              size="lg"
              value={value}
              placeholder={placeholder}
              disabled={isSaving}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  onOpenChange(false);
                }
              }}
            />
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={isSaving}
          >
            {cancelLabel}
          </Button>
          <Button size="sm" onClick={() => void handleSubmit()} disabled={!canSave}>
            {isSaving ? savingLabel : saveButtonLabel}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
