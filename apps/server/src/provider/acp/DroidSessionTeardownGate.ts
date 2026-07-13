// FILE: DroidSessionTeardownGate.ts
// Purpose: Prevents a replacement Droid ACP runtime from starting before its predecessor exits.
// Layer: Provider ACP lifecycle coordination

import type { ThreadId } from "@synara/contracts";
import { Deferred, Effect } from "effect";

export interface DroidSessionTeardownGate {
  readonly track: (threadId: ThreadId, completion: Deferred.Deferred<void>) => void;
  readonly isPending: (threadId: ThreadId) => boolean;
  readonly awaitPending: (threadId: ThreadId) => Effect.Effect<void>;
  readonly complete: (
    threadId: ThreadId,
    completion: Deferred.Deferred<void>,
  ) => Effect.Effect<void>;
}

export function makeDroidSessionTeardownGate(): DroidSessionTeardownGate {
  const pendingByThreadId = new Map<ThreadId, Deferred.Deferred<void>>();

  return {
    track: (threadId, completion) => {
      pendingByThreadId.set(threadId, completion);
    },
    isPending: (threadId) => pendingByThreadId.has(threadId),
    awaitPending: (threadId) =>
      Effect.suspend(() => {
        const pending = pendingByThreadId.get(threadId);
        return pending === undefined ? Effect.void : Deferred.await(pending);
      }),
    complete: (threadId, completion) =>
      Effect.gen(function* () {
        yield* Deferred.succeed(completion, undefined);
        if (pendingByThreadId.get(threadId) === completion) {
          pendingByThreadId.delete(threadId);
        }
      }),
  };
}
