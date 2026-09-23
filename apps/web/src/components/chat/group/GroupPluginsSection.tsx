import { PluginLibrary } from "~/components/PluginLibrary";
import { SettingsSectionShell } from "~/components/settings/SettingsPanelPrimitives";

export function GroupPluginsSection(props: { readonly workspacePath: string }) {
  return (
    <SettingsSectionShell title="Plugins">
      <p className="mb-3 text-ui-sm text-muted-foreground">
        Plugins are discovered from this group&apos;s folder.
      </p>
      <PluginLibrary embedded cwd={props.workspacePath} />
    </SettingsSectionShell>
  );
}
