export interface AssociatedWorktreeMetadata {
  associatedWorktreePath: string | null;
  associatedWorktreeBranch: string | null;
  associatedWorktreeRef: string | null;
}

export interface AssociatedWorktreeMetadataPatch {
  associatedWorktreePath?: string | null;
  associatedWorktreeBranch?: string | null;
  associatedWorktreeRef?: string | null;
}

export interface NormalizeWorkspaceRootForComparisonOptions {
  readonly platform?: string;
}

function isLikelyWindowsWorkspaceRoot(value: string, platform?: string): boolean {
  if (platform === "win32") {
    return true;
  }
  if (platform && platform !== "win32") {
    return false;
  }
  return /^[a-z]:([\\/]|$)/i.test(value) || value.startsWith("\\\\") || value.startsWith("//");
}

// normalizes import-path identity without changing the stored display path
export function normalizeWorkspaceRootForComparison(
  value: string,
  options?: NormalizeWorkspaceRootForComparisonOptions,
): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "";
  }

  const withForwardSlashes = trimmed.replace(/\\/g, "/");
  const isWindowsDriveRoot = /^[a-z]:\/+$/i.test(withForwardSlashes);
  const hasUncPrefix = withForwardSlashes.startsWith("//");
  const prefix = hasUncPrefix ? "//" : withForwardSlashes.startsWith("/") ? "/" : "";
  const body = withForwardSlashes.slice(prefix.length).replace(/\/+/g, "/");
  const normalized =
    prefix.length > 0 ? `${prefix}${body.replace(/\/+$/g, "")}` : body.replace(/\/+$/g, "");
  let finalValue = isWindowsDriveRoot
    ? `${withForwardSlashes.slice(0, 2)}/`
    : normalized.length > 0
      ? normalized
      : prefix;

  // macOS surfaces the same location as /var/... and /private/var/... — treat aliases as identical so imported worktree paths match during resume/import
  if (
    options?.platform === "darwin" &&
    (finalValue.startsWith("/private/var/") || finalValue.startsWith("/private/tmp/"))
  ) {
    finalValue = finalValue.slice("/private".length);
  }

  if (isLikelyWindowsWorkspaceRoot(trimmed, options?.platform)) {
    return finalValue.toLowerCase();
  }
  return finalValue;
}

export function workspaceRootsEqual(
  left: string,
  right: string,
  options?: NormalizeWorkspaceRootForComparisonOptions,
): boolean {
  return (
    normalizeWorkspaceRootForComparison(left, options) ===
    normalizeWorkspaceRootForComparison(right, options)
  );
}

// normalized roots so trailing slashes, separator style, and /private aliasing never cause false negatives; segment-aware so /a/app isn't inside /a/ap
export function isWorkspaceRootWithin(
  candidate: string,
  ancestorRoot: string,
  options?: NormalizeWorkspaceRootForComparisonOptions,
): boolean {
  const normalizedCandidate = normalizeWorkspaceRootForComparison(candidate, options);
  const normalizedAncestor = normalizeWorkspaceRootForComparison(ancestorRoot, options);
  if (normalizedCandidate.length === 0 || normalizedAncestor.length === 0) {
    return false;
  }
  if (normalizedCandidate === normalizedAncestor) {
    return true;
  }
  const prefix = normalizedAncestor.endsWith("/") ? normalizedAncestor : `${normalizedAncestor}/`;
  return normalizedCandidate.startsWith(prefix);
}

// per-thread scratch dirs used when a session starts before any project workspace exists
export const SCRATCH_WORKSPACES_DIRNAME = "synara-codex-workspaces";

// a string-level gate on purpose — the web decides whether an out-of-workspace reference can still preview; the server's allowlist enforces real containment
export function isScratchWorkspacePath(filePath: string): boolean {
  const normalized = filePath.trim().replace(/\\/g, "/");
  const isAbsolute = normalized.startsWith("/") || /^[a-z]:\//i.test(normalized);
  return isAbsolute && normalized.includes(`/${SCRATCH_WORKSPACES_DIRNAME}/`);
}

export function deriveAssociatedWorktreeMetadata(input: {
  branch?: string | null;
  worktreePath?: string | null;
  // `!== undefined` distinguishes "derive" (undefined) from "explicitly none" (null); Schema.optional admits an explicit undefined under exactOptionalPropertyTypes
  associatedWorktreePath?: string | null | undefined;
  associatedWorktreeBranch?: string | null | undefined;
  associatedWorktreeRef?: string | null | undefined;
}): AssociatedWorktreeMetadata {
  return {
    associatedWorktreePath:
      input.associatedWorktreePath !== undefined
        ? input.associatedWorktreePath
        : (input.worktreePath ?? null),
    associatedWorktreeBranch:
      input.associatedWorktreeBranch !== undefined
        ? input.associatedWorktreeBranch
        : input.worktreePath
          ? (input.branch ?? null)
          : null,
    associatedWorktreeRef:
      input.associatedWorktreeRef !== undefined
        ? input.associatedWorktreeRef
        : input.associatedWorktreeBranch !== undefined
          ? input.associatedWorktreeBranch
          : input.worktreePath
            ? (input.branch ?? null)
            : null,
  };
}

export function deriveAssociatedWorktreeMetadataPatch(input: {
  branch?: string | null;
  worktreePath?: string | null;
  // same undefined-aware semantics as above
  associatedWorktreePath?: string | null | undefined;
  associatedWorktreeBranch?: string | null | undefined;
  associatedWorktreeRef?: string | null | undefined;
}): AssociatedWorktreeMetadataPatch {
  const patch: AssociatedWorktreeMetadataPatch = {};

  if (input.associatedWorktreePath !== undefined) {
    patch.associatedWorktreePath = input.associatedWorktreePath;
  } else if (input.worktreePath !== undefined && input.worktreePath !== null) {
    patch.associatedWorktreePath = input.worktreePath;
  }

  if (input.associatedWorktreeBranch !== undefined) {
    patch.associatedWorktreeBranch = input.associatedWorktreeBranch;
  } else if (input.worktreePath !== undefined && input.worktreePath !== null) {
    patch.associatedWorktreeBranch = input.branch ?? null;
  }

  if (input.associatedWorktreeRef !== undefined) {
    patch.associatedWorktreeRef = input.associatedWorktreeRef;
  } else if (input.associatedWorktreeBranch !== undefined) {
    patch.associatedWorktreeRef = input.associatedWorktreeBranch;
  } else if (input.worktreePath !== undefined && input.worktreePath !== null) {
    patch.associatedWorktreeRef = input.branch ?? null;
  }

  return patch;
}
