import type { NativeApi, ThreadId } from "@synara/contracts";

import { newCommandId } from "./utils";

type ThreadCommandDispatcher = Pick<NativeApi["orchestration"], "dispatchCommand">;

export interface OptimisticSettledMutation {
  readonly desiredSettled: boolean;
  readonly commandSequence: number | null;
  /**
   * True once the projection has represented a state different from the latest
   * desired value. This prevents Done → Undo from treating the pre-Done snapshot
   * as acknowledgement of Undo before either command has projected.
   */
  readonly observedDifferentState: boolean;
}

export function createOptimisticSettledMutation(input: {
  desiredSettled: boolean;
  serverSettledAtDispatch: boolean;
}): OptimisticSettledMutation {
  return {
    desiredSettled: input.desiredSettled,
    commandSequence: null,
    observedDifferentState: input.serverSettledAtDispatch !== input.desiredSettled,
  };
}

export function recordOptimisticSettledMutationSequence(
  mutation: OptimisticSettledMutation,
  commandSequence: number,
): OptimisticSettledMutation {
  if (mutation.commandSequence === commandSequence) return mutation;
  return { ...mutation, commandSequence };
}

export function reconcileOptimisticSettledMutation(
  mutation: OptimisticSettledMutation,
  serverSettled: boolean,
  projectionSequence: number = 0,
): { acknowledged: boolean; mutation: OptimisticSettledMutation } {
  // reconnect replay can fold Done→Undo into one store update so the UI may never render the intermediate boolean — the durable sequence proves the latest command passed through the projection even batched
  if (mutation.commandSequence !== null && projectionSequence >= mutation.commandSequence) {
    return { acknowledged: true, mutation };
  }
  if (serverSettled === mutation.desiredSettled) {
    return { acknowledged: mutation.observedDifferentState, mutation };
  }
  if (mutation.observedDifferentState) {
    return { acknowledged: false, mutation };
  }
  return {
    acknowledged: false,
    mutation: { ...mutation, observedDifferentState: true },
  };
}

// the server stamps authoritative settledAt from the isSettled intent so two clients toggling concurrently converge on last write instead of racing on client clocks
export async function setThreadSettledFromClient(
  api: ThreadCommandDispatcher,
  threadId: ThreadId,
  isSettled: boolean,
): Promise<number> {
  const result = await api.dispatchCommand({
    type: "thread.meta.update",
    commandId: newCommandId(),
    threadId,
    isSettled,
  });
  return result.sequence;
}
