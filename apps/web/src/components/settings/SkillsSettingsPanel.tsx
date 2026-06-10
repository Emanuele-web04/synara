// FILE: SkillsSettingsPanel.tsx
// Purpose: Settings → Skills panel. Lists every skill from the unified cross-provider
// catalog (~/.synara/skills plus each provider's skills folder), shows which provider
// a skill comes from, and lets the user enable/disable each one. Disabled skills are
// hidden from the composer skill picker on every provider.

import type { ProviderKind, ProviderSkillDescriptor, ServerSettings } from "@t3tools/contracts";
import { PROVIDER_DISPLAY_NAMES } from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { ProviderIcon } from "~/components/ProviderIcon";
import { SettingsRow, SettingsSection } from "~/components/settings/SettingsPanelPrimitives";
import { Switch } from "~/components/ui/switch";
import { ensureNativeApi } from "~/nativeApi";
import {
  providerDiscoveryQueryKeys,
  skillsCatalogQueryOptions,
} from "~/lib/providerDiscoveryReactQuery";
import { serverQueryKeys, serverSettingsQueryOptions } from "~/lib/serverReactQuery";

interface SkillOriginInfo {
  readonly label: string;
  readonly provider: ProviderKind | null;
}

function skillOriginInfo(scope: string | undefined): SkillOriginInfo {
  switch (scope) {
    case "synara":
      return { label: "Synara", provider: null };
    case "codex":
      return { label: PROVIDER_DISPLAY_NAMES.codex, provider: "codex" };
    case "claude":
      return { label: PROVIDER_DISPLAY_NAMES.claudeAgent, provider: "claudeAgent" };
    case "cursor":
      return { label: PROVIDER_DISPLAY_NAMES.cursor, provider: "cursor" };
    case "agents":
      return { label: "Shared (.agents)", provider: null };
    case "project":
      return { label: "Project", provider: null };
    default:
      return { label: scope ?? "Personal", provider: null };
  }
}

const ORIGIN_SECTION_ORDER = ["synara", "codex", "claude", "cursor", "agents", "project"] as const;

function skillNameKey(name: string): string {
  return name.trim().toLowerCase();
}

function skillDisplayName(skill: ProviderSkillDescriptor): string {
  return skill.interface?.displayName ?? skill.name;
}

