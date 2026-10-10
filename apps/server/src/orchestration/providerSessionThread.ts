import type { ThreadId } from "@synara/contracts";
import { Effect, Option } from "effect";

import type { ProjectionSnapshotQueryShape } from "./Services/ProjectionSnapshotQuery.ts";

/**
 * Resolves the projection thread that owns provider-session side effects.
 * Lookup failures intentionally propagate: falling back to the child id on a
 * transient failure would let independent reactors choose different lease keys.
 *
 * Shell reads only: this runs once (often several times) per provider intent
 * event and once per queued thread in drain/scan loops, and every consumer
 * reads just `id`, `session`, `modelSelection`, and `parentThreadId`. Loading
 * and decoding the full transcript here was pure over-fetching.
 */
export function resolveProviderSessionThread(
  projectionSnapshotQuery: ProjectionSnapshotQueryShape,
  threadId: ThreadId,
) {
  return Effect.gen(function* () {
    const thread = Option.getOrNull(yield* projectionSnapshotQuery.getThreadShellById(threadId));
    if (thread === null) {
      return null;
    }
    if (thread.parentThreadId) {
      return (
        Option.getOrNull(
          yield* projectionSnapshotQuery.getThreadShellById(thread.parentThreadId),
        ) ?? thread
      );
    }
    if (!(thread.id as string).startsWith("subagent:")) {
      return thread;
    }
    return (
      Option.getOrNull(
        yield* projectionSnapshotQuery.findSyntheticSubagentParentThread(thread.id),
      ) ?? thread
    );
  });
}
