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

export function deriveAssociatedWorktreeMetadata(input: {
  branch?: string | null;
  worktreePath?: string | null;
  associatedWorktreePath?: string | null;
  associatedWorktreeBranch?: string | null;
  associatedWorktreeRef?: string | null;
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
  associatedWorktreePath?: string | null;
  associatedWorktreeBranch?: string | null;
  associatedWorktreeRef?: string | null;
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