export function SkillsSettingsPanel() {
  const queryClient = useQueryClient();
  const catalogQuery = useQuery(skillsCatalogQueryOptions());
  const serverSettingsQuery = useQuery(serverSettingsQueryOptions());

  const disabledSkillNames = useMemo(
    () =>
      new Set((serverSettingsQuery.data?.skills.disabled ?? []).map((name) => skillNameKey(name))),
    [serverSettingsQuery.data?.skills.disabled],
  );

  const skillsByOrigin = useMemo(() => {
    const groups = new Map<string, ProviderSkillDescriptor[]>();
    for (const skill of catalogQuery.data?.skills ?? []) {
      const origin = skill.scope ?? "personal";
      const group = groups.get(origin) ?? [];
      group.push(skill);
      groups.set(origin, group);
    }
    for (const group of groups.values()) {
      group.sort((left, right) => skillDisplayName(left).localeCompare(skillDisplayName(right)));
    }
    const orderedOrigins = [
      ...ORIGIN_SECTION_ORDER.filter((origin) => groups.has(origin)),
      ...[...groups.keys()].filter(
        (origin) => !(ORIGIN_SECTION_ORDER as readonly string[]).includes(origin),
      ),
    ];
    return orderedOrigins.map((origin) => ({
      origin,
      skills: groups.get(origin) ?? [],
    }));
  }, [catalogQuery.data?.skills]);

  const setSkillEnabled = (skillName: string, enabled: boolean) => {
    // Read through the query cache (not the render closure) so rapid toggles
    // build on each other instead of clobbering the previous patch.
    const latestSettings = queryClient.getQueryData<ServerSettings>(serverQueryKeys.settings());
    const currentDisabled = latestSettings?.skills.disabled ?? [...disabledSkillNames];
    const key = skillNameKey(skillName);
    const next = new Set(currentDisabled.map((name) => skillNameKey(name)));
    if (enabled) {
      next.delete(key);
    } else {
      next.add(key);
    }
    const disabled = [...next].sort();
    if (latestSettings) {
      // Optimistic flip; a failed patch invalidates back to the server state.
      queryClient.setQueryData(serverQueryKeys.settings(), {
        ...latestSettings,
        skills: { disabled },
      });
    }
    void ensureNativeApi()
      .server.updateSettings({ skills: { disabled } })
      .then((nextSettings) => {
        queryClient.setQueryData(serverQueryKeys.settings(), nextSettings);
        // Composer skill pickers are served filtered by these toggles.
        void queryClient.invalidateQueries({ queryKey: providerDiscoveryQueryKeys.all });
      })
      .catch(() => {
        void queryClient.invalidateQueries({ queryKey: serverQueryKeys.settings() });
      });
  };

  const totalSkills = catalogQuery.data?.skills.length ?? 0;
  const enabledSkills = (catalogQuery.data?.skills ?? []).filter(
    (skill) => !disabledSkillNames.has(skillNameKey(skill.name)),
  ).length;
  const synaraSkillsDir = catalogQuery.data?.synaraSkillsDir;

  return (
    <div className="space-y-8">
      <SettingsSection title="Portable skills">
        <SettingsRow
          title="Synara skills folder"
          description="Skills placed here are available on every provider. When a provider already ships its own copy of a skill, that copy is used; otherwise Synara's copy is the fallback."
          status={
            synaraSkillsDir ? (
              <code className="break-all text-[11px] text-muted-foreground">{synaraSkillsDir}</code>
            ) : null
          }
          control={
            <span className="text-xs font-medium text-muted-foreground">
              {catalogQuery.isLoading
                ? "Scanning…"
                : `${enabledSkills} of ${totalSkills} skill${totalSkills === 1 ? "" : "s"} enabled`}
            </span>
          }
        />
      </SettingsSection>

      {catalogQuery.isError ? (
        <SettingsSection title="Skills">
          <SettingsRow
            title="Skill discovery failed"
            description="Synara could not scan the skill folders. Retry after checking that the server is running."
          />
        </SettingsSection>
      ) : null}

      {!catalogQuery.isLoading && !catalogQuery.isError && totalSkills === 0 ? (
        <SettingsSection title="Skills">
          <SettingsRow
            title="No skills found"
            description="Add a skill folder containing a SKILL.md to the Synara skills folder above, or install skills for Codex, Claude, or Cursor."
          />
        </SettingsSection>
      ) : null}

      {skillsByOrigin.map(({ origin, skills }) => {
        const originInfo = skillOriginInfo(origin);
        return (
          <SettingsSection key={origin} title={`From ${originInfo.label}`}>
            {skills.map((skill) => {
              const enabled = !disabledSkillNames.has(skillNameKey(skill.name));
              return (
                <SettingsRow
                  key={skill.path}
                  title={skillDisplayName(skill)}
                  description={
                    skill.interface?.shortDescription ?? skill.description ?? "No description."
                  }
                  status={
                    <span className="flex min-w-0 items-center gap-1.5">
                      <ProviderIcon
                        provider={originInfo.provider}
                        className="size-3 shrink-0"
                        fallback={null}
                      />
                      <code className="truncate text-[11px] text-muted-foreground">
                        {skill.path}
                      </code>
                    </span>
                  }
                  control={
                    <Switch
                      checked={enabled}
                      onCheckedChange={(checked) => setSkillEnabled(skill.name, Boolean(checked))}
                      aria-label={`Enable the ${skillDisplayName(skill)} skill`}
                    />
                  }
                />
              );
            })}
          </SettingsSection>
        );
      })}
    </div>
  );
}
