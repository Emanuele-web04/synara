import { useTranslation } from "~/i18n";
// FILE: ProjectActionDialog.tsx
// Purpose: Add/edit dialog for one project action (script) plus its delete confirmation.
//          Shared by the chat-header project action control and the Environment panel's
//          Actions section, so both surfaces create and edit actions the same way.
// Layer: Project action UI primitive

import {
  type ProjectScript,
  type ProjectScriptIcon,
  type ResolvedKeybindingsConfig,
} from "@synara/contracts";
import React, { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";

import {
  BugIcon,
  FlaskConicalIcon,
  HammerIcon,
  ListChecksIcon,
  PlayIcon,
  SettingsIcon,
} from "~/lib/icons";
import { keybindingFromKeyboardEvent } from "~/lib/keybindingCapture";
import {
  decodeProjectScriptKeybindingRule,
  keybindingValueForCommand,
} from "~/lib/projectScriptKeybindings";
import { commandForProjectScript, nextProjectScriptId } from "~/projectScripts";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";

export const SCRIPT_ICONS: Array<{ id: ProjectScriptIcon; label: string; labelKey: string }> = [
  { id: "play", label: "Play", labelKey: "workspace:play" },
  { id: "test", label: "Test", labelKey: "workspace:test" },
  { id: "lint", label: "Lint", labelKey: "workspace:lint" },
  { id: "configure", label: "Configure", labelKey: "workspace:searchPalette_sectionConfigure" },
  { id: "build", label: "Build", labelKey: "workspace:composerControls_build" },
  { id: "debug", label: "Debug", labelKey: "chat:debug" },
];

export function ScriptIcon({
  icon,
  className: classNameProp,
}: {
  icon: ProjectScriptIcon;
  className?: string;
}) {
  const className = classNameProp ?? "size-3.5";
  if (icon === "test") return <FlaskConicalIcon className={className} />;
  if (icon === "lint") return <ListChecksIcon className={className} />;
  if (icon === "configure") return <SettingsIcon className={className} />;
  if (icon === "build") return <HammerIcon className={className} />;
  if (icon === "debug") return <BugIcon className={className} />;
  return <PlayIcon className={className} />;
}

export interface NewProjectScriptInput {
  name: string;
  command: string;
  icon: ProjectScriptIcon;
  runOnWorktreeCreate: boolean;
  keybinding: string | null;
}

interface ProjectActionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Existing actions, used to mint a stable id and to validate the keybinding rule. */
  scripts: readonly ProjectScript[];
  keybindings: ResolvedKeybindingsConfig;
  /** `null` opens the dialog in add mode; a script opens it in edit mode. */
  editingScript: ProjectScript | null;
  onSave: (input: NewProjectScriptInput) => Promise<void> | void;
  onDelete: (scriptId: string) => Promise<void> | void;
}

