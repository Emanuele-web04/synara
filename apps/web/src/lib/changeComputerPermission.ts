import type { ThreadId } from "@synara/contracts";

/** Persist only after the server has revoked and drained the previous runtime. */
export async function changeComputerPermission(input: {
  threadId: ThreadId;
  enabled: boolean;
  establishedThread: boolean;
  change: (input: { threadId: ThreadId; enabled: boolean }) => Promise<void>;
  persist: (threadId: ThreadId, enabled: boolean) => void;
}): Promise<void> {
  // Persisted closed/idle sessions can outlive the client that observed them.
  // Always ask the server for an established thread, regardless of UI status.
  if (input.establishedThread)
    await input.change({ threadId: input.threadId, enabled: input.enabled });
  input.persist(input.threadId, input.enabled);
}
