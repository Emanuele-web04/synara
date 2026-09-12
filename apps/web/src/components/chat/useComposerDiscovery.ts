import {
  type ProjectEntry,
  type ProviderKind,
  type ProviderMentionReference,
  type ProviderNativeCommandDescriptor,
  type ProviderPluginDescriptor,
  type ProviderSkillDescriptor,
  type ProviderStartOptions,
  ThreadId,
} from "@synara/contracts";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { isLocalFolderMentionQuery } from "~/lib/localFolderMentions";
import { projectSearchEntriesQueryOptions } from "~/lib/projectReactQuery";
import {
  providerCommandsQueryOptions,
  providerComposerCapabilitiesQueryOptions,
  providerPluginsQueryOptions,
  providerSkillsQueryOptions,
  supportsNativeSlashCommandDiscovery,
  supportsPluginDiscovery,
  supportsSkillDiscovery,
  supportsThreadCompaction,
} from "~/lib/providerDiscoveryReactQuery";
import { type ComposerTrigger } from "../../composer-logic";
import {
  hasProviderNativeSlashCommand,
  providerSupportsTextNativeReviewCommand,
} from "../../composerSlashCommands";

const EMPTY_PROJECT_ENTRIES: ProjectEntry[] = [];
const EMPTY_PROVIDER_NATIVE_COMMANDS: ProviderNativeCommandDescriptor[] = [];
const EMPTY_PROVIDER_SKILLS: ProviderSkillDescriptor[] = [];
type ComposerPluginSuggestion = {
  plugin: ProviderPluginDescriptor;
  mention: ProviderMentionReference;
};

const EMPTY_COMPOSER_PLUGIN_SUGGESTIONS: ComposerPluginSuggestion[] = [];
const COMPOSER_PATH_QUERY_DEBOUNCE_MS = 120;
interface ComposerDiscoveryInput {
  threadId: ThreadId;
  selectedProvider: ProviderKind;
  composerTrigger: ComposerTrigger | null;
  composerCommandPicker: "fork-target" | "review-target" | null;
  providerModelDiscoveryCwd: string | null;
  providerOptionsForDispatch: ProviderStartOptions | undefined;
  gitCwd: string | null;
  piAgentDir: string;
}

