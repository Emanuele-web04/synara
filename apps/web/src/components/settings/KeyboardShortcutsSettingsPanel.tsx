// FILE: KeyboardShortcutsSettingsPanel.tsx
// Purpose: Settings → Keybindings: every built-in command with its shortcuts, each one
//          changed, added, or removed in place, plus the reset back to what ships.
// Layer: Settings UI components
// Depends on: the shortcut editor model, the recorder dialog, server keybindings config, and the Kbd pill.

import type {
  ResolvedKeybindingsConfig,
  ServerConfig,
  ServerKeybindingEdit,
} from "@synara/contracts";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "~/components/ui/button";
import { IconButton } from "~/components/ui/icon-button";
import { SearchInput } from "~/components/ui/search-input";
import { ShortcutKbd } from "~/components/ui/shortcut-kbd";
import { toastManager } from "~/components/ui/toast";
import { showConfirmDialogFallback } from "~/confirmDialogFallback";
import {
  buildShortcutEditorRows,
  filterShortcutEditorRows,
  shortcutRemoveEdits,
  type ShortcutEditorBinding,
  type ShortcutEditorRow,
  type ShortcutEditorSource,
} from "~/keybindingEditor";
import { CentralIcon } from "~/lib/central-icons";
import { AddPlusIcon, PencilIcon, ResetIcon, TrashCanIcon } from "~/lib/icons";
import { ensureNativeApi, readNativeApi } from "~/nativeApi";
import { serverConfigQueryOptions, serverQueryKeys } from "~/lib/serverReactQuery";
import { cn, getNavigatorPlatform } from "~/lib/utils";
import {
  SETTINGS_CARD_ROW_CLASS_NAME,
  SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME,
  SETTINGS_CARD_ROW_TITLE_CLASS_NAME,
} from "~/settingsPanelStyles";
import { SettingsCard, SettingsEmptyState } from "./SettingsPanelPrimitives";
import { ShortcutRecorderDialog, type ShortcutRecorderTarget } from "./ShortcutRecorderDialog";

// Stable empty reference while the server config query is still loading.
const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];

/** The live bindings as editor rows, and the one call that changes them. */
function useShortcutEditor() {
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const queryClient = useQueryClient();
  const source: ShortcutEditorSource = {
    keybindings: serverConfigQuery.data?.keybindings ?? EMPTY_KEYBINDINGS,
    defaultKeybindings: serverConfigQuery.data?.defaultKeybindings,
    platform: getNavigatorPlatform(),
  };

  const applyEdits = async (edits: ServerKeybindingEdit[]): Promise<boolean> => {
    if (edits.length === 0) return true;
    try {
      const result = await ensureNativeApi().server.editKeybindings({ edits });
      queryClient.setQueryData(serverQueryKeys.config(), (current: ServerConfig | undefined) =>
        current ? { ...current, keybindings: result.keybindings, issues: result.issues } : current,
      );
      return true;
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not save shortcut",
        description: error instanceof Error ? error.message : "Try again.",
      });
      return false;
    }
  };

  return {
    source,
    rows: buildShortcutEditorRows(source),
    isLoading: serverConfigQuery.data === undefined,
    applyEdits,
  };
}

/** Header action for the Keybindings section: puts every built-in shortcut back. */
export function KeyboardShortcutsResetButton() {
  const { rows, isLoading, applyEdits } = useShortcutEditor();
  const [isResetting, setIsResetting] = useState(false);
  const customized = rows.some((row) => !row.isDefault);

  const resetAll = async () => {
    const message = [
      "Reset all shortcuts to their defaults?",
      "Every shortcut you changed, added, or removed goes back to what Synara ships with. Project script shortcuts are kept.",
    ].join("\n");
    const api = readNativeApi();
    const confirmed = api
      ? await api.dialogs.confirm(message)
      : await showConfirmDialogFallback(message);
    if (!confirmed) return;
    setIsResetting(true);
    try {
      if (await applyEdits([{ type: "reset" }])) {
        toastManager.add({ type: "success", title: "Shortcuts reset to defaults" });
      }
    } finally {
      setIsResetting(false);
    }
  };

  return (
    <Button
      size="xs"
      variant="outline"
      className="shrink-0"
      disabled={isLoading || !customized || isResetting}
      onClick={() => void resetAll()}
    >
      <ResetIcon className="size-3.5" />
      Reset all to defaults
    </Button>
  );
}

