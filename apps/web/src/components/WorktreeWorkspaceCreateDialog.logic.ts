import type { GitBranch, GitPullRequestListItem } from "@synara/contracts";

export function branchNameFromWorkspaceTitle(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return `synara/${slug || "workspace"}`;
}

export function readableWorkspaceBranchName(branch: GitBranch): string {
  if (!branch.isRemote || !branch.remoteName) return branch.name;
  return branch.name.replace(new RegExp(`^${branch.remoteName}/`), "");
}

export function dedupeWorkspaceBranches(branches: readonly GitBranch[]): readonly GitBranch[] {
  return branches.filter(
    (branch, index, allBranches) =>
      allBranches.findIndex(
        (candidate) =>
          readableWorkspaceBranchName(candidate) === readableWorkspaceBranchName(branch),
      ) === index,
  );
}

export function filterWorkspaceBranches(
  branches: readonly GitBranch[],
  query: string,
): readonly GitBranch[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return branches;
  return branches.filter((branch) =>
    [readableWorkspaceBranchName(branch), branch.name, branch.remoteName]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(normalizedQuery),
  );
}

export function filterWorkspacePullRequests(
  pullRequests: readonly GitPullRequestListItem[],
  query: string,
): readonly GitPullRequestListItem[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return pullRequests;
  return pullRequests.filter((pullRequest) =>
    [
      pullRequest.title,
      pullRequest.authorLogin,
      pullRequest.headBranch,
      pullRequest.baseBranch,
      pullRequest.url,
      String(pullRequest.number),
      `#${pullRequest.number}`,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(normalizedQuery),
  );
}
