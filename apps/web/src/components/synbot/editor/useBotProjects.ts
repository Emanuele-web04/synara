// FILE: useBotProjects.ts
// Purpose: Where a bot can work: this computer's ordinary projects (no chats, studio or hub
//          folders), by name. Shared by the bot sheet and the New bot steps.
// Layer: SynBot editor hooks
// Exports: useBotProjects

import { useMemo } from "react";

import { isOrdinarySpaceProject } from "~/lib/spaces";
import { useStore } from "~/store";
import { useWorkspacePathsStore } from "~/workspacePathsStore";

export function useBotProjects() {
  const projects = useStore((store) => store.projects);
  const homeDir = useWorkspacePathsStore((state) => state.homeDir);
  const chatWorkspaceRoot = useWorkspacePathsStore((state) => state.chatWorkspaceRoot);
  const studioWorkspaceRoot = useWorkspacePathsStore((state) => state.studioWorkspaceRoot);
  const groupsWorkspaceRoot = useWorkspacePathsStore((state) => state.groupsWorkspaceRoot);
  return useMemo(
    () =>
      projects
        .filter((project) =>
          isOrdinarySpaceProject(project, {
            homeDir,
            chatWorkspaceRoot,
            studioWorkspaceRoot,
            groupsWorkspaceRoot,
          }),
        )
        .toSorted((left, right) => left.name.localeCompare(right.name)),
    [chatWorkspaceRoot, groupsWorkspaceRoot, homeDir, projects, studioWorkspaceRoot],
  );
}