export function KeyboardShortcutsSettingsPanel() {
  const { source, rows, isLoading, applyEdits } = useShortcutEditor();
  const [query, setQuery] = useState("");
  const [recorderTarget, setRecorderTarget] = useState<ShortcutRecorderTarget | null>(null);
  const [recorderOpen, setRecorderOpen] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const filteredRows = filterShortcutEditorRows(rows, query);

  const record = (row: ShortcutEditorRow, binding: ShortcutEditorBinding | null) => {
    setRecorderTarget({ row, binding, source });
    setRecorderOpen(true);
  };
  const remove = async (binding: ShortcutEditorBinding) => {
    if (isRemoving) return;
    setIsRemoving(true);
    try {
      await applyEdits(shortcutRemoveEdits(binding));
    } finally {
      setIsRemoving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="relative w-full">
        <SearchInput
          type="search"
          nativeInput
          placeholder="Search shortcuts"
          value={query}
          aria-label="Search shortcuts"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && query.length > 0) {
              event.preventDefault();
              event.stopPropagation();
              setQuery("");
            }
          }}
          className="[&>[data-slot=input]]:pr-9"
        />
        <CentralIcon
          name="cmd-box"
          className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/70"
        />
      </div>

      {isLoading ? (
        <SettingsEmptyState layout="status">Loading shortcuts…</SettingsEmptyState>
      ) : filteredRows.length > 0 ? (
        <SettingsCard>
          {filteredRows.map((row) => (
            <ShortcutRow
              key={row.id}
              row={row}
              disabled={isRemoving}
              onRecord={(binding) => record(row, binding)}
              onRemove={(binding) => void remove(binding)}
            />
          ))}
        </SettingsCard>
      ) : (
        <SettingsEmptyState>No shortcuts match &ldquo;{query}&rdquo;.</SettingsEmptyState>
      )}

      <ShortcutRecorderDialog
        open={recorderOpen}
        target={recorderTarget}
        onOpenChange={setRecorderOpen}
        onApply={applyEdits}
      />
    </div>
  );
}

function ShortcutRow({
  row,
  disabled,
  onRecord,
  onRemove,
}: {
  row: ShortcutEditorRow;
  disabled: boolean;
  onRecord: (binding: ShortcutEditorBinding | null) => void;
  onRemove: (binding: ShortcutEditorBinding) => void;
}) {
  return (
    <div
      className={cn(
        SETTINGS_CARD_ROW_CLASS_NAME,
        "group/shortcut grid grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)] items-center gap-4",
      )}
    >
      <div className="min-w-0 space-y-0.5">
        <div className={SETTINGS_CARD_ROW_TITLE_CLASS_NAME}>{row.label}</div>
        <div className={SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME}>{row.description}</div>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        {row.bindings.length > 0 ? (
          row.bindings.map((binding, index) => (
            <div key={binding.id} className="flex min-h-7 items-center gap-1">
              <ShortcutKbd joined shortcutLabel={binding.label} groupClassName="mr-1.5 shrink-0" />
              <IconButton
                label={`Change the shortcut ${binding.label} for ${row.label}`}
                tooltip="Change shortcut"
                onClick={() => onRecord(binding)}
              >
                <PencilIcon className="size-3" />
              </IconButton>
              {index === row.bindings.length - 1 ? (
                <IconButton
                  label={`Add another shortcut for ${row.label}`}
                  tooltip="Add another shortcut"
                  className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover/shortcut:opacity-100 pointer-coarse:opacity-100"
                  onClick={() => onRecord(null)}
                >
                  <AddPlusIcon className="size-3" />
                </IconButton>
              ) : null}
              <IconButton
                label={`Remove the shortcut ${binding.label} from ${row.label}`}
                tooltip="Remove shortcut"
                className="ml-auto"
                disabled={disabled}
                onClick={() => onRemove(binding)}
              >
                <TrashCanIcon />
              </IconButton>
            </div>
          ))
        ) : (
          <div className="flex min-h-7 items-center gap-1">
            <span className="mr-1.5 text-ui text-muted-foreground">Unassigned</span>
            <IconButton
              label={`Set a shortcut for ${row.label}`}
              tooltip="Set shortcut"
              onClick={() => onRecord(null)}
            >
              <PencilIcon className="size-3" />
            </IconButton>
          </div>
        )}
      </div>
    </div>
  );
}
