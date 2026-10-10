// FILE: groupCoordinatorName.ts
// Purpose: The coordinator's display name is its configured name, defaulting to
//          the group's own name — the coordinator glyph already carries the
//          role, so no "Coordinator" suffix is appended anywhere. Legacy groups
//          stored "<title> Coordinator"; that exact generated default now reads
//          as the group name while a name the user chose is kept verbatim.
// Layer: Web view logic (no React)
// Exports: isDefaultGroupCoordinatorName, resolveGroupCoordinatorDisplayName

const GROUP_COORDINATOR_LEGACY_SUFFIX = " Coordinator";

/**
 * Whether a stored coordinator name is the generated default rather than a name
 * the user chose. Both shapes of default count: the legacy "<title> Coordinator"
 * and the current one (the group's own name). Anything else is custom.
 */
export function isDefaultGroupCoordinatorName(
  name: string | null | undefined,
  candidates: readonly (string | null | undefined)[],
): boolean {
  const trimmed = name?.trim() ?? "";
  if (trimmed.length === 0) {
    return true;
  }
  return candidates.some((candidate) => {
    const groupName = candidate?.trim() ?? "";
    return (
      groupName.length > 0 &&
      (trimmed === groupName || trimmed === `${groupName}${GROUP_COORDINATOR_LEGACY_SUFFIX}`)
    );
  });
}

/**
 * Resolves what every surface shows for the coordinator. `remoteName` is the
 * server-side group title; `groupName` is the label shown locally (it can
 * differ after a local rename). A user-renamed coordinator thread title wins
 * over a default config name so the sidebar row and the chat header agree.
 */
export function resolveGroupCoordinatorDisplayName(input: {
  readonly coordinatorName: string | null | undefined;
  readonly groupName: string;
  readonly remoteName?: string | null | undefined;
  readonly threadTitle?: string | null | undefined;
}): string {
  const candidates = [input.remoteName ?? input.groupName, input.groupName];
  const threadTitle = input.threadTitle?.trim();
  if (threadTitle && !isDefaultGroupCoordinatorName(threadTitle, candidates)) {
    return threadTitle;
  }
  const coordinatorName = input.coordinatorName?.trim();
  if (coordinatorName && !isDefaultGroupCoordinatorName(coordinatorName, candidates)) {
    return coordinatorName;
  }
  return input.groupName;
}
