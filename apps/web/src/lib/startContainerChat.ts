// FILE: startContainerChat.ts
// Purpose: Shared "resolve the container project, then open a thread inside it" flow
//          used by the home-chat and Groups new-chat hooks.
// Layer: Web orchestration helper
// Exports: Container-chat startup plus segment-aware fresh-chat dispatch.

import type { ModelSelection, ProjectId, ProviderStartOptions, ThreadId } from "@synara/contracts";
import type { Project } from "../types";
import { useComposerDraftStore } from "../composerDraftStore";
import { isGroupContainerProject } from "./groupProjects";
import type { ServerWorkspacePaths } from "./serverWorkspacePaths";
import type { NewThreadOptions } from "./threadBootstrap";

export type ContainerThreadDefaults = {
  readonly modelSelection?: ModelSelection | undefined;
  readonly providerOptions?: ProviderStartOptions | undefined;
};

export type StartContainerChatResult =
  | { ok: true; threadId: ThreadId | null }
  | { ok: false; error: string };

type StartFreshContainerChat = (options?: { fresh?: boolean }) => Promise<StartContainerChatResult>;

/**
 * Starts a fresh chat in the surface that owns the active project. Thread routes are shared by
 * Projects and Groups, so callers cannot infer the surface from the URL alone.
 */
export function startFreshChatForActiveSurface(input: {
  readonly activeProject: Pick<Project, "cwd" | "kind"> | null;
  readonly isGroupsRoute: boolean;
  readonly paths: ServerWorkspacePaths;
  readonly handleNewChat: StartFreshContainerChat;
  readonly handleNewGroupChat: StartFreshContainerChat;
}): Promise<StartContainerChatResult> {
  const isGroup = input.isGroupsRoute || isGroupContainerProject(input.activeProject, input.paths);
  const handler = isGroup ? input.handleNewGroupChat : input.handleNewChat;
  // Groups always mints a fresh draft; home chat reuses the stored draft thread
  // when one exists (so a draft typed in a new chat survives switching threads),
  // falling back to a fresh draft only when there is nothing to resume.
  return isGroup ? handler({ fresh: true }) : handler();
}

/**
 * Resolves (creating if needed) the backing container project, then starts a thread inside it.
 * Both home chats and group chats share this exact flow; only the container resolver, the
 * per-container thread defaults, and the user-facing failure label vary.
 */
export async function startContainerChat(input: {
  readonly ensureProjectId: () => Promise<ProjectId | null>;
  readonly handleNewThread: (
    projectId: ProjectId,
    options?: NewThreadOptions,
  ) => Promise<ThreadId | null>;
  readonly fresh?: boolean | undefined;
  readonly forceLocalWorkspace?: boolean | undefined;
  // Container-scoped defaults for the fresh thread's draft (e.g. a group's
  // coordinator workerRouting model selection / provider options). Resolved
  // BEFORE the thread is minted so the apply step is synchronous — no
  // post-navigation fetch window where a fast send picks the wrong model.
  readonly resolveThreadDefaults?: (() => Promise<ContainerThreadDefaults | null>) | undefined;
  readonly applyThreadDefaults?:
    | ((threadId: ThreadId, defaults: ContainerThreadDefaults) => void)
    | undefined;
  readonly errorLabel: string;
}): Promise<StartContainerChatResult> {
  try {
    const projectId = await input.ensureProjectId();
    if (!projectId) {
      return { ok: false, error: input.errorLabel };
    }
    const threadDefaults = input.resolveThreadDefaults ? await input.resolveThreadDefaults() : null;
    const threadOptions: NewThreadOptions | undefined =
      input.fresh === true || input.forceLocalWorkspace === true
        ? {
            ...(input.fresh === true ? { fresh: true } : {}),
            envMode: "local",
            branch: null,
            worktreePath: null,
          }
        : undefined;
    const draftsBeforeCreate = useComposerDraftStore.getState().draftsByThreadId;
    const threadId = await input.handleNewThread(projectId, threadOptions);
    if (threadId && threadDefaults && input.applyThreadDefaults) {
      // A thread id that already had a draft is a reused draft, not a fresh
      // one — the user's existing selections win over container defaults.
      if (draftsBeforeCreate[threadId] === undefined) {
        input.applyThreadDefaults(threadId, threadDefaults);
      }
    }
    return { ok: true, threadId };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : input.errorLabel,
    };
  }
}
