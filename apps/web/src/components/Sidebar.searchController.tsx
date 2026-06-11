// FILE: Sidebar.searchController.tsx
// Purpose: Bridges store-derived thread data into the sidebar search palette.
// Layer: Sidebar UI (reads app store + provider capability queries).
// Exports: SidebarSearchPaletteController

import { useMemo } from "react";
import type { ProjectId } from "@t3tools/contracts";
import { useQueries } from "@tanstack/react-query";
import { useStore } from "../store";
import { createAllThreadsSelector, createSidebarDisplayThreadsSelector } from "../storeSelectors";
import {
  providerComposerCapabilitiesQueryOptions,
  supportsThreadImport,
} from "../lib/providerDiscoveryReactQuery";
import {
  SidebarSearchPalette,
  type ImportProviderKind,
  type SidebarSearchPaletteMode,
} from "./SidebarSearchPalette";
import type {
  SidebarSearchAction,
  SidebarSearchProject,
  SidebarSearchThread,
} from "./SidebarSearchPalette.logic";

export function SidebarSearchPaletteController(props: {
  open: boolean;
  mode: SidebarSearchPaletteMode;
  onModeChange: (mode: SidebarSearchPaletteMode) => void;
  onOpenChange: (open: boolean) => void;
  actions: readonly SidebarSearchAction[];
  projects: readonly SidebarSearchProject[];
  projectById: ReadonlyMap<ProjectId, { name: string; remoteName: string }>;
  onCreateChat: () => void;
  onCreateThread: () => void;
  onAddProjectPath: (path: string, options?: { createIfMissing?: boolean }) => Promise<void>;
  homeDir: string | null;
  initialBrowseQuery: string | null;
  onOpenSettings: () => void;
  onOpenProject: (projectId: string) => void;
  onOpenPullRequestReference: (reference: string) => void;
  onImportThread: (provider: ImportProviderKind, externalId: string) => Promise<void>;
  onOpenThread: (threadId: string) => void;
}) {
  const selectAllThreads = useMemo(() => createAllThreadsSelector(), []);
  const selectSidebarDisplayThreads = useMemo(() => createSidebarDisplayThreadsSelector(), []);
  const importProviderCapabilityQueries = useQueries({
    queries: (["codex", "claudeAgent", "cursor", "kilo", "opencode"] as const).map((provider) =>
      providerComposerCapabilitiesQueryOptions(provider),
    ),
  });
  const threads = useStore(selectAllThreads);
  const sidebarDisplayThreads = useStore(selectSidebarDisplayThreads);
  const importProviders: ReadonlyArray<ImportProviderKind> = (
    ["codex", "claudeAgent", "cursor", "kilo", "opencode"] as const
  ).filter((provider, index) => supportsThreadImport(importProviderCapabilityQueries[index]?.data));
  const searchPaletteThreads = useMemo<SidebarSearchThread[]>(() => {
    const threadById = new Map(threads.map((thread) => [thread.id, thread] as const));
    return sidebarDisplayThreads.flatMap((threadSummary) => {
      const thread = threadById.get(threadSummary.id);
      if (!thread) {
        return [];
      }

      return [
        {
          id: thread.id,
          title: thread.title,
          projectId: thread.projectId,
          projectName: props.projectById.get(thread.projectId)?.name ?? "Unknown project",
          projectRemoteName:
            props.projectById.get(thread.projectId)?.remoteName ?? "Unknown project",
          provider: thread.modelSelection.provider,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          messages: thread.messages.map((message) => ({
            text: message.text,
          })),
        },
      ];
    });
  }, [props.projectById, sidebarDisplayThreads, threads]);

  return (
    <SidebarSearchPalette
      open={props.open}
      mode={props.mode}
      onModeChange={props.onModeChange}
      onOpenChange={props.onOpenChange}
      actions={props.actions}
      projects={props.projects}
      threads={searchPaletteThreads}
      onCreateChat={props.onCreateChat}
      onCreateThread={props.onCreateThread}
      onAddProjectPath={props.onAddProjectPath}
      homeDir={props.homeDir}
      initialBrowseQuery={props.initialBrowseQuery}
      onOpenSettings={props.onOpenSettings}
      onOpenProject={props.onOpenProject}
      onOpenPullRequestReference={props.onOpenPullRequestReference}
      importProviders={importProviders}
      onImportThread={props.onImportThread}
      onOpenThread={props.onOpenThread}
    />
  );
}
