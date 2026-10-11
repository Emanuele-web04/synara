import type { ThreadId } from "@synara/contracts";
import { useStore } from "./store";

/** Read authority at the action seam, including callbacks created before restore. */
export function isThreadDetailAwaitingVerification(id: ThreadId): boolean {
  const state = useStore.getState();
  return (
    state.threadDetailSyncById?.[id] === "cached" ||
    (state.threadHistoryById?.[id] !== undefined && state.threadDetailSyncById?.[id] !== "synced")
  );
}

export function assertThreadDetailVerified(id: ThreadId): void {
  if (isThreadDetailAwaitingVerification(id))
    throw new Error("Wait for the conversation to reconnect before sending.");
}
