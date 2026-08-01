// FILE: threadSettle.ts
// Purpose: Dispatches the thread settle/unsettle toggle from the client.
// Layer: Web orchestration helper
// Exports: setThreadSettledFromClient

import type { NativeApi, ThreadId } from "@synara/contracts";

import { newCommandId } from "./utils";

type ThreadCommandDispatcher = Pick<NativeApi["orchestration"], "dispatchCommand">;

// Marks a thread settled (done, dimmed at the bottom of the Activity view) or
// restores it. The server stamps the authoritative `settledAt` timestamp from
// the `isSettled` intent, so two clients toggling concurrently converge on the
// last write instead of racing on client clocks.
export async function setThreadSettledFromClient(
  api: ThreadCommandDispatcher,
  threadId: ThreadId,
  isSettled: boolean,
): Promise<void> {
  await api.dispatchCommand({
    type: "thread.meta.update",
    commandId: newCommandId(),
    threadId,
    isSettled,
  });
}
