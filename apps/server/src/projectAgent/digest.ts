import type { ProjectDigestFocusItem } from "@synara/contracts";

export function wakeReceiptRequestId(input: {
  readonly projectId: string;
  readonly fromInboxId: string;
  readonly toInboxId: string;
}): string {
  return `wake:${input.projectId}:${input.fromInboxId}:${input.toInboxId}`;
}

export function allowedDigestSources(input: {
  readonly activityIds: ReadonlyArray<string>;
  readonly taskIds: ReadonlyArray<string>;
  readonly threadIds: ReadonlyArray<string>;
  readonly documentPaths: ReadonlyArray<string>;
}): Set<string> {
  return new Set([
    ...input.activityIds,
    ...input.taskIds,
    ...input.threadIds,
    ...input.documentPaths,
  ]);
}

export function validateDigestFocusItems(
  items: ReadonlyArray<{
    readonly title: string;
    readonly kind: ProjectDigestFocusItem["kind"];
    readonly source: string;
  }>,
  allowedSources: ReadonlySet<string>,
): ReadonlyArray<ProjectDigestFocusItem> {
  const validated: ProjectDigestFocusItem[] = [];
  for (const [index, item] of items.entries()) {
    if (!allowedSources.has(item.source)) continue;
    validated.push({
      id: `focus-${index}-${item.source}`,
      title: item.title,
      kind: item.kind,
      pinned: false,
      ...(item.kind === "task" ? { taskId: item.source as ProjectDigestFocusItem["taskId"] } : {}),
      ...(item.kind === "message" ? { sourceThreadId: item.source as never } : {}),
      ...(item.kind === "artifact" ? { artifactPath: item.source } : {}),
    });
  }
  return validated;
}

export function mergePinnedFocusItems(
  generated: ReadonlyArray<ProjectDigestFocusItem>,
  pinned: ReadonlyArray<ProjectDigestFocusItem>,
): ReadonlyArray<ProjectDigestFocusItem> {
  const seen = new Set(pinned.map((item) => item.id));
  return [
    ...pinned.map((item) => ({ ...item, pinned: true })),
    ...generated.filter((item) => !seen.has(item.id)),
  ];
}
