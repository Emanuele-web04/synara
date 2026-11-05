// FILE: keepAwake.ts
// Purpose: Keep-awake (caffeinate) copy for the Settings "System" section.
// Layer: Web lib (pure)
// Exports: Localized mode options and status label helpers.

import { t } from "~/i18n";
import type { KeepAwakeMode, ServerKeepAwakeState } from "@synara/contracts";

export interface KeepAwakeModeOption {
  readonly value: KeepAwakeMode;
  readonly label: string;
  readonly description: string;
}

export function localizedKeepAwakeModeOptions(
  translate: typeof t = t,
): readonly KeepAwakeModeOption[] {
  return [
    {
      value: "always",
      label: translate("settings:keepAwakeOn"),
      description: translate("settings:keepAwakeAlwaysDescription"),
    },
    {
      value: "agent",
      label: translate("settings:keepAwakeAgent"),
      description: translate("settings:keepAwakeAgentDescription"),
    },
    {
      value: "off",
      label: translate("settings:keepAwakeOff"),
      description: translate("settings:keepAwakeOffDescription"),
    },
  ];
}

export function keepAwakeModeLabel(mode: KeepAwakeMode, translate: typeof t = t): string {
  return (
    localizedKeepAwakeModeOptions(translate).find((option) => option.value === mode)?.label ?? mode
  );
}

export function keepAwakeActivityLabel(active: boolean, translate: typeof t = t): string {
  return translate(active ? "automation:detail_active" : "chat:idle");
}

export function keepAwakeStatusLabel(
  state: Pick<ServerKeepAwakeState, "mode" | "active">,
  translate: typeof t = t,
): string {
  return `${keepAwakeModeLabel(state.mode, translate)} · ${keepAwakeActivityLabel(state.active, translate)}`;
}
