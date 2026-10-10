// FILE: useSubagentRunControls.ts
// Purpose: Per-run subagent controls (run in background, stop) shared by the composer
//          strip and the right-dock Subagents pane, so both dispatch through one seam.
// Layer: Chat hooks
// Exports: useSubagentRunControls

import type { ThreadId } from "@synara/contracts";
import { useCallback } from "react";

import { newCommandId } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";

import { toastManager } from "../ui/toast";

import { localSubagentThreadId } from "../ChatView.selectors";
import type { ComposerSubagentStripItem } from "./ComposerSubagentStrip.logic";

type SubagentRunTarget = Pick<ComposerSubagentStripItem, "providerThreadId">;

export function useSubagentRunControls(stripSourceThreadId: ThreadId | null) {
  const backgroundSubagent = useCallback(
    async (item: SubagentRunTarget) => {
      const api = readNativeApi();
      // The Task tool_use lives on the strip source thread (the parent while a
      // subagent thread is open), so route the command there.
      if (!api || !stripSourceThreadId) return;
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.task.background",
          commandId: newCommandId(),
          threadId: stripSourceThreadId,
          toolUseId: item.providerThreadId,
          createdAt: new Date().toISOString(),
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not update the subagent",
          description:
            error instanceof Error ? error.message : "The subagent request failed. Try again.",
        });
      }
    },
    [stripSourceThreadId],
  );

  // Stop goes through the interrupt seam: on a subagent thread the reactor
  // resolves the tool_use_id and stops that task instead of the whole turn.
  // Target the canonical child id derived from the strip source thread —
  // item.threadId can still be the raw tool_use_id while client-side thread
  // resolution lags, which the server would reject as an unknown thread.
  const stopSubagent = useCallback(
    async (item: SubagentRunTarget) => {
      const api = readNativeApi();
      if (!api || !stripSourceThreadId) return;
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.turn.interrupt",
          commandId: newCommandId(),
          threadId: localSubagentThreadId(stripSourceThreadId, item.providerThreadId),
          createdAt: new Date().toISOString(),
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not update the subagent",
          description:
            error instanceof Error ? error.message : "The subagent request failed. Try again.",
        });
      }
    },
    [stripSourceThreadId],
  );

  return { backgroundSubagent, stopSubagent };
}
