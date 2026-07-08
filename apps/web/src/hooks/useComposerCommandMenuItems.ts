import type {
  ProjectEntry,
  ProviderNativeCommandDescriptor,
  ProviderKind,
  ProviderMentionReference,
  ProviderPluginDescriptor,
  ProviderSkillDescriptor,
} from "@synara/contracts";
import { getAgentMentionAutocompleteAliases } from "@synara/contracts";
import { useMemo } from "react";
import {
  buildCommandSearchFields,
  buildPluginSearchFields,
  buildSkillSearchFields,
  isInstalledProviderPlugin,
  normalizeProviderDiscoveryText,
  rankProviderDiscoveryItems,
} from "~/lib/providerDiscovery";
import {
  LOCAL_FOLDER_MENTION_NAME,
  matchesLocalFolderMentionShortcut,
} from "~/lib/localFolderMentions";
import { basenameOfPath } from "../file-icons";
import type { ComposerTrigger } from "../composer-logic";
import {
  filterComposerSlashCommands,
  getAvailableComposerSlashCommands,
  getProviderNativeSlashCommandSearchTerms,
  shouldHideProviderNativeCommandFromComposerMenu,
} from "../composerSlashCommands";
import type { ComposerCommandItem } from "../components/chat/ComposerCommandMenu";

type ComposerPluginSuggestion = {
  plugin: ProviderPluginDescriptor;
  mention: ProviderMentionReference;
};

type SearchableModelOption = {
  provider: ProviderKind;
  providerLabel: string;
  slug: string;
  name: string;
  searchSlug: string;
  searchName: string;
  searchProvider: string;
  searchUpstreamProvider: string;
};

