import { useTranslation } from "~/i18n";
// FILE: ProjectScriptsControl.tsx
// Purpose: Chat-header control for running a project's actions (scripts).
//          Creating and editing an action lives in ProjectActionDialog, which this control
//          shares with the Environment panel's Actions section.
// Layer: Chat shell header control

import type { ProjectScript, ResolvedKeybindingsConfig } from "@synara/contracts";
import { ChevronDownIcon, PlusIcon, SettingsIcon } from "~/lib/icons";
import React, { useCallback, useMemo, useState } from "react";

import { shortcutLabelForCommand } from "~/keybindings";
import { commandForProjectScript, primaryProjectScript } from "~/projectScripts";
import {
  CHAT_HEADER_SPLIT_LEADING_CLASS_NAME,
  CHAT_HEADER_SPLIT_TRAILING_CLASS_NAME,
  ChatHeaderIconButton,
  ChatHeaderSplitDivider,
  ChatHeaderSplitGroup,
} from "./chat/chatHeaderControls";
import { ComposerPickerMenuPopup } from "./chat/ComposerPickerMenuPopup";
import {
  ProjectActionDialog,
  ScriptIcon,
  type NewProjectScriptInput,
} from "./chat/ProjectActionDialog";
import { Button } from "./ui/button";
import { Menu, MenuItem, MenuShortcut, MenuTrigger } from "./ui/menu";

export type { NewProjectScriptInput };

interface ProjectScriptsControlProps {
  scripts: ProjectScript[];
  keybindings: ResolvedKeybindingsConfig;
  preferredScriptId?: string | null;
  onRunScript: (script: ProjectScript) => void;
  onAddScript: (input: NewProjectScriptInput) => Promise<void> | void;
  onUpdateScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void> | void;
  onDeleteScript: (scriptId: string) => Promise<void> | void;
}

export default function ProjectScriptsControl({
  scripts,
  keybindings,
  preferredScriptId: preferredScriptIdProp,
  onRunScript,
  onAddScript,
  onUpdateScript,
  onDeleteScript,
}: ProjectScriptsControlProps) {
  const { t } = useTranslation();

  const preferredScriptId = preferredScriptIdProp ?? null;
  const [editingScriptId, setEditingScriptId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  // Manual memoization kept: this file does not compile under React Compiler (see compile-report).
  const primaryScript = useMemo(() => {
    if (preferredScriptId) {
      const preferred = scripts.find((script) => script.id === preferredScriptId);
      if (preferred) return preferred;
    }
    return primaryProjectScript(scripts);
  }, [preferredScriptId, scripts]);
  const editingScript = useMemo(
    () =>
      editingScriptId ? (scripts.find((script) => script.id === editingScriptId) ?? null) : null,
    [editingScriptId, scripts],
  );
  const actionMenuItemClassName =
    "group grid min-h-9 grid-cols-[1rem_minmax(0,1fr)_1.5rem] items-center gap-2 rounded-xl px-2.5 py-1.5 text-ui-lg leading-none data-highlighted:bg-transparent data-highlighted:text-foreground hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground focus-visible:bg-[var(--color-background-button-secondary-hover)] focus-visible:text-foreground data-highlighted:hover:bg-[var(--color-background-button-secondary-hover)] data-highlighted:hover:text-foreground data-highlighted:focus-visible:bg-[var(--color-background-button-secondary-hover)] data-highlighted:focus-visible:text-foreground [&>svg]:mx-0 [&>svg]:size-4";

  const openAddDialog = () => {
    setEditingScriptId(null);
    setDialogOpen(true);
  };

  const openEditDialog = (script: ProjectScript) => {
    setEditingScriptId(script.id);
    setDialogOpen(true);
  };

  const handleSave = useCallback(
    async (input: NewProjectScriptInput) => {
      if (editingScriptId) {
        await onUpdateScript(editingScriptId, input);
        return;
      }
      await onAddScript(input);
    },
    [editingScriptId, onAddScript, onUpdateScript],
  );

  return (
    <>
      {primaryScript ? (
        // Icon-only, flat header controls: the action's name lives in the tooltip.
        <ChatHeaderSplitGroup label={t("workspace:projectActions")}>
          <ChatHeaderIconButton
            tone="surface"
            label={t("workspace:run", { value0: primaryScript.name })}
            title={t("workspace:run", { value0: primaryScript.name })}
            className={CHAT_HEADER_SPLIT_LEADING_CLASS_NAME}
            onClick={() => onRunScript(primaryScript)}
          >
            <ScriptIcon icon={primaryScript.icon} className="size-4 shrink-0" />
          </ChatHeaderIconButton>
          <ChatHeaderSplitDivider />
          <Menu highlightItemOnHover={false}>
            <MenuTrigger
              render={
                <ChatHeaderIconButton
                  tone="surface"
                  label={t("workspace:scripts_scriptActions")}
                  title={t("workspace:scripts_scriptActions")}
                  className={CHAT_HEADER_SPLIT_TRAILING_CLASS_NAME}
                />
              }
            >
              <ChevronDownIcon className="size-3.5" />
            </MenuTrigger>
            <ComposerPickerMenuPopup align="end" className="min-w-64" sideOffset={8}>
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
                        ? t("workspace:setup", { value0: script.name })
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
                        aria-label={t("workspace:edit", { value0: script.name })}
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
                <span className="col-span-2 min-w-0 truncate">
                  {t("workspace:scripts_addActionTitle")}
                </span>
              </MenuItem>
            </ComposerPickerMenuPopup>
          </Menu>
        </ChatHeaderSplitGroup>
      ) : null}

      <ProjectActionDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        scripts={scripts}
        keybindings={keybindings}
        editingScript={editingScript}
        onSave={handleSave}
        onDelete={onDeleteScript}
      />
    </>
  );
}
