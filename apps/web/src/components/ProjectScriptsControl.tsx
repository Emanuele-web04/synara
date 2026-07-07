import type {
  ProjectScript,
  ProjectScriptIcon,
  ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import {
  BugIcon,
  ChevronDownIcon,
  FlaskConicalIcon,
  HammerIcon,
  ListChecksIcon,
  PlayIcon,
  PlusIcon,
  SettingsIcon,
} from "~/lib/icons";
import React, { type FormEvent, type KeyboardEvent, useCallback, useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";

import {
  keybindingValueForCommand,
  decodeProjectScriptKeybindingRule,
} from "~/lib/projectScriptKeybindings";
import {
  commandForProjectScript,
  nextProjectScriptId,
  primaryProjectScript,
} from "~/projectScripts";
import { shortcutLabelForCommand } from "~/keybindings";
import { cn, isMacPlatform } from "~/lib/utils";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import {
  CHAT_HEADER_SPLIT_LEADING_CLASS_NAME,
  CHAT_HEADER_SPLIT_TRAILING_CLASS_NAME,
  ChatHeaderButton,
  ChatHeaderIconButton,
  ChatHeaderSplitDivider,
  ChatHeaderSplitGroup,
} from "./chat/chatHeaderControls";
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
import { Label } from "./ui/label";
import { Menu, MenuItem, MenuPopup, MenuShortcut, MenuTrigger } from "./ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { Switch } from "./ui/switch";
import { Textarea } from "./ui/textarea";

const SCRIPT_ICONS: { id: ProjectScriptIcon; label: string }[] = [
  { id: "play", label: "Play" },
  { id: "test", label: "Test" },
  { id: "lint", label: "Lint" },
  { id: "configure", label: "Configure" },
  { id: "build", label: "Build" },
  { id: "debug", label: "Debug" },
];

function ScriptIcon({
  icon,
  className = "size-3.5",
}: {
  icon: ProjectScriptIcon;
  className?: string;
}) {
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

interface ProjectScriptsControlProps {
  scripts: ProjectScript[];
  keybindings: ResolvedKeybindingsConfig;
  preferredScriptId?: string | null;
  showInlineControls?: boolean;
  hideInlineLabel?: boolean;
  onRunScript: (script: ProjectScript) => void;
  onAddScript: (input: NewProjectScriptInput) => Promise<void> | void;
  onUpdateScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void> | void;
  onDeleteScript: (scriptId: string) => Promise<void> | void;
}

function normalizeShortcutKeyToken(key: string): string | null {
  const normalized = key.toLowerCase();
  if (
    normalized === "meta" ||
    normalized === "control" ||
    normalized === "ctrl" ||
    normalized === "shift" ||
    normalized === "alt" ||
    normalized === "option"
  ) {
    return null;
  }
  if (normalized === " ") return "space";
  if (normalized === "escape") return "esc";
  if (normalized === "arrowup") return "arrowup";
  if (normalized === "arrowdown") return "arrowdown";
  if (normalized === "arrowleft") return "arrowleft";
  if (normalized === "arrowright") return "arrowright";
  if (normalized.length === 1) return normalized;
  if (normalized.startsWith("f") && normalized.length <= 3) return normalized;
  if (normalized === "enter" || normalized === "tab" || normalized === "backspace") {
    return normalized;
  }
  if (normalized === "delete" || normalized === "home" || normalized === "end") {
    return normalized;
  }
  if (normalized === "pageup" || normalized === "pagedown") return normalized;
  return null;
}

function keybindingFromEvent(event: KeyboardEvent<HTMLInputElement>): string | null {
  const keyToken = normalizeShortcutKeyToken(event.key);
  if (!keyToken) return null;

  const parts: string[] = [];
  if (isMacPlatform(navigator.platform)) {
    if (event.metaKey) parts.push("mod");
    if (event.ctrlKey) parts.push("ctrl");
  } else {
    if (event.ctrlKey) parts.push("mod");
    if (event.metaKey) parts.push("meta");
  }
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");
  if (parts.length === 0) {
    return null;
  }
  parts.push(keyToken);
  return parts.join("+");
}

export default function ProjectScriptsControl({
  scripts,
  keybindings,
  preferredScriptId = null,
  showInlineControls = true,
  hideInlineLabel = false,
  onRunScript,
  onAddScript,
  onUpdateScript,
  onDeleteScript,
}: ProjectScriptsControlProps) {
  const { t } = useTranslation();
  const addScriptFormId = React.useId();
  const [editingScriptId, setEditingScriptId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [icon, setIcon] = useState<ProjectScriptIcon>("play");
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [runOnWorktreeCreate, setRunOnWorktreeCreate] = useState(false);
  const [keybinding, setKeybinding] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  const primaryScript = useMemo(() => {
    if (preferredScriptId) {
      const preferred = scripts.find((script) => script.id === preferredScriptId);
      if (preferred) return preferred;
    }
    return primaryProjectScript(scripts);
  }, [preferredScriptId, scripts]);
  const isEditing = editingScriptId !== null;
  const actionMenuItemClassName =
    "group grid min-h-9 grid-cols-[1rem_minmax(0,1fr)_1.5rem] items-center gap-2 rounded-xl px-2.5 py-1.5 text-[13px] leading-none data-highlighted:bg-transparent data-highlighted:text-foreground hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground focus-visible:bg-[var(--color-background-button-secondary-hover)] focus-visible:text-foreground data-highlighted:hover:bg-[var(--color-background-button-secondary-hover)] data-highlighted:hover:text-foreground data-highlighted:focus-visible:bg-[var(--color-background-button-secondary-hover)] data-highlighted:focus-visible:text-foreground [&>svg]:mx-0 [&>svg]:size-4";

  const captureKeybinding = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Tab") return;
    event.preventDefault();
    if (event.key === "Backspace" || event.key === "Delete") {
      setKeybinding("");
      return;
    }
    const next = keybindingFromEvent(event);
    if (!next) return;
    setKeybinding(next);
  };

  const submitAddScript = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedName = name.trim();
    const trimmedCommand = command.trim();
    if (trimmedName.length === 0) {
      setValidationError(t("project.scripts.nameRequired"));
      return;
    }
    if (trimmedCommand.length === 0) {
      setValidationError(t("project.scripts.commandRequired"));
      return;
    }

    setValidationError(null);
    try {
      const scriptIdForValidation =
        editingScriptId ??
        nextProjectScriptId(
          trimmedName,
          scripts.map((script) => script.id),
        );
      const keybindingRule = decodeProjectScriptKeybindingRule({
        keybinding,
        command: commandForProjectScript(scriptIdForValidation),
      });
      const payload = {
        name: trimmedName,
        command: trimmedCommand,
        icon,
        runOnWorktreeCreate,
        keybinding: keybindingRule?.key ?? null,
      } satisfies NewProjectScriptInput;
      if (editingScriptId) {
        await onUpdateScript(editingScriptId, payload);
      } else {
        await onAddScript(payload);
      }
      setDialogOpen(false);
      setIconPickerOpen(false);
    } catch (error) {
      setValidationError(
        error instanceof Error ? error.message : t("project.scripts.failedToSave"),
      );
    }
  };

  const openAddDialog = () => {
    setEditingScriptId(null);
    setName("");
    setCommand("");
    setIcon("play");
    setIconPickerOpen(false);
    setRunOnWorktreeCreate(false);
    setKeybinding("");
    setValidationError(null);
    setDialogOpen(true);
  };

  const openEditDialog = (script: ProjectScript) => {
    setEditingScriptId(script.id);
    setName(script.name);
    setCommand(script.command);
    setIcon(script.icon);
    setIconPickerOpen(false);
    setRunOnWorktreeCreate(script.runOnWorktreeCreate);
    setKeybinding(keybindingValueForCommand(keybindings, commandForProjectScript(script.id)) ?? "");
    setValidationError(null);
    setDialogOpen(true);
  };

  const confirmDeleteScript = useCallback(() => {
    if (!editingScriptId) return;
    setDeleteConfirmOpen(false);
    setDialogOpen(false);
    void onDeleteScript(editingScriptId);
  }, [editingScriptId, onDeleteScript]);

  return (
    <>
      {showInlineControls && primaryScript ? (
        <ChatHeaderSplitGroup label={t("project.scripts.projectActions")}>
          <ChatHeaderButton
            className={cn(
              CHAT_HEADER_SPLIT_LEADING_CLASS_NAME,
              "min-w-0 gap-1.5 px-2.5",
              hideInlineLabel ? "px-2" : "max-w-44",
            )}
            onClick={() => onRunScript(primaryScript)}
            aria-label={t("project.scripts.runName", { name: primaryScript.name })}
            title={t("project.scripts.runName", { name: primaryScript.name })}
          >
            <ScriptIcon icon={primaryScript.icon} className="size-3.5 shrink-0" />
            <span
              className={cn(
                "max-w-32 truncate font-normal",
                hideInlineLabel ? "sr-only" : "hidden sm:inline",
              )}
            >
              {primaryScript.name}
            </span>
          </ChatHeaderButton>
          <ChatHeaderSplitDivider />
          <Menu highlightItemOnHover={false}>
            <MenuTrigger
              render={
                <ChatHeaderIconButton
                  label={t("project.scripts.scriptActions")}
                  tone="outline"
                  className={CHAT_HEADER_SPLIT_TRAILING_CLASS_NAME}
                />
              }
            >
              <ChevronDownIcon className="size-3.5" />
            </MenuTrigger>
            <MenuPopup align="end" className="min-w-64" sideOffset={8}>
              {scripts.map((script) => {
                const shortcutLabel = shortcutLabelForCommand(
                  keybindings,
                  commandForProjectScript(script.id),
                );
                return (
                  <MenuItem
                    key={script.id}
                    className={actionMenuItemClassName}
                    onClick={() => onRunScript(script)}
                  >
                    <ScriptIcon icon={script.icon} className="size-4 text-muted-foreground" />
                    <span className="min-w-0 truncate">
                      {script.runOnWorktreeCreate
                        ? `${script.name} (${t("project.scripts.setup")})`
                        : script.name}
                    </span>
                    <span className="flex min-w-0 items-center justify-end">
                      {shortcutLabel && (
                        <MenuShortcut className="ms-0 transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0">
                          {shortcutLabel}
                        </MenuShortcut>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="size-6 rounded-lg opacity-50 transition-opacity sm:pointer-events-none sm:opacity-0 sm:group-hover:pointer-events-auto sm:group-hover:opacity-100 sm:group-focus-visible:pointer-events-auto sm:group-focus-visible:opacity-100"
                        aria-label={t("project.scripts.editName", { name: script.name })}
                        onPointerDown={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                        }}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          openEditDialog(script);
                        }}
                      >
                        <SettingsIcon className="size-3.5" />
                      </Button>
                    </span>
                  </MenuItem>
                );
              })}
              <MenuItem className={actionMenuItemClassName} onClick={openAddDialog}>
                <PlusIcon className="size-4 text-muted-foreground" />
                <span className="col-span-2 min-w-0 truncate">{t("project.scripts.addAction")}</span>
              </MenuItem>
            </MenuPopup>
          </Menu>
        </ChatHeaderSplitGroup>
      ) : showInlineControls ? (
        <ChatHeaderButton
          className={cn("gap-1.5 px-2.5", hideInlineLabel && "px-2")}
          onClick={openAddDialog}
          aria-label={t("project.scripts.addAction")}
          title={t("project.scripts.addAction")}
        >
          <PlusIcon className="size-3.5" />
          <span className={cn("font-normal", hideInlineLabel ? "sr-only" : "hidden sm:inline")}>
            {t("project.scripts.addAction")}
          </span>
        </ChatHeaderButton>
      ) : null}

      <Dialog
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) {
            setIconPickerOpen(false);
          }
        }}
        onOpenChangeComplete={(open) => {
          if (open) return;
          setEditingScriptId(null);
          setName("");
          setCommand("");
          setIcon("play");
          setRunOnWorktreeCreate(false);
          setKeybinding("");
          setValidationError(null);
        }}
        open={dialogOpen}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              {isEditing ? t("project.scripts.editAction") : t("project.scripts.addActionTitle")}
            </DialogTitle>
            <DialogDescription>{t("project.scripts.actionsDescription")}</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <form id={addScriptFormId} className="space-y-4" onSubmit={submitAddScript}>
              <div className="space-y-1.5">
                <Label htmlFor="script-name">{t("project.scripts.name")}</Label>
                <div className="flex items-center gap-2">
                  <Popover onOpenChange={setIconPickerOpen} open={iconPickerOpen}>
                    <PopoverTrigger
                      render={
                        <Button
                          type="button"
                          variant="outline"
                          className="size-9 shrink-0 hover:bg-popover active:bg-popover data-pressed:bg-popover"
                          aria-label={t("project.scripts.chooseIcon")}
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
                              className={`relative flex flex-col items-center gap-2 rounded-md border px-2 py-2 text-xs ${
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
                              <span>{entry.label}</span>
                            </button>
                          );
                        })}
                      </div>
                    </PopoverPopup>
                  </Popover>
                  <Input
                    id="script-name"
                    autoFocus
                    placeholder="测试"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="script-keybinding">{t("project.scripts.keybinding")}</Label>
                <Input
                  id="script-keybinding"
                  placeholder={t("project.scripts.keybindingHint")}
                  value={keybinding}
                  readOnly
                  onKeyDown={captureKeybinding}
                />
                <p className="text-xs text-muted-foreground">
                  Press a shortcut. Use <code>Backspace</code> to clear.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="script-command">{t("project.scripts.command")}</Label>
                <Textarea
                  id="script-command"
                  placeholder="bun test"
                  value={command}
                  onChange={(event) => setCommand(event.target.value)}
                />
              </div>
              <label className="flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2 text-sm">
                <span>{t("project.scripts.runOnWorktree")}</span>
                <Switch
                  checked={runOnWorktreeCreate}
                  onCheckedChange={(checked) => setRunOnWorktreeCreate(Boolean(checked))}
                />
              </label>
              {validationError && <p className="text-sm text-destructive">{validationError}</p>}
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
                {t("project.scripts.delete")}
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setDialogOpen(false);
              }}
            >
              {t("project.scripts.cancel")}
            </Button>
            <Button form={addScriptFormId} type="submit" size="sm">
              {isEditing ? t("project.scripts.saveChanges") : t("project.scripts.saveAction")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("project.scripts.deleteActionTitle", { name })}</AlertDialogTitle>
            <AlertDialogDescription>{t("project.scripts.deleteActionDesc")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="sm" />}>
              {t("project.scripts.cancel")}
            </AlertDialogClose>
            <Button variant="destructive" size="sm" onClick={confirmDeleteScript}>
              {t("project.scripts.deleteAction")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