export function useComposerCommandMenuItems(input: {
  composerTrigger: ComposerTrigger | null;
  provider: ProviderKind;
  providerPlugins: readonly ComposerPluginSuggestion[];
  providerNativeCommands: readonly ProviderNativeCommandDescriptor[];
  providerSkills: readonly ProviderSkillDescriptor[];
  workspaceEntries: readonly ProjectEntry[];
  searchableModelOptions: readonly SearchableModelOption[];
  supportsFastSlashCommand: boolean;
  canOfferCompactCommand: boolean;
  canOfferReviewCommand: boolean;
  canOfferForkCommand: boolean;
  canOfferSideCommand: boolean;
  canOfferExportCommand: boolean;
  surfaceAppSlashCommands?: ReadonlySet<string>;
  dynamicAgents: readonly { name: string; displayName: string; description?: string }[];
}): ComposerCommandItem[] {
  const {
    composerTrigger,
    provider,
    providerPlugins,
    providerNativeCommands,
    providerSkills,
    workspaceEntries,
    searchableModelOptions,
    supportsFastSlashCommand,
    canOfferCompactCommand,
    canOfferReviewCommand,
    canOfferForkCommand,
    canOfferSideCommand,
    canOfferExportCommand,
    surfaceAppSlashCommands,
    dynamicAgents,
  } = input;

  return useMemo<ComposerCommandItem[]>(() => {
    if (!composerTrigger) return [];

    // Keep trigger-specific discovery outside ChatView so the view mostly orchestrates state.
    if (composerTrigger.kind === "mention") {
      const query = normalizeProviderDiscoveryText(composerTrigger.query);

      const agentItems: ComposerCommandItem[] = (() => {
        // Use dynamic agents when available, fallback to static
        if (dynamicAgents.length > 0) {
          return rankProviderDiscoveryItems(dynamicAgents, query, ({ name, displayName }) => [
            { value: name },
            { value: displayName },
          ]).map(({ name, displayName }) => ({
            id: `agent:${provider}:${name}`,
            type: "agent" as const,
            provider,
            alias: name,
            color: "violet" as const,
            label: `@${name}`,
            description: displayName,
          }));
        }
        // Static fallback
        return rankProviderDiscoveryItems(
          getAgentMentionAutocompleteAliases(provider),
          query,
          ({ alias, displayName }) => [{ value: alias }, { value: displayName }],
        ).map(({ alias, displayName, color }) => ({
          id: `agent:${provider}:${alias}`,
          type: "agent" as const,
          provider,
          alias,
          color,
          label: `@${alias}`,
          description: displayName,
        }));
      })();

      const pluginItems = rankProviderDiscoveryItems(
        providerPlugins.filter(({ plugin }) => isInstalledProviderPlugin(plugin)),
        query,
        ({ plugin }) => buildPluginSearchFields(plugin),
      ).map(({ plugin, mention }) => ({
        id: `plugin:${plugin.id}`,
        type: "plugin" as const,
        plugin,
        mention,
        label: plugin.interface?.displayName ?? plugin.name,
        description: plugin.interface?.shortDescription ?? plugin.source.path,
      }));
      const localRootItems =
        matchesLocalFolderMentionShortcut(composerTrigger.query) && composerTrigger.query !== "/"
          ? [
              {
                id: "local-root",
                type: "local-root" as const,
                label: `@${LOCAL_FOLDER_MENTION_NAME}`,
                description: "Browse folders on this computer",
              },
            ]
          : [];
      const pathItems = workspaceEntries.map((entry) => ({
        id: `path:${entry.kind}:${entry.path}`,
        type: "path" as const,
        path: entry.path,
        pathKind: entry.kind,
        label: basenameOfPath(entry.path),
        description: entry.parentPath ?? "",
      }));
      // Keep mention suggestions ordered by primary intent: plugins first,
      // then local context, then subagent delegation targets.
      return [...pluginItems, ...localRootItems, ...pathItems, ...agentItems];
    }

    if (composerTrigger.kind === "slash-command") {
      const query = normalizeProviderDiscoveryText(composerTrigger.query);
      const availableCommands = getAvailableComposerSlashCommands({
        provider,
        supportsFastSlashCommand,
        canOfferCompactCommand,
        canOfferReviewCommand,
        canOfferForkCommand,
        canOfferSideCommand,
        canOfferExportCommand,
        providerNativeCommandNames: providerNativeCommands.map((command) => command.name),
      });
      const visibleAppCommands = surfaceAppSlashCommands
        ? availableCommands.filter((command) => surfaceAppSlashCommands.has(command))
        : availableCommands;
      const visibleAppCommandSet = new Set(visibleAppCommands);
      const builtInItems = filterComposerSlashCommands(
        composerTrigger.query,
        visibleAppCommands,
      ).map((definition) => ({
        id: `slash:${definition.command}`,
        type: "slash-command" as const,
        command: definition.command,
        label: definition.label,
        description: definition.description,
        source: definition.source,
      }));
      const providerCommandItems = providerNativeCommands
        .filter(
          (command) =>
            !shouldHideProviderNativeCommandFromComposerMenu(provider, command.name, {
              availableAppCommands: visibleAppCommandSet,
            }),
        )
        .map((command) => ({
          command,
          aliasFields: getProviderNativeSlashCommandSearchTerms(provider, command.name).map(
            (term) => ({
              value: term,
            }),
          ),
        }));
      const rankedProviderCommandItems = rankProviderDiscoveryItems(
        providerCommandItems,
        query,
        ({ command, aliasFields }) => [...aliasFields, ...buildCommandSearchFields(command)],
      ).map(({ command }) => ({
        id: `provider-command:${provider}:${command.name}`,
        type: "provider-native-command" as const,
        provider,
        command: command.name,
        label: `/${command.name}`,
        description: command.description ?? `Run ${provider} native command`,
      }));
      // `/` is the universal picker surface; provider dispatch can adapt the
      // visible slash token to backend-specific skill syntax when needed.
      const skillItems: ComposerCommandItem[] = rankProviderDiscoveryItems(
        providerSkills,
        query,
        buildSkillSearchFields,
      ).map((skill) => ({
        id: `skill:${skill.path}`,
        type: "skill" as const,
        skill,
        label: skill.interface?.displayName ?? skill.name,
        description: skill.interface?.shortDescription ?? skill.description ?? skill.path,
      }));
      return [...builtInItems, ...rankedProviderCommandItems, ...skillItems];
    }

    if (composerTrigger.kind === "skill") {
      const query = normalizeProviderDiscoveryText(composerTrigger.query);
      return rankProviderDiscoveryItems(providerSkills, query, buildSkillSearchFields).map(
        (skill) => ({
          id: `skill:${skill.path}`,
          type: "skill" as const,
          skill,
          label: skill.interface?.displayName ?? skill.name,
          description: skill.interface?.shortDescription ?? skill.description ?? skill.path,
        }),
      );
    }

    return rankProviderDiscoveryItems(searchableModelOptions, composerTrigger.query, (option) => [
      { value: option.name },
      { value: option.slug },
      { value: option.searchName },
      { value: option.searchSlug },
      { value: option.providerLabel, weight: 200 },
      { value: option.searchProvider, weight: 200 },
      { value: option.searchUpstreamProvider, weight: 200 },
    ]).map(({ provider, providerLabel, slug, name }) => ({
      id: `model:${provider}:${slug}`,
      type: "model" as const,
      provider,
      model: slug,
      label: name,
      description: `${providerLabel} · ${slug}`,
    }));
  }, [
    canOfferForkCommand,
    canOfferCompactCommand,
    canOfferReviewCommand,
    canOfferSideCommand,
    canOfferExportCommand,
    composerTrigger,
    dynamicAgents,
    provider,
    providerPlugins,
    providerNativeCommands,
    providerSkills,
    searchableModelOptions,
    surfaceAppSlashCommands,
    supportsFastSlashCommand,
    workspaceEntries,
  ]);
}
