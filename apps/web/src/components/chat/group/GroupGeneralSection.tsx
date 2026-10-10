import { DEFAULT_PROJECT_AGENT_LIMITS, type ModelSelection } from "@synara/contracts";

import { Input } from "~/components/ui/input";
import {
  SettingsCard,
  SettingsRow,
  SettingsSectionShell,
} from "~/components/settings/SettingsPanelPrimitives";
import { SettingsSelectControl } from "~/components/settings/SettingControls";
import { SelectItem } from "~/components/ui/select";
import { dialogFieldLabelClassName } from "~/components/ui/dialog";
import { cn } from "~/lib/utils";

import { CharacterCountTextarea } from "./CharacterCountTextarea";
import { COORDINATOR_COLOR_OPTIONS, COORDINATOR_ICON_OPTIONS } from "./coordinatorAppearance";
import { GroupEffortRow, GroupModelRow } from "./GroupModelEffortRow";
import {
  GROUP_GOAL_MAX_CHARS,
  GROUP_NAME_MAX_CHARS,
  type GroupSettingsDraft,
} from "./groupSettingsDialog.logic";

// One option tile for the icon and colour grids: quiet until hovered, with a
// hairline ring and a soft fill when selected.
function appearanceOptionClassName(selected: boolean): string {
  return cn(
    "grid size-8 place-items-center rounded-lg border transition-colors motion-reduce:transition-none",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
    selected
      ? "border-foreground/40 bg-[var(--color-background-elevated-secondary)]"
      : "border-transparent hover:bg-[var(--color-background-elevated-secondary)]",
  );
}

// The group's icon is the coordinator glyph and colour that the sidebar row and
// the chat header show, so it is picked once, here, next to the name.
export function GroupGeneralSection(props: {
  readonly draft: GroupSettingsDraft;
  readonly defaultModelSelection: ModelSelection | null;
  readonly projectCwd: string;
  readonly onChange: (patch: Partial<GroupSettingsDraft>) => void;
}) {
  const { draft, onChange } = props;
  const selectedColorClassName =
    COORDINATOR_COLOR_OPTIONS.find((option) => option.key === draft.coordinatorColor)
      ?.iconClassName ?? "";
  return (
    <div className="space-y-6">
      <SettingsSectionShell title="Hub">
        <SettingsCard>
          <div className="space-y-1.5 px-4 py-3">
            <p className={cn(dialogFieldLabelClassName)}>Name</p>
            <Input
              value={draft.name}
              maxLength={GROUP_NAME_MAX_CHARS}
              onChange={(event) => onChange({ name: event.target.value })}
              placeholder="Hub name"
              aria-label="Hub name"
            />
          </div>
          <div className="space-y-1.5 px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <p className={cn(dialogFieldLabelClassName)}>Icon</p>
              <button
                type="button"
                aria-label="Use the default hub icon"
                className={cn(
                  "cursor-pointer rounded-sm text-ui-sm text-muted-foreground transition-colors hover:text-foreground",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                )}
                onClick={() => onChange({ coordinatorIcon: "", coordinatorColor: "" })}
              >
                Use default
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Hub icon">
              {COORDINATOR_ICON_OPTIONS.map(({ key, label, Icon }) => {
                const selected = draft.coordinatorIcon === key;
                return (
                  <button
                    key={key}
                    type="button"
                    title={label}
                    aria-label={`Hub icon ${label}`}
                    aria-pressed={selected}
                    className={appearanceOptionClassName(selected)}
                    onClick={() => onChange({ coordinatorIcon: selected ? "" : key })}
                  >
                    <Icon className={cn("size-4", selectedColorClassName)} />
                  </button>
                );
              })}
            </div>
            <div
              className="flex flex-wrap items-center gap-1 pt-1"
              role="group"
              aria-label="Hub icon color"
            >
              {COORDINATOR_COLOR_OPTIONS.map((option) => {
                const selected = draft.coordinatorColor === option.key;
                return (
                  <button
                    key={option.key}
                    type="button"
                    title={option.label}
                    aria-label={`Hub icon color ${option.label}`}
                    aria-pressed={selected}
                    className={appearanceOptionClassName(selected)}
                    onClick={() => onChange({ coordinatorColor: selected ? "" : option.key })}
                  >
                    <span
                      className={cn("size-4 rounded-full", option.swatchClassName)}
                      aria-hidden
                    />
                  </button>
                );
              })}
            </div>
          </div>
          <div className="px-4 py-3">
            <p className={cn(dialogFieldLabelClassName, "mb-1.5")}>Goal</p>
            <CharacterCountTextarea
              value={draft.goal}
              maxChars={GROUP_GOAL_MAX_CHARS}
              helper="The outcome you want the coordinator to work toward."
              placeholder="What should this hub accomplish?"
              aria-label="Hub goal"
              onChange={(event) => onChange({ goal: event.target.value })}
            />
          </div>
        </SettingsCard>
      </SettingsSectionShell>

      <SettingsSectionShell title="Execution">
        <SettingsCard>
          <SettingsRow
            title="Parallel threads"
            description="Additional work waits in the queue until a slot is available."
            control={
              <SettingsSelectControl
                value={String(draft.maxConcurrentWorkers)}
                valueContent={String(
                  Math.min(
                    draft.maxConcurrentWorkers,
                    DEFAULT_PROJECT_AGENT_LIMITS.maxConcurrentWorkers,
                  ),
                )}
                ariaLabel="Parallel threads"
                onValueChange={(value) => onChange({ maxConcurrentWorkers: Number(value) })}
              >
                {Array.from(
                  { length: DEFAULT_PROJECT_AGENT_LIMITS.maxConcurrentWorkers },
                  (_, index) => (
                    <SelectItem key={index + 1} value={String(index + 1)}>
                      {index + 1}
                    </SelectItem>
                  ),
                )}
              </SettingsSelectControl>
            }
          />
        </SettingsCard>
      </SettingsSectionShell>

      <SettingsSectionShell title="Models">
        <SettingsCard>
          <GroupModelRow
            title="Coordinator model"
            description="Model for managing and creating threads."
            selection={draft.coordinatorModelSelection}
            defaultSelection={props.defaultModelSelection}
            projectCwd={props.projectCwd}
            onChange={(next) => onChange({ coordinatorModelSelection: next })}
          />
          <GroupEffortRow
            title="Coordinator effort"
            description="Effort for managing and creating threads."
            selection={draft.coordinatorModelSelection}
            projectCwd={props.projectCwd}
            onChange={(next) => onChange({ coordinatorModelSelection: next })}
          />
          <GroupModelRow
            title="Thread model"
            description="Default model for new threads."
            selection={draft.workerModelSelection}
            defaultSelection={props.defaultModelSelection}
            projectCwd={props.projectCwd}
            onChange={(next) => onChange({ workerModelSelection: next })}
          />
          <GroupEffortRow
            title="Thread effort"
            description="Default effort for new threads."
            selection={draft.workerModelSelection}
            projectCwd={props.projectCwd}
            onChange={(next) => onChange({ workerModelSelection: next })}
          />
        </SettingsCard>
      </SettingsSectionShell>
    </div>
  );
}
