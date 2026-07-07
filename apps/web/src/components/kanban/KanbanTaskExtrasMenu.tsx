// FILE: KanbanTaskExtrasMenu.tsx
// Purpose: Compact plus-menu for kanban task mode/environment toggles.
// Layer: Kanban UI component
// Exports: KanbanTaskExtrasMenu

import type { ProviderInteractionMode } from "@t3tools/contracts";
import { useTranslation } from "react-i18next";

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
  const { t } = useTranslation();
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="icon-sm"
            variant="chrome"
            className="shrink-0 rounded-md"
            aria-label={t("kanban.taskOptions")}
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
            {t("kanban.planMode")}
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
              {t("kanban.local")}
            </span>
          </MenuRadioItem>
          <MenuRadioItem value="worktree">
            <span className="inline-flex items-center gap-2">
              <WorktreeIcon className="size-4 shrink-0" aria-hidden />
              {t("kanban.worktree")}
            </span>
          </MenuRadioItem>
        </MenuRadioGroup>
      </ComposerPickerMenuPopup>
    </Menu>
  );
}
