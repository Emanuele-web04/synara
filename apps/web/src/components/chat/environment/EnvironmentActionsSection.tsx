// FILE: EnvironmentActionsSection.tsx
// Purpose: Environment panel section that lists the active project's actions (scripts).
//          This is where the first action gets created now that the chat top bar's
//          "Add action" button became the New thread button: the header only runs actions,
//          this section owns their full list plus add/edit/delete.
// Layer: Environment panel section

import type { ProjectScript, ResolvedKeybindingsConfig } from "@synara/contracts";
import { useCallback, useMemo, useState } from "react";

import { IconButton } from "~/components/ui/icon-button";
import { PlusIcon, SettingsIcon } from "~/lib/icons";

import {
  ProjectActionDialog,
  ScriptIcon,
  type NewProjectScriptInput,
} from "../ProjectActionDialog";
import {
  ENVIRONMENT_ROW_ICON_CLASS_NAME,
  EnvironmentRow,
  EnvironmentSectionDivider,
  EnvironmentCollapsibleSection,
} from "./EnvironmentRow";

export interface EnvironmentActionsSectionProps {
  readonly scripts: readonly ProjectScript[];
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly onRunScript: (script: ProjectScript) => void;
  readonly onAddScript: (input: NewProjectScriptInput) => Promise<void> | void;
  readonly onUpdateScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void> | void;
  readonly onDeleteScript: (scriptId: string) => Promise<void> | void;
}

export function EnvironmentActionsSection({
  scripts,
  keybindings,
  onRunScript,
  onAddScript,
  onUpdateScript,
  onDeleteScript,
}: EnvironmentActionsSectionProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingScriptId, setEditingScriptId] = useState<string | null>(null);
  const editingScript = useMemo(
    () =>
      editingScriptId ? (scripts.find((script) => script.id === editingScriptId) ?? null) : null,
    [editingScriptId, scripts],
  );

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
      <EnvironmentSectionDivider />
      {/* Keep action management out of the panel until explicitly expanded. */}
      <EnvironmentCollapsibleSection label="Actions" defaultOpen={false}>
        <div className="flex justify-end pr-2">
          <IconButton label="Add action" tooltip="Add action" onClick={openAddDialog}>
            <PlusIcon className="size-3.5" />
          </IconButton>
        </div>
        {scripts.length === 0 ? (
          <p className="px-2 pb-1 text-ui-sm leading-snug text-[var(--color-text-foreground-secondary)]">
            No actions yet. Add one to run it from the top bar or a keybinding.
          </p>
        ) : (
          scripts.map((script) => (
            <div key={script.id} className="group/action relative">
              <EnvironmentRow
                icon={<ScriptIcon icon={script.icon} className={ENVIRONMENT_ROW_ICON_CLASS_NAME} />}
                label={<span className="truncate">{script.name}</span>}
                trailing={
                  <>
                    {script.runOnWorktreeCreate ? (
                      <span className="text-[var(--color-text-foreground-secondary)]">Setup</span>
                    ) : null}
                    <span
                      aria-hidden
                      className="hidden w-7 group-focus-within/action:block group-hover/action:block sm:w-6"
                    />
                  </>
                }
                aria-label={`Run ${script.name}`}
                onClick={() => onRunScript(script)}
              />
              <IconButton
                label={`Edit ${script.name}`}
                tooltip="Edit action"
                className="absolute top-1/2 right-2 -translate-y-1/2 opacity-0 transition-opacity group-hover/action:opacity-100 focus-visible:opacity-100"
                onClick={() => openEditDialog(script)}
              >
                <SettingsIcon className="size-3.5" />
              </IconButton>
            </div>
          ))
        )}
      </EnvironmentCollapsibleSection>

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
