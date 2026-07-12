import type { CommandId, OrchestrationEvent } from "@synara/contracts";

export function waitForCheckpointFileRestore(input: {
  requestCommandId: CommandId;
  subscribe: (listener: (event: OrchestrationEvent) => void) => () => void;
}): { promise: Promise<void>; cancel: () => void } {
  // Never release the caller's mutation gate based on elapsed time. The server
  // serializes checkpoint work, so a valid restore can wait behind long captures;
  // only its correlated durable success/failure proves it is safe to continue.
  let unsubscribe = () => {};
  let settled = false;

  const cleanup = () => {
    unsubscribe();
  };
  const promise = new Promise<void>((resolve, reject) => {
    unsubscribe = input.subscribe((event) => {
      if (
        (event.type !== "thread.checkpoint-files-restored" &&
          event.type !== "thread.checkpoint-files-restore-failed") ||
        event.payload.requestCommandId !== input.requestCommandId
      ) {
        return;
      }
      settled = true;
      cleanup();
      if (event.type === "thread.checkpoint-files-restore-failed") {
        reject(new Error(event.payload.detail));
      } else {
        resolve();
      }
    });
  });

  return {
    promise,
    cancel: () => {
      if (!settled) cleanup();
    },
  };
}
