/**
 * Sanitize an arbitrary string into a valid, lowercase git branch fragment.
 * Strips quotes, collapses separators, limits to 64 chars.
 */
export const WORKTREE_BRANCH_PREFIX = "synara";
const TEMP_WORKTREE_BRANCH_PATTERN = /^([a-z0-9][a-z0-9-]*)\/[0-9a-f]{8}$/;
// Exact 64-bit namespace fingerprints preserve pre-cutover worktrees without
// retaining retired first-party names in source or matching arbitrary namespaces.
const PRE_CUTOVER_WORKTREE_NAMESPACE_HASHES = new Set([0x8559131d2c062cf0n, 0xd53b4ab95395e345n]);

function hashWorktreeNamespace(value: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash;
}

function isPreCutoverWorktreeNamespace(value: string): boolean {
  return PRE_CUTOVER_WORKTREE_NAMESPACE_HASHES.has(hashWorktreeNamespace(value));
}

export function sanitizeBranchFragment(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/['"`]/g, "")
    .replace(/^[./\s_-]+|[./\s_-]+$/g, "");

  const branchFragment = normalized
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");

  return branchFragment.length > 0 ? branchFragment : "update";
}

/**
 * Sanitize a string into a `feature/…` branch name.
 * Preserves an existing `feature/` prefix or slash-separated namespace.
 */
export function sanitizeFeatureBranchName(raw: string): string {
  const sanitized = sanitizeBranchFragment(raw);
  if (sanitized.includes("/")) {
    return sanitized.startsWith("feature/") ? sanitized : `feature/${sanitized}`;
  }
  return `feature/${sanitized}`;
}

const AUTO_FEATURE_BRANCH_FALLBACK = "feature/update";
const SYNARA_BRANCH_FALLBACK = "update";

/**
 * Resolve a unique `feature/…` branch name that doesn't collide with
 * any existing branch. Appends a numeric suffix when needed.
 */
export function resolveAutoFeatureBranchName(
  existingBranchNames: readonly string[],
  preferredBranch?: string,
): string {
  const preferred = preferredBranch?.trim();
  const resolvedBase = sanitizeFeatureBranchName(
    preferred && preferred.length > 0 ? preferred : AUTO_FEATURE_BRANCH_FALLBACK,
  );
  const existingNames = new Set(existingBranchNames.map((branch) => branch.toLowerCase()));

  if (!existingNames.has(resolvedBase)) {
    return resolvedBase;
  }

  let suffix = 2;
  while (existingNames.has(`${resolvedBase}-${suffix}`)) {
    suffix += 1;
  }

  return `${resolvedBase}-${suffix}`;
}

export function buildSynaraBranchName(preferredBranch?: string | null): string {
  const preferred = preferredBranch?.trim() ?? "";
  const separatorIndex = preferred.indexOf("/");
  const existingNamespace =
    separatorIndex > 0 ? preferred.slice(0, separatorIndex).toLowerCase() : "";
  const normalizedExisting =
    existingNamespace === "codex" ||
    existingNamespace === WORKTREE_BRANCH_PREFIX ||
    isPreCutoverWorktreeNamespace(existingNamespace)
      ? preferred.slice(separatorIndex + 1)
      : preferred;
  return `${WORKTREE_BRANCH_PREFIX}/${sanitizeBranchFragment(
    normalizedExisting || SYNARA_BRANCH_FALLBACK,
  )}`;
}

export function resolveUniqueSynaraBranchName(
  existingBranchNames: readonly string[],
  preferredBranch?: string | null,
): string {
  const resolvedBase = buildSynaraBranchName(preferredBranch);
  const existingNames = new Set(existingBranchNames.map((branch) => branch.toLowerCase()));

  if (!existingNames.has(resolvedBase)) {
    return resolvedBase;
  }

  let suffix = 2;
  while (existingNames.has(`${resolvedBase}-${suffix}`)) {
    suffix += 1;
  }

  return `${resolvedBase}-${suffix}`;
}

export function isTemporaryWorktreeBranch(branch: string): boolean {
  const match = TEMP_WORKTREE_BRANCH_PATTERN.exec(branch.trim().toLowerCase());
  const namespace = match?.[1];
  return (
    namespace !== undefined &&
    (namespace === WORKTREE_BRANCH_PREFIX || isPreCutoverWorktreeNamespace(namespace))
  );
}

export function buildTemporaryWorktreeBranchName(): string {
  const token = crypto.randomUUID().replace(/-/g, "").slice(0, 8).toLowerCase();
  return `${WORKTREE_BRANCH_PREFIX}/${token}`;
}

// Preserve semantic thread branches when transient worktree placeholders briefly
// appear in git status during rename/bootstrap transitions.
export function resolveThreadBranchRegressionGuard(input: {
  currentBranch: string | null;
  nextBranch: string | null;
}): string | null {
  if (
    input.currentBranch !== null &&
    input.nextBranch !== null &&
    !isTemporaryWorktreeBranch(input.currentBranch) &&
    isTemporaryWorktreeBranch(input.nextBranch)
  ) {
    return input.currentBranch;
  }

  return input.nextBranch;
}

export function mergeGitStatusParts<Local extends object, Remote extends object>(
  local: Local,
  remote: Remote | null,
): Local & Remote {
  return {
    ...local,
    ...(remote ?? {
      hasUpstream: false,
      upstreamBranch: null,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    }),
  } as Local & Remote;
}
