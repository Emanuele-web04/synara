// FILE: KanbanTaskExtrasMenu.tsx
// Purpose: Compact plus-menu for kanban task mode/environment toggles.
// Layer: Kanban UI component
// Exports: KanbanTaskExtrasMenu

import type { ProviderInteractionMode } from "@synara/contracts";

import { ComposerPickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";
import { CentralIcon } from "~/lib/central-icons";
import { ListTodoIcon, PlusIcon, WorktreeIcon } from "~/lib/icons";
import type { DraftThreadEnvMode } from "../../composerDraftStore";

interface KanbanTaskExtrasMenuProps {
  readonly interactionMode: ProviderInteractionMode;
  readonly onInteractionModeChange: (mode: ProviderInteractionMode) => void;
  readonly envMode: DraftThreadEnvMode;
  readonly onEnvModeChange: (mode: DraftThreadEnvMode) => void;
}

/**
 * The composer `+` analog: a single chrome icon button hosting the task's quick
 * toggles (Plan mode and Local/Worktree environment), mirroring how the
 * composer's ComposerExtrasMenu collapses mode switches behind one `+`.
 */
export function KanbanTaskExtrasMenu({
  interactionMode,
  onInteractionModeChange,
  envMode,
  onEnvModeChange,
}: KanbanTaskExtrasMenuProps) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="icon-sm"
            variant="chrome"
            className="shrink-0 rounded-md"
            aria-label="Task options"
          />
        }
      >
        <PlusIcon aria-hidden="true" className="size-4" />
      </MenuTrigger>
      <ComposerPickerMenuPopup align="start">
        <MenuCheckboxItem
          checked={interactionMode === "plan"}
          variant="switch"
          onCheckedChange={(checked) => {
            onInteractionModeChange(checked === true ? "plan" : "default");
          }}
        >
          <span className="inline-flex items-center gap-2">
            <ListTodoIcon className="size-4 shrink-0" />
            Plan mode
          </span>
        </MenuCheckboxItem>
        <MenuSeparator />
        <MenuRadioGroup
          value={envMode}
          onValueChange={(value) => {
            if (value === "local" || value === "worktree") {
              onEnvModeChange(value);
            }
          }}
        >
          <MenuRadioItem value="local">
            <span className="inline-flex items-center gap-2">
              <CentralIcon name="macbook-air" className="size-4 shrink-0" />
              Local
            </span>
          </MenuRadioItem>
          <MenuRadioItem value="worktree">
            <span className="inline-flex items-center gap-2">
              <WorktreeIcon className="size-4 shrink-0" aria-hidden />
              Worktree
            </span>
          </MenuRadioItem>
        </MenuRadioGroup>
      </ComposerPickerMenuPopup>
    </Menu>
  );
}