export function useComposerDiscovery({
  threadId,
  selectedProvider,
  composerTrigger,
  composerCommandPicker,
  providerModelDiscoveryCwd,
  providerOptionsForDispatch,
  gitCwd,
  piAgentDir,
}: ComposerDiscoveryInput) {
  const composerTriggerKind = composerTrigger?.kind ?? null;
  const mentionTriggerQuery = composerTrigger?.kind === "mention" ? composerTrigger.query : "";
  const isMentionTrigger = composerTriggerKind === "mention";

  const isLocalFolderBrowserOpen =
    composerCommandPicker === null &&
    isMentionTrigger &&
    isLocalFolderMentionQuery(mentionTriggerQuery);
  const isSkillTrigger = composerTriggerKind === "skill";
  const [debouncedPathQuery, composerPathQueryDebouncer] = useDebouncedValue(
    mentionTriggerQuery,
    { wait: COMPOSER_PATH_QUERY_DEBOUNCE_MS },
    (debouncerState) => ({ isPending: debouncerState.isPending }),
  );
  const effectiveMentionQuery = mentionTriggerQuery.length > 0 ? debouncedPathQuery : "";
  const composerSkillCwd = providerModelDiscoveryCwd;
  const providerComposerCapabilitiesQuery = useQuery(
    providerComposerCapabilitiesQueryOptions(selectedProvider),
  );
  const providerCommandsQuery = useQuery(
    providerCommandsQueryOptions({
      provider: selectedProvider,
      cwd: composerSkillCwd,
      threadId,
      binaryPath:
        (selectedProvider === "opencode"
          ? providerOptionsForDispatch?.opencode?.binaryPath
          : selectedProvider === "devin"
            ? providerOptionsForDispatch?.devin?.binaryPath
            : null) ?? null,
      serverUrl:
        (selectedProvider === "opencode"
          ? providerOptionsForDispatch?.opencode?.serverUrl
          : null) ?? null,
      experimentalWebSockets:
        selectedProvider === "opencode"
          ? providerOptionsForDispatch?.opencode?.experimentalWebSockets
          : undefined,
      agentDir: selectedProvider === "pi" ? piAgentDir || null : null,
      enabled:
        (composerTriggerKind === "slash-command" || composerTriggerKind === "slash-model") &&
        supportsNativeSlashCommandDiscovery(providerComposerCapabilitiesQuery.data) &&
        composerSkillCwd !== null,
    }),
  );
  const canDiscoverProviderSkills =
    selectedProvider === "pi" || supportsSkillDiscovery(providerComposerCapabilitiesQuery.data);
  const providerSkillsQuery = useQuery(
    providerSkillsQueryOptions({
      provider: selectedProvider,
      cwd: composerSkillCwd,
      threadId,
      agentDir: selectedProvider === "pi" ? piAgentDir || null : null,
      enabled:
        (isSkillTrigger || composerTriggerKind === "slash-command" || selectedProvider === "pi") &&
        canDiscoverProviderSkills &&
        composerSkillCwd !== null,
    }),
  );
  const providerPluginsQuery = useQuery(
    providerPluginsQueryOptions({
      provider: selectedProvider,
      cwd: composerSkillCwd,
      threadId,
      enabled:
        supportsPluginDiscovery(providerComposerCapabilitiesQuery.data) &&
        composerSkillCwd !== null,
    }),
  );
  const workspaceEntriesQuery = useQuery(
    projectSearchEntriesQueryOptions({
      cwd: gitCwd,
      query: effectiveMentionQuery,
      enabled: isMentionTrigger && !isLocalFolderBrowserOpen,
      limit: 80,
    }),
  );
  const workspaceEntries = workspaceEntriesQuery.data?.entries ?? EMPTY_PROJECT_ENTRIES;

  // Keep plugin suggestions referentially stable so prompt-sync effects do not loop on rerender.
  const providerPlugins = useMemo(
    () =>
      providerPluginsQuery.data?.marketplaces.flatMap((marketplace) =>
        marketplace.plugins.map((plugin) => ({
          plugin,
          mention: {
            name: plugin.name,
            path: `plugin://${plugin.name}@${marketplace.name}`,
          } satisfies ProviderMentionReference,
        })),
      ) ?? EMPTY_COMPOSER_PLUGIN_SUGGESTIONS,
    [providerPluginsQuery.data],
  );
  const providerNativeCommands =
    providerCommandsQuery.data?.commands ?? EMPTY_PROVIDER_NATIVE_COMMANDS;
  const providerNativeCommandNames = useMemo(
    () => providerNativeCommands.map((command) => command.name),
    [providerNativeCommands],
  );
  const effectiveComposerTrigger = useMemo(() => {
    if (
      composerTrigger?.kind === "slash-model" &&
      hasProviderNativeSlashCommand(selectedProvider, providerNativeCommandNames, "model")
    ) {
      return {
        ...composerTrigger,
        kind: "slash-command" as const,
        query: "model",
      };
    }
    return composerTrigger;
  }, [composerTrigger, providerNativeCommandNames, selectedProvider]);
  const effectiveComposerTriggerKind = effectiveComposerTrigger?.kind ?? null;
  const supportsTextNativeReviewCommand = useMemo(
    () => providerSupportsTextNativeReviewCommand(selectedProvider, providerNativeCommands),
    [providerNativeCommands, selectedProvider],
  );
  const providerSkills = providerSkillsQuery.data?.skills ?? EMPTY_PROVIDER_SKILLS;

  const isComposerMenuLoading =
    (composerTriggerKind === "mention" &&
      ((mentionTriggerQuery.length > 0 && composerPathQueryDebouncer.state.isPending) ||
        workspaceEntriesQuery.isLoading ||
        workspaceEntriesQuery.isFetching ||
        providerPluginsQuery.isLoading ||
        providerPluginsQuery.isFetching)) ||
    (composerTriggerKind === "slash-command" &&
      (providerCommandsQuery.isLoading ||
        providerCommandsQuery.isFetching ||
        providerSkillsQuery.isLoading ||
        providerSkillsQuery.isFetching)) ||
    (composerTriggerKind === "skill" &&
      (providerComposerCapabilitiesQuery.isLoading ||
        providerComposerCapabilitiesQuery.isFetching ||
        providerSkillsQuery.isLoading ||
        providerSkillsQuery.isFetching));
  return {
    mentionTriggerQuery,
    isLocalFolderBrowserOpen,
    providerPlugins,
    providerNativeCommands,
    providerSkills,
    workspaceEntries,
    effectiveComposerTrigger,
    effectiveComposerTriggerKind,
    supportsTextNativeReviewCommand,
    isComposerMenuLoading,
    canCompactThread: supportsThreadCompaction(providerComposerCapabilitiesQuery.data),
  };
}
