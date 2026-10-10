import { useMemo } from "react";

import { inferCheckpointTurnCountByTurnId } from "../session-logic";
import type { Thread } from "../types";

const EMPTY_TURN_DIFF_SUMMARIES: Thread["turnDiffSummaries"] = [];

export function useTurnDiffSummaries(activeThread: Thread | undefined) {
  const turnDiffSummaries = activeThread
    ? activeThread.turnDiffSummaries
    : EMPTY_TURN_DIFF_SUMMARIES;

  // Memoized like DiffPanel: the inference copies and sorts every summary and
  // returns a fresh object, which invalidated ChatView's downstream memos on
  // every streamed flush even though summaries only change on turn completion.
  const inferredCheckpointTurnCountByTurnId = useMemo(
    () => inferCheckpointTurnCountByTurnId(turnDiffSummaries),
    [turnDiffSummaries],
  );

  return { turnDiffSummaries, inferredCheckpointTurnCountByTurnId };
}
