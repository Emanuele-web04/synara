import { PluginLibrary } from "~/components/PluginLibrary";
import { SettingsSectionShell } from "~/components/settings/SettingsPanelPrimitives";
import { useTranslation } from "~/i18n";

export function GroupPluginsSection(props: { readonly workspacePath: string }) {
  const { t } = useTranslation();

  return (
    <SettingsSectionShell title="common:plugin_pluginsTab">
      <p className="mb-3 text-ui-sm text-muted-foreground">
        {t("workspace:pluginsAreDiscoveredFromThisHubSFolder")}
      </p>
      <PluginLibrary embedded cwd={props.workspacePath} />
    </SettingsSectionShell>
  );
}
