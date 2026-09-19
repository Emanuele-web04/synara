// FILE: useComputerDesktopControl.ts
// Purpose: The one "the agent is driving the desktop — stop it" control, shared by the
//          Computer pane's header and the chat-level banner.
// Layer: Web data hook
// Exports: useComputerDesktopControl, ComputerDesktopControl
//
// Both surfaces can be on screen at once and they stop the same turn, so they
// must not be able to disagree about whether a stop is in flight or whether it
// failed. The mutation is therefore keyed on the thread that actually owns the
// desktop rather than owned per instance: pressing Stop in the pane disables
// the banner's Stop too, and the failure is reported wherever the user is
// looking rather than only on the button they happened to press.

import type { ThreadId } from "@synara/contracts";
import { useMutation, useMutationState } from "@tanstack/react-query";
import { useMemo } from "react";

import { interruptThreadTurn } from "~/lib/threadTurnInterrupt";
import { selectThreadComputerState, useComputerStateStore } from "../computerStateStore";

export interface ComputerDesktopControl {
  readonly agentActive: boolean;
  readonly visibleDesktop: boolean;
  readonly stopRequested: boolean;
  readonly stop: () => void;
  readonly stopError: string | null;
}

/** Keyed on the owning thread: two conversations' stops are two mutations. */
function stopTurnMutationKey(ownerThreadId: ThreadId): readonly unknown[] {
  return ["computer", "stop-turn", ownerThreadId];
}

export function useComputerDesktopControl(threadId: ThreadId): ComputerDesktopControl {
  const threadState = useComputerStateStore(selectThreadComputerState(threadId));
  const owner = threadState?.controlOwnerThreadId;
  // Ownership lasts for the turn, including model thinking between tool calls.
  // It gives the Stop control a stable lifetime without a debounce timer.
  const agentActive = owner !== undefined || (threadState?.agentActive ?? false);
  const ownerThreadId = owner ?? threadId;
  const mutationKey = useMemo(() => stopTurnMutationKey(ownerThreadId), [ownerThreadId]);
  const interrupt = useMutation({ mutationKey, mutationFn: interruptThreadTurn });
  // The shared view of that key, so a stop started by the other surface is the
  // same stop here. The newest entry is the current attempt; older ones are
  // finished stops React Query has not garbage-collected yet.
  const attempts = useMutationState({
    filters: { mutationKey, exact: true },
    select: (mutation) => mutation.state,
  });
  const latest = attempts[attempts.length - 1];
  const stopPending = latest?.status === "pending";
  // A failure only means anything while there is still something to stop; once
  // the turn is over, the button is gone and so is the message.
  const stopError = agentActive && latest?.status === "error" ? latest.error : null;

  return {
    agentActive,
    visibleDesktop: threadState?.capabilities.visibleDesktop ?? false,
    stopRequested: stopPending && agentActive,
    stop: () => {
      if (!stopPending) interrupt.mutate(ownerThreadId);
    },
    stopError: stopError
      ? (stopError instanceof Error ? stopError.message : String(stopError)) ||
        "The stop request failed. Try again in a moment."
      : null,
  };
}
