import type { ThreadTitleRefreshMode } from "@synara/contracts";
import { SettingsSegmentedControl } from "./settings/SettingControls";

const MODE_OPTIONS = [
  { value: "inherit", label: "Inherit" },
  { value: "off", label: "Off" },
  { value: "suggested", label: "Suggested" },
  { value: "automatic", label: "Automatic" },
] as const;

export function TitleRefreshModePicker({
  value,
  onChange,
}: {
  value: ThreadTitleRefreshMode | null;
  onChange: (mode: ThreadTitleRefreshMode | null) => void;
}) {
  return (
    <div>
      <p className="mb-1.5 text-ui-xs font-medium text-muted-foreground">Automatic titles</p>
      <SettingsSegmentedControl
        value={value ?? "inherit"}
        options={MODE_OPTIONS}
        ariaLabel="Automatic titles"
        onValueChange={(mode) => onChange(mode === "inherit" ? null : mode)}
      />
    </div>
  );
}
