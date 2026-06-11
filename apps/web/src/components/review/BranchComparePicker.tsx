import type { GitBranch, ReviewSourceRef } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { GitBranchIcon } from "~/lib/icons";
import { gitBranchesQueryOptions } from "~/lib/gitReactQuery";
import { rpcErrorMessage } from "~/lib/rpcErrorMessage";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Skeleton } from "../ui/skeleton";
import { EmptyState } from "./reviewPrimitives";

function dedupeBranchNames(branches: ReadonlyArray<GitBranch>): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const branch of branches) {
    if (!seen.has(branch.name)) {
      seen.add(branch.name);
      names.push(branch.name);
    }
  }
  return names;
}

export function BranchComparePicker(props: {
  cwd: string | null;
  onSelectSource: (source: ReviewSourceRef) => void;
}) {
  const branchesQuery = useQuery(gitBranchesQueryOptions(props.cwd));
  const branches = useMemo(() => branchesQuery.data?.branches ?? [], [branchesQuery.data]);
  const branchNames = useMemo(() => dedupeBranchNames(branches), [branches]);

  const defaultBranchName = useMemo(
    () => branches.find((branch) => branch.isDefault)?.name ?? null,
    [branches],
  );
  const currentBranchName = useMemo(
    () => branches.find((branch) => branch.current)?.name ?? null,
    [branches],
  );

  const [base, setBase] = useState<string | null>(null);
  const [head, setHead] = useState<string | null>(null);

  useEffect(() => {
    setBase((previous) =>
      previous && branchNames.includes(previous) ? previous : defaultBranchName,
    );
  }, [branchNames, defaultBranchName]);
  useEffect(() => {
    setHead((previous) =>
      previous && branchNames.includes(previous) ? previous : currentBranchName,
    );
  }, [branchNames, currentBranchName]);

  if (branchesQuery.isLoading) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true">
        <div className="flex items-end gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <Skeleton className="h-3 w-10" />
            <Skeleton className="h-8 w-full rounded-md" />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <Skeleton className="h-3 w-10" />
            <Skeleton className="h-8 w-full rounded-md" />
          </div>
        </div>
        <Skeleton className="ms-auto h-8 w-20 rounded-md" />
      </div>
    );
  }

  if (branchesQuery.isError) {
    return (
      <p className="px-3 py-6 text-center text-[11px] text-destructive">
        {rpcErrorMessage(branchesQuery.error) ?? "Failed to load branches."}
      </p>
    );
  }

  if (branchesQuery.data && !branchesQuery.data.isRepo) {
    return <EmptyState icon={<GitBranchIcon />}>This project is not a git repository.</EmptyState>;
  }

  if (branchNames.length === 0) {
    return <EmptyState icon={<GitBranchIcon />}>No branches to compare.</EmptyState>;
  }

  const canCompare = base !== null && head !== null && base !== head;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-end gap-2">
        <label className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-[11px] font-medium text-muted-foreground">Base</span>
          <Select value={base ?? ""} onValueChange={(value) => setBase(value || null)}>
            <SelectTrigger size="sm" className="w-full" aria-label="Base branch">
              <SelectValue>{base ?? "Select base"}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {branchNames.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </label>
        <label className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-[11px] font-medium text-muted-foreground">Head</span>
          <Select value={head ?? ""} onValueChange={(value) => setHead(value || null)}>
            <SelectTrigger size="sm" className="w-full" aria-label="Head branch">
              <SelectValue>{head ?? "Select head"}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {branchNames.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </label>
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="self-end rounded-md"
        disabled={!canCompare}
        onClick={() => {
          if (base !== null && head !== null && base !== head) {
            props.onSelectSource({ _tag: "branchRange", base, head });
          }
        }}
      >
        Compare
      </Button>
    </div>
  );
}
