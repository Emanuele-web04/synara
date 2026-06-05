import type {
  ProjectEntry,
  ProviderNativeCommandDescriptor,
  ProviderKind,
  ProviderMentionReference,
  ProviderPluginDescriptor,
  ProviderSkillDescriptor,
} from "@t3tools/contracts";
import { getAgentMentionAutocompleteAliases } from "@t3tools/contracts";
import { useMemo } from "react";
import {
  buildCommandSearchBlob,
  buildPluginSearchBlob,
  buildSkillSearchBlob,
  isInstalledProviderPlugin,
  normalizeProviderDiscoveryText,
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
    dynamicAgents,
  } = input;

  // Precompute each item's lowercased search blob once per source list — keyed on
  // the list, not the query — so every keystroke does a cheap substring test
  // instead of rebuilding and re-normalizing every blob. Mirrors how
  // searchableModelOptions is prebuilt upstream.
  const searchableSkills = useMemo(
    () => providerSkills.map((skill) => ({ skill, blob: buildSkillSearchBlob(skill) })),
    [providerSkills],
  );

  const searchablePlugins = useMemo(
    () =>
      providerPlugins
        .filter(({ plugin }) => isInstalledProviderPlugin(plugin))
        .map(({ plugin, mention }) => ({ plugin, mention, blob: buildPluginSearchBlob(plugin) })),
    [providerPlugins],
  );

  const searchableNativeCommands = useMemo(
    () =>
      providerNativeCommands
        .filter(
          (command) => !shouldHideProviderNativeCommandFromComposerMenu(provider, command.name),
        )
        .map((command) => ({
          command,
          blob: buildCommandSearchBlob(command),
          terms: getProviderNativeSlashCommandSearchTerms(provider, command.name),
        })),
    [provider, providerNativeCommands],
  );

  const searchableAgents = useMemo(() => {
    // Dynamic agents when available, static aliases otherwise. The blob matches
    // the original (raw lowercase, no discovery normalization) so behavior is
    // unchanged — only the per-keystroke rebuild is removed.
    if (dynamicAgents.length > 0) {
      return dynamicAgents.map(({ name, displayName }) => ({
        id: `agent:${provider}:${name}`,
        alias: name,
        color: "violet" as const,
        label: `@${name}`,
        description: displayName,
        blob: `${name} ${displayName}`.toLowerCase(),
      }));
    }
    return getAgentMentionAutocompleteAliases(provider).map(({ alias, displayName, color }) => ({
      id: `agent:${provider}:${alias}`,
      alias,
      color,
      label: `@${alias}`,
      description: displayName,
      blob: `${alias} ${displayName}`.toLowerCase(),
    }));
  }, [dynamicAgents, provider]);

  const availableSlashCommands = useMemo(
    () =>
      getAvailableComposerSlashCommands({
        provider,
        supportsFastSlashCommand,
        canOfferCompactCommand,
        canOfferReviewCommand,
        canOfferForkCommand,
        canOfferSideCommand,
        providerNativeCommandNames: providerNativeCommands.map((command) => command.name),
      }),
    [
      canOfferCompactCommand,
      canOfferForkCommand,
      canOfferReviewCommand,
      canOfferSideCommand,
      provider,
      providerNativeCommands,
      supportsFastSlashCommand,
    ],
  );

  return useMemo<ComposerCommandItem[]>(() => {
    if (!composerTrigger) return [];

    // Keep trigger-specific discovery outside ChatView so the view mostly orchestrates state.
    if (composerTrigger.kind === "mention") {
      const query = normalizeProviderDiscoveryText(composerTrigger.query);

      const agentItems: ComposerCommandItem[] = searchableAgents
        .filter(({ blob }) => !query || blob.includes(query))
        .map(({ id, alias, color, label, description }) => ({
          id,
          type: "agent" as const,
          provider,
          alias,
          color,
          label,
          description,
        }));

      const pluginItems = searchablePlugins
        .filter(({ blob }) => !query || blob.includes(query))
        .map(({ plugin, mention }) => ({
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
      const builtInItems = filterComposerSlashCommands(
        composerTrigger.query,
        availableSlashCommands,
      ).map((definition) => ({
        id: `slash:${definition.command}`,
        type: "slash-command" as const,
        command: definition.command,
        label: definition.label,
        description: definition.description,
        source: definition.source,
      }));
      const providerCommandItems = searchableNativeCommands
        .filter(({ blob, terms }) => {
          if (!query) return true;
          return blob.includes(query) || terms.some((term) => term.includes(query));
        })
        .map(({ command }) => ({
          id: `provider-command:${provider}:${command.name}`,
          type: "provider-native-command" as const,
          provider,
          command: command.name,
          label: `/${command.name}`,
          description: command.description ?? `Run ${provider} native command`,
        }));
      // `/` is the universal picker surface; provider dispatch can adapt the
      // visible slash token to backend-specific skill syntax when needed.
      const skillItems: ComposerCommandItem[] = searchableSkills
        .filter(({ blob }) => !query || blob.includes(query))
        .map(({ skill }) => ({
          id: `skill:${skill.path}`,
          type: "skill" as const,
          skill,
          label: skill.interface?.displayName ?? skill.name,
          description: skill.interface?.shortDescription ?? skill.description ?? skill.path,
        }));
      return [...builtInItems, ...providerCommandItems, ...skillItems];
    }

    if (composerTrigger.kind === "skill") {
      const query = normalizeProviderDiscoveryText(composerTrigger.query);
      return searchableSkills
        .filter(({ blob }) => !query || blob.includes(query))
        .map(({ skill }) => ({
          id: `skill:${skill.path}`,
          type: "skill" as const,
          skill,
          label: skill.interface?.displayName ?? skill.name,
          description: skill.interface?.shortDescription ?? skill.description ?? skill.path,
        }));
    }

    return searchableModelOptions
      .filter(({ searchSlug, searchName, searchProvider, searchUpstreamProvider }) => {
        const query = composerTrigger.query.trim().toLowerCase();
        if (!query) return true;
        return (
          searchSlug.includes(query) ||
          searchName.includes(query) ||
          searchProvider.includes(query) ||
          searchUpstreamProvider.includes(query)
        );
      })
      .map(({ provider, providerLabel, slug, name }) => ({
        id: `model:${provider}:${slug}`,
        type: "model" as const,
        provider,
        model: slug,
        label: name,
        description: `${providerLabel} · ${slug}`,
      }));
  }, [
    availableSlashCommands,
    composerTrigger,
    provider,
    searchableAgents,
    searchableModelOptions,
    searchableNativeCommands,
    searchablePlugins,
    searchableSkills,
    workspaceEntries,
  ]);
}
