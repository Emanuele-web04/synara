import type { KeepAwakeMode, ServerKeepAwakeState } from "@synara/contracts";
import { CoffeeIcon } from "~/lib/icons";
import {
  KEEP_AWAKE_MODE_OPTIONS,
  KEEP_AWAKE_ROW_TITLE,
  keepAwakeIndicatorState,
  keepAwakeStatusLabel,
  keepAwakeTooltip,
} from "~/lib/keepAwake";
import { cn } from "~/lib/utils";
import { SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME } from "./sidebarContextMenuStyles";
import { APP_RAIL_GLYPH_CLASS_NAME, appRailButtonClassName } from "./AppRail";
import { ComposerPickerMenuPopup } from "./chat/ComposerPickerMenuPopup";
import { SidebarIconButton } from "./SidebarIconButton";
import { SettingResetButton, SettingsSegmentedControl } from "./settings/SettingControls";
import { SettingsRow, SettingsSection } from "./settings/SettingsPanelPrimitives";
import {
  Menu,
  MenuTrigger,
  MenuGroup,
  MenuSeparator,
  MenuRadioGroup,
  MenuRadioItem,
} from "./ui/menu";

const KEEP_AWAKE_INDICATOR_ICON_CLASS_NAME = {
  dimmed: "opacity-40",
  default: "",
  highlighted: "text-primary",
  error: "text-destructive",
} as const satisfies Record<ReturnType<typeof keepAwakeIndicatorState>, string>;

// The rail keep-awake indicator sits above Help and opens its mode menu to the side.
// Hide it entirely while the server reports keep-awake as unavailable.
export function SidebarKeepAwakeMenu({
  state,
  onSelectMode,
}: {
  state: ServerKeepAwakeState | null;
  onSelectMode: (mode: KeepAwakeMode) => void;
}) {
  if (!state?.available) return null;
  const indicator = keepAwakeIndicatorState(state.mode, state.active, state.error);
  return (
    <Menu>
      <SidebarIconButton
        render={<MenuTrigger />}
        icon={CoffeeIcon}
        label={KEEP_AWAKE_ROW_TITLE}
        tooltip={keepAwakeTooltip(state)}
        iconClassName={cn(
          APP_RAIL_GLYPH_CLASS_NAME,
          KEEP_AWAKE_INDICATOR_ICON_CLASS_NAME[indicator],
        )}
        className={appRailButtonClassName(false)}
        tooltipSide="right"
        data-testid="sidebar-keep-awake-button"
      />
      <ComposerPickerMenuPopup align="end" side="right" className="w-72 min-w-72">
        <MenuGroup>
          <div className="px-2 py-1 text-ui-xs font-medium text-muted-foreground">
            {KEEP_AWAKE_ROW_TITLE}
          </div>
          <div
            className={cn(
              "px-2 pb-1 text-ui-xs",
              state.error ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {state.error ?? keepAwakeStatusLabel(state)}
          </div>
        </MenuGroup>
        <MenuSeparator />
        <MenuRadioGroup
          value={state.mode}
          onValueChange={(value) => onSelectMode(value as KeepAwakeMode)}
        >
          {KEEP_AWAKE_MODE_OPTIONS.map((option) => (
            <MenuRadioItem
              key={option.value}
              value={option.value}
              className={cn(SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME, "min-h-7 py-1 text-ui-xs")}
            >
              <span className="flex min-w-0 flex-col">
                <span>{option.label}</span>
                <span className="text-ui-xs text-muted-foreground">{option.description}</span>
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </ComposerPickerMenuPopup>
    </Menu>
  );
}

const KEEP_AWAKE_SEGMENTED_OPTIONS = KEEP_AWAKE_MODE_OPTIONS.map((option) => ({
  value: option.value,
  label: option.label,
}));
const KEEP_AWAKE_ROW_DESCRIPTION = `Uses macOS caffeinate. ${KEEP_AWAKE_MODE_OPTIONS.map(
  (option) => `${option.label}: ${option.description}`,
).join(" ")}`;

export function KeepAwakeSettingsSection({
  state,
  mode,
  defaultMode,
  onSelectMode,
}: {
  state: ServerKeepAwakeState | null;
  mode: KeepAwakeMode;
  defaultMode: KeepAwakeMode;
  onSelectMode: (mode: KeepAwakeMode) => void;
}) {
  if (!state?.available) return null;
  return (
    <SettingsSection title="System">
      <SettingsRow
        title={KEEP_AWAKE_ROW_TITLE}
        description={KEEP_AWAKE_ROW_DESCRIPTION}
        status={keepAwakeStatusLabel(state)}
        resetAction={
          mode !== defaultMode ? (
            <SettingResetButton
              label="keep computer awake"
              onClick={() => onSelectMode(defaultMode)}
            />
          ) : null
        }
        control={
          <SettingsSegmentedControl
            value={mode}
            onValueChange={onSelectMode}
            ariaLabel={KEEP_AWAKE_ROW_TITLE}
            options={KEEP_AWAKE_SEGMENTED_OPTIONS}
          />
        }
      />
    </SettingsSection>
  );
}
