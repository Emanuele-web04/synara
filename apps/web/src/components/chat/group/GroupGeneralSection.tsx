import type { ModelSelection } from "@synara/contracts";

import { Input } from "~/components/ui/input";
import { SettingsCard, SettingsSectionShell } from "~/components/settings/SettingsPanelPrimitives";
import { dialogFieldLabelClassName } from "~/components/ui/dialog";
import { cn } from "~/lib/utils";

import { CharacterCountTextarea } from "./CharacterCountTextarea";
import { COORDINATOR_COLOR_OPTIONS, COORDINATOR_ICON_OPTIONS } from "./coordinatorAppearance";
import { GroupIconPicker } from "./GroupIconPicker";
import { GroupEffortRow, GroupModelRow } from "./GroupModelEffortRow";
import {
  GROUP_GOAL_MAX_CHARS,
  GROUP_NAME_MAX_CHARS,
  type GroupSettingsDraft,
} from "./groupSettingsDialog.logic";

export function GroupGeneralSection(props: {
  readonly draft: GroupSettingsDraft;
  readonly defaultModelSelection: ModelSelection | null;
  readonly projectCwd: string;
  readonly onChange: (patch: Partial<GroupSettingsDraft>) => void;
}) {
  const { draft, onChange } = props;
  return (
    <div className="space-y-6">
      <SettingsSectionShell title="Group">
        <SettingsCard>
          <div className="space-y-1.5 px-4 py-3">
            <p className={cn(dialogFieldLabelClassName)}>Name</p>
            <Input
              value={draft.name}
              maxLength={GROUP_NAME_MAX_CHARS}
              onChange={(event) => onChange({ name: event.target.value })}
              placeholder="Group name"
              aria-label="Group name"
            />
          </div>
          <div className="space-y-1.5 px-4 py-3">
            <p className={cn(dialogFieldLabelClassName)}>Icon</p>
            <GroupIconPicker value={draft.icon} onValueChange={(icon) => onChange({ icon })} />
          </div>
          <div className="px-4 py-3">
            <p className={cn(dialogFieldLabelClassName, "mb-1.5")}>Goal</p>
            <CharacterCountTextarea
              value={draft.goal}
              maxChars={GROUP_GOAL_MAX_CHARS}
              helper="The outcome you want the coordinator to work toward."
              placeholder="What should this group accomplish?"
              aria-label="Group goal"
              onChange={(event) => onChange({ goal: event.target.value })}
            />
          </div>
        </SettingsCard>
      </SettingsSectionShell>

      <SettingsSectionShell title="Coordinator">
        <SettingsCard>
          <div className="space-y-1.5 px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <p className={cn(dialogFieldLabelClassName)}>Appearance</p>
              <button
                type="button"
                aria-label="Use default coordinator appearance"
                className={cn(
                  "cursor-pointer text-ui-sm text-muted-foreground transition-colors hover:text-foreground",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 rounded-sm",
                )}
                onClick={() => onChange({ coordinatorIcon: "", coordinatorColor: "" })}
              >
                Use default
              </button>
            </div>
            <div
              className="flex flex-wrap items-center gap-1"
              role="group"
              aria-label="Coordinator icon"
            >
              {COORDINATOR_ICON_OPTIONS.map(({ key, label, Icon }) => {
                const selected = draft.coordinatorIcon === key;
                return (
                  <button
                    key={key}
                    type="button"
                    title={label}
                    aria-label={`Coordinator icon ${label}`}
                    aria-pressed={selected}
                    className={cn(
                      "relative grid size-8 place-items-center rounded-lg border-2 text-ui-lg transition-colors motion-reduce:transition-none",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                      selected
                        ? "border-foreground"
                        : "border-transparent hover:border-foreground/25",
                    )}
                    onClick={() => onChange({ coordinatorIcon: selected ? "" : key })}
                  >
                    <Icon className="size-4" />
                  </button>
                );
              })}
            </div>
            <div
              className="flex flex-wrap items-center gap-1 pt-1"
              role="group"
              aria-label="Coordinator color"
            >
              {COORDINATOR_COLOR_OPTIONS.map((option) => {
                const selected = draft.coordinatorColor === option.key;
                return (
                  <button
                    key={option.key}
                    type="button"
                    title={option.label}
                    aria-label={`Coordinator color ${option.label}`}
                    aria-pressed={selected}
                    className={cn(
                      "relative grid size-8 place-items-center rounded-lg border-2 transition-colors motion-reduce:transition-none",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                      selected
                        ? "border-foreground"
                        : "border-transparent hover:border-foreground/25",
                    )}
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