export function ProjectActionDialog({
  open,
  onOpenChange,
  scripts,
  keybindings,
  editingScript,
  onSave,
  onDelete,
}: ProjectActionDialogProps) {
  const { t } = useTranslation();

  const isEditing = editingScript !== null;
  const formId = React.useId();
  // Both the header control and the Environment panel mount this dialog, so the field ids
  // must be instance-unique to avoid duplicate DOM ids while both are mounted.
  const fieldIdPrefix = React.useId();
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [icon, setIcon] = useState<ProjectScriptIcon>("play");
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [runOnWorktreeCreate, setRunOnWorktreeCreate] = useState(false);
  const [keybinding, setKeybinding] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  // Seed the form once per open/editing target. Re-running on every prop change would
  // rewrite fields the user is typing into.
  const seededFor = useRef<string | null>(null);

  useEffect(() => {
    if (!open) {
      seededFor.current = null;
      return;
    }
    const seedKey = editingScript?.id ?? "__new__";
    if (seededFor.current === seedKey) return;
    seededFor.current = seedKey;
    setIconPickerOpen(false);
    setDeleteConfirmOpen(false);
    setValidationError(null);
    if (editingScript) {
      setName(editingScript.name);
      setCommand(editingScript.command);
      setIcon(editingScript.icon);
      setRunOnWorktreeCreate(editingScript.runOnWorktreeCreate);
      setKeybinding(
        keybindingValueForCommand(keybindings, commandForProjectScript(editingScript.id)) ?? "",
      );
      return;
    }
    setName("");
    setCommand("");
    setIcon("play");
    setRunOnWorktreeCreate(false);
    setKeybinding("");
  }, [open, editingScript, keybindings]);

  const captureKeybinding = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Tab") return;
    event.preventDefault();
    if (event.key === "Backspace" || event.key === "Delete") {
      setKeybinding("");
      return;
    }
    const next = keybindingFromKeyboardEvent(event);
    if (!next) return;
    setKeybinding(next);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedName = name.trim();
    const trimmedCommand = command.trim();
    if (trimmedName.length === 0) {
      setValidationError(t("workspace:nameIsRequired"));
      return;
    }
    if (trimmedCommand.length === 0) {
      setValidationError(t("workspace:commandIsRequired"));
      return;
    }

    setValidationError(null);
    try {
      const scriptIdForValidation =
        editingScript?.id ??
        nextProjectScriptId(
          trimmedName,
          scripts.map((script) => script.id),
        );
      const keybindingRule = decodeProjectScriptKeybindingRule({
        keybinding,
        command: commandForProjectScript(scriptIdForValidation),
      });
      await onSave({
        name: trimmedName,
        command: trimmedCommand,
        icon,
        runOnWorktreeCreate,
        keybinding: keybindingRule?.key ?? null,
      });
      onOpenChange(false);
    } catch (error) {
      setValidationError(
        error instanceof Error ? error.message : t("workspace:failedToSaveAction"),
      );
    }
  };

  const confirmDelete = () => {
    if (!editingScript) return;
    setDeleteConfirmOpen(false);
    onOpenChange(false);
    void onDelete(editingScript.id);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              {isEditing ? t("workspace:editAction") : t("workspace:addAction")}
            </DialogTitle>
            <DialogDescription>
              {t("common:actionsAreProjectScopedCommandsYouCanRunFrom")}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <form id={formId} className="space-y-4" onSubmit={submit}>
              <div className="space-y-1.5">
                <Label htmlFor={`${fieldIdPrefix}-script-name`}>{t("common:scripts_name")}</Label>
                <div className="flex items-center gap-2">
                  <Popover onOpenChange={setIconPickerOpen} open={iconPickerOpen}>
                    <PopoverTrigger
                      render={
                        <Button
                          type="button"
                          variant="outline"
                          className="size-9 shrink-0 hover:bg-popover active:bg-popover data-pressed:bg-popover"
                          aria-label={t("workspace:scripts_chooseIcon")}
                        />
                      }
                    >
                      <ScriptIcon icon={icon} className="size-4.5" />
                    </PopoverTrigger>
                    <PopoverPopup align="start">
                      <div className="grid grid-cols-3 gap-2">
                        {SCRIPT_ICONS.map((entry) => {
                          const isSelected = entry.id === icon;
                          return (
                            <button
                              key={entry.id}
                              type="button"
                              className={`relative flex flex-col items-center gap-2 rounded-md border px-2 py-2 text-ui leading-snug ${
                                isSelected
                                  ? "border-[color:var(--color-border)] bg-[var(--sidebar-accent)]"
                                  : "border-[color:var(--color-border-light)] hover:bg-[var(--sidebar-accent)]"
                              }`}
                              onClick={() => {
                                setIcon(entry.id);
                                setIconPickerOpen(false);
                              }}
                            >
                              <ScriptIcon icon={entry.id} className="size-4" />
                              <span>{t(entry.labelKey)}</span>
                            </button>
                          );
                        })}
                      </div>
                    </PopoverPopup>
                  </Popover>
                  <Input
                    id={`${fieldIdPrefix}-script-name`}
                    autoFocus
                    placeholder={t("workspace:test")}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${fieldIdPrefix}-script-keybinding`}>
                  {t("common:scripts_keybinding")}
                </Label>
                <Input
                  id={`${fieldIdPrefix}-script-keybinding`}
                  placeholder={t("workspace:pressShortcut")}
                  value={keybinding}
                  readOnly
                  onKeyDown={captureKeybinding}
                />
                <p className="text-ui leading-snug text-muted-foreground">
                  {t("common:pressAShortcutUse")} <code>Backspace</code> {t("common:toClear")}
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${fieldIdPrefix}-script-command`}>
                  {t("workspace:scripts_command")}
                </Label>
                <Textarea
                  id={`${fieldIdPrefix}-script-command`}
                  placeholder="bun test"
                  value={command}
                  onChange={(event) => setCommand(event.target.value)}
                />
              </div>
              <label className="flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2 text-ui leading-snug">
                <span>{t("common:runAutomaticallyOnWorktreeCreation")}</span>
                <Switch
                  checked={runOnWorktreeCreate}
                  onCheckedChange={(checked) => setRunOnWorktreeCreate(Boolean(checked))}
                />
              </label>
              {validationError && (
                <p className="text-ui leading-snug text-destructive">{validationError}</p>
              )}
            </form>
          </DialogPanel>
          <DialogFooter>
            {isEditing && (
              <Button
                type="button"
                variant="destructive-outline"
                className="mr-auto"
                onClick={() => setDeleteConfirmOpen(true)}
              >
                {t("computer:detail_delete")}
              </Button>
            )}
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              {t("common:form_cancel")}
            </Button>
            <Button form={formId} type="submit" size="sm">
              {isEditing ? t("workspace:scripts_saveChanges") : t("workspace:scripts_saveAction")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("workspace:deleteProjectActionNamed", { name })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("chat:checkpoint_revertConfirmWarning")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="sm" />}>
              {t("common:form_cancel")}
            </AlertDialogClose>
            <Button variant="destructive" size="sm" onClick={confirmDelete}>
              {t("common:scripts_deleteActionTitle")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
