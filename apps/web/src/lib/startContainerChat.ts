// FILE: startContainerChat.ts
// Purpose: Shared "ensure the hidden container project, then open a thread inside it" flow
//          used by both the home-chat and Studio new-chat hooks.
// Layer: Web orchestration helper
// Exports: startContainerChat plus its result type.

import type { ProjectId } from "@t3tools/contracts";
import type { NewThreadOptions } from "./threadBootstrap";

export type StartContainerChatResult = { ok: true } | { ok: false; error: string };

/**
 * Resolves (creating if needed) the backing container project, then starts a thread inside it.
 * Both home chats and Studio chats share this exact flow; only the container resolver and the
 * user-facing failure label vary.
 */
export async function startContainerChat(input: {
  readonly ensureProjectId: () => Promise<ProjectId | null>;
  readonly handleNewThread: (projectId: ProjectId, options?: NewThreadOptions) => Promise<unknown>;
  readonly fresh?: boolean | undefined;
  readonly errorLabel: string;
}): Promise<StartContainerChatResult> {
  try {
    const projectId = await input.ensureProjectId();
    if (!projectId) {
      return { ok: false, error: input.errorLabel };
    }
    const threadOptions: NewThreadOptions | undefined =
      input.fresh === true ? { fresh: true, envMode: "local", worktreePath: null } : undefined;
    await input.handleNewThread(projectId, threadOptions);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : input.errorLabel,
    };
  }
}
