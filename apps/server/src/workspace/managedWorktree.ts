import type { Path } from "effect";

export const parseManagedWorktreeWorkspaceRoot = (input: {
  readonly gitPointerFileContents: string;
  readonly path: Path.Path;
  readonly worktreePath: string;
}): string | null => {
  const firstLine = input.gitPointerFileContents.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!firstLine.toLowerCase().startsWith("gitdir:")) return null;

  const gitdirValue = firstLine.slice("gitdir:".length).trim();
  if (!gitdirValue) return null;

  const resolvedGitdir = input.path.isAbsolute(gitdirValue)
    ? input.path.normalize(gitdirValue)
    : input.path.resolve(input.worktreePath, gitdirValue);
  const marker = `${input.path.sep}.git${input.path.sep}worktrees${input.path.sep}`;
  const markerIndex = resolvedGitdir.lastIndexOf(marker);
  return markerIndex < 0 ? null : resolvedGitdir.slice(0, markerIndex);
};
