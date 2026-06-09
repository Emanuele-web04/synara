// FILE: useRepoDiffTotals.ts
// Purpose: Resolve the working-tree diff totals (+additions / -deletions) for the
//          currently selected repo diff scope. Shared by the chat-header diff toggle
//          badge and the Environment panel "Changes" row so both read the same numbers.
// Layer: Chat git data hook

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { summarizePatchTotals } from "~/lib/diffRendering";
import { gitWorkingTreeDiffQueryOptions } from "~/lib/gitReactQuery";
import { useRepoDiffScopeStore } from "~/repoDiffScopeStore";

export interface RepoDiffTotals {
  additions: number;
  deletions: number;
  /** Number of files touched in the selected scope. */
  fileCount: number;
  /** True when the working tree has any insertions or deletions in the selected scope. */
  hasChanges: boolean;
}

export function useRepoDiffTotals({
  gitCwd,
  isGitRepo,
  refetchInterval = false,
}: {
  gitCwd: string | null;
  isGitRepo: boolean;
  refetchInterval?: number | false;
}): RepoDiffTotals {
  // Match the Diff panel source selector so every surface shows the selected scope.
  const repoDiffScope = useRepoDiffScopeStore((store) => store.scope);
  const { data: selectedRepoDiff = null } = useQuery(
    gitWorkingTreeDiffQueryOptions({
      cwd: gitCwd,
      scope: repoDiffScope,
      enabled: isGitRepo,
      refetchInterval,
    }),
  );
  // Patch parsing can be noticeable on large diffs; only redo it when the patch text changes.
  const totals = useMemo(
    () => summarizePatchTotals(selectedRepoDiff?.patch),
    [selectedRepoDiff?.patch],
  );
  const additions = totals?.additions ?? 0;
  const deletions = totals?.deletions ?? 0;
  const fileCount = totals?.fileCount ?? 0;
  return { additions, deletions, fileCount, hasChanges: additions > 0 || deletions > 0 };
}
