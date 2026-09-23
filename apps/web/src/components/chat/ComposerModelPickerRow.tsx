// FILE: ComposerModelPickerRow.tsx
// Purpose: One model row of the composer model picker — name, mod+digit hint, star toggle,
//   and (for models with an effort ladder, in menu mode) a hover side block that picks model + effort at once.
// Layer: Chat composer presentation
// Depends on: composer trait resolution, starred model keys, and shared menu primitives.

import { type ProviderModelDescriptor } from "@synara/contracts";

import { type StarredModel, starredModelSlotKey } from "~/lib/starredModels";
import { cn } from "~/lib/utils";
import { type ProviderOptions } from "../../providerModelOptions";
import { PROVIDER_ICON_COMPONENT_BY_PROVIDER } from "../ProviderIcon";
import { Kbd } from "../ui/kbd";
import {
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSub,
  MenuSubTrigger,
} from "../ui/menu";
import {
  type ComposerModelPickerRow as PickerRow,
  resolveStarredTraits,
} from "./ComposerModelPicker.logic";
import { ComposerPickerMenuSubPopup } from "./ComposerPickerMenuPopup";
import { COMPOSER_MUTED_ACCENT_TEXT_CLASS_NAME } from "./composerPickerStyles";
import { getComposerTraitSelection } from "./composerTraits";
import { ModelStarButton } from "./ModelStarButton";
import { PICKER_PANEL_ROW_SELECTED_CLASS_NAME } from "./pickerPanelStyles";
import { getProviderIconClassName } from "./ProviderModelPicker";
import { resolveRuntimeModelDescriptor } from "./runtimeModelCapabilities";

// Each row resolves its own traits, so a long catalog only recomputes the rows whose
// inputs changed instead of the whole list on every keystroke.
export function ComposerModelPickerRow(props: {
  row: PickerRow;
  /** "⌘1"-style hint, or null beyond the addressable rows. */
  shortcutHint: string | null;
  /** Provider options the row's model would run with (drives its effort + star state). */
  providerOptions: ProviderOptions | undefined;
  runtimeModels: ReadonlyArray<ProviderModelDescriptor> | null | undefined;
  prompt: string;
  /** `starredModelSlotKey`s of every starred preset. */
  starredModelSlots: ReadonlySet<string>;
  onSelect: (row: PickerRow) => void;
  /** Null hides the hover effort side block (the picker's footer slider owns effort). */
  onSelectEffort: ((row: PickerRow, effort: string) => void) | null;
  onToggleStar: (entry: StarredModel) => void;
  onUnstarModel: (entry: Pick<StarredModel, "provider" | "model">) => void;
}) {
  const { row } = props;
  const selection = getComposerTraitSelection(
    row.provider,
    row.model,
    props.prompt,
    props.providerOptions,
    resolveRuntimeModelDescriptor({
      provider: row.provider,
      model: row.model,
      runtimeModels: props.runtimeModels,
    }),
  );
  const starEntry: StarredModel = row.preset ?? {
    provider: row.provider,
    model: row.model,
    ...resolveStarredTraits(selection),
  };
  // Provider rows ignore the pinned traits: the provider's current traits are shared by
  // all of its models, so matching them would hide the star of every other preset.
  const starred = row.preset !== null || props.starredModelSlots.has(starredModelSlotKey(row));
  // Starred rows already pin their effort; Ultrathink locks the ladder to the prompt.
  const onSelectEffort = props.onSelectEffort;
  const effortLevels =
    onSelectEffort !== null && row.preset === null && !selection.ultrathinkPromptControlled
      ? selection.effortLevels
      : [];
  const RowProviderIcon = PROVIDER_ICON_COMPONENT_BY_PROVIDER[row.provider];
  const rowClassName = cn("pe-1", row.selected && PICKER_PANEL_ROW_SELECTED_CLASS_NAME);
  const starButton = (
    <ModelStarButton
      starred={starred}
      iconClassName="size-3.5"
      label={
        starred
          ? `Remove ${row.name} from starred`
          : `Star ${row.name} with its current effort and speed`
      }
      onToggle={() =>
        row.preset === null && starred ? props.onUnstarModel(row) : props.onToggleStar(starEntry)
      }
    />
  );

  const rowContent = (
    <>
      {row.preset ? (
        <RowProviderIcon
          aria-hidden="true"
          className={cn("size-3.5 shrink-0", getProviderIconClassName(row.provider))}
        />
      ) : null}
      <span className={cn("truncate", row.detail !== null && "max-w-[62%] shrink-0")}>
        {row.name}
      </span>
      <span className={cn("min-w-0 flex-1 truncate", COMPOSER_MUTED_ACCENT_TEXT_CLASS_NAME)}>
        {row.detail}
      </span>
      {props.shortcutHint ? (
        <Kbd className="h-4 min-w-4 shrink-0 px-1 text-ui-2xs text-muted-foreground">
          {props.shortcutHint}
        </Kbd>
      ) : null}
      {row.selectableModel !== null ? starButton : null}
    </>
  );

  if (row.selectableModel === null) {
    return (
      <div className="relative">
        <MenuItem disabled className="pe-8" closeOnClick={false}>
          {rowContent}
        </MenuItem>
        <div className="absolute inset-y-0 end-1 flex items-center">{starButton}</div>
      </div>
    );
  }

  if (onSelectEffort === null || effortLevels.length === 0) {
    return (
      <MenuItem
        aria-current={row.selected ? "true" : undefined}
        className={rowClassName}
        // The picker decides whether a pick closes it (slider mode keeps it open).
        closeOnClick={false}
        onClick={() => props.onSelect(row)}
      >
        {rowContent}
      </MenuItem>
    );
  }
  return (
    <MenuSub>
      <MenuSubTrigger
        aria-current={row.selected ? "true" : undefined}
        className={rowClassName}
        // Clicking the row keeps the current effort; the side block picks another.
        onClick={() => props.onSelect(row)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          event.preventBaseUIHandler();
          props.onSelect(row);
        }}
      >
        {rowContent}
      </MenuSubTrigger>
      <ComposerPickerMenuSubPopup>
        <MenuGroup>
          <MenuGroupLabel>{row.provider === "opencode" ? "Variant" : "Effort"}</MenuGroupLabel>
          <MenuRadioGroup value={selection.effort ?? ""}>
            {effortLevels.map((level) => (
              <MenuRadioItem
                key={level.value}
                value={level.value}
                onClick={() => onSelectEffort(row, level.value)}
              >
                {level.label}
                {level.value === selection.defaultEffort ? " (default)" : ""}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </ComposerPickerMenuSubPopup>
    </MenuSub>
  );
}
