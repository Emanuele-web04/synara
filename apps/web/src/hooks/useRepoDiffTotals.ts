import { useQuery } from "@tanstack/react-query";

import { gitWorkingTreeDiffStatsQueryOptions } from "~/lib/gitReactQuery";
import { useRepoDiffScope } from "~/repoDiffScopeStore";

export interface RepoDiffTotals {
  additions: number;
  deletions: number;
  fileCount: number;
  hasChanges: boolean;
}

export function useRepoDiffTotals({
  gitCwd,
  isGitRepo,
  refetchInterval: refetchIntervalProp,
}: {
  gitCwd: string | null;
  isGitRepo: boolean;
  refetchInterval?: number | false;
}): RepoDiffTotals {
  const refetchInterval = refetchIntervalProp ?? false;
  const { scope: repoDiffScope, compareRef: repoDiffCompareRef } = useRepoDiffScope(gitCwd);
  // counts only — the patch these used to be derived from grows with the tree and cost megabytes + a reparse per poll; the server counts the same patch it would have sent
  const { data: totals } = useQuery(
    gitWorkingTreeDiffStatsQueryOptions({
      cwd: gitCwd,
      scope: repoDiffScope,
      compareRef: repoDiffCompareRef,
      enabled: isGitRepo,
      refetchInterval,
    }),
  );
  const additions = totals?.additions ?? 0;
  const deletions = totals?.deletions ?? 0;
  const fileCount = totals?.fileCount ?? 0;
  return { additions, deletions, fileCount, hasChanges: additions > 0 || deletions > 0 };
}
