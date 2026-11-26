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
    let thread = Option.getOrNull(yield* projectionSnapshotQuery.getThreadShellById(threadId));
    const visited = new Set<ThreadId>();
    while (thread && !visited.has(thread.id)) {
      visited.add(thread.id);
      const synthetic = thread.id.startsWith("subagent:");
      if (!synthetic && thread.session) return thread;
      const parent = thread.parentThreadId
        ? Option.getOrNull(yield* projectionSnapshotQuery.getThreadShellById(thread.parentThreadId))
        : synthetic
          ? Option.getOrNull(
              yield* projectionSnapshotQuery.findSyntheticSubagentParentThread(thread.id),
            )
          : null;
      if (!parent || visited.has(parent.id)) return thread;
      thread = parent;
    }
    return thread;
  });
}
