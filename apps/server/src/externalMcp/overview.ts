import type { ExternalMcpCapability } from "@synara/contracts";

interface OverviewProjectInput {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
}

interface OverviewThreadInput {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly archivedAt?: string | null | undefined;
  readonly latestTurn: { readonly state: string } | null;
}

interface OverviewThreadSummary {
  total: number;
  active: number;
  readonly threads: Array<OverviewThreadInput>;
}

const MAX_RECENT_THREADS = 5;

export function buildExternalMcpOverviewProjects(input: {
  readonly projects: ReadonlyArray<OverviewProjectInput>;
  readonly threads: ReadonlyArray<OverviewThreadInput>;
  readonly allowedProjectIds: ReadonlySet<string>;
  readonly includeThreadMetadata: boolean;
}) {
  const threadsByProject = new Map<string, OverviewThreadSummary>();
  for (const thread of input.threads) {
    if (thread.archivedAt || !input.allowedProjectIds.has(thread.projectId)) continue;
    const summary: OverviewThreadSummary = threadsByProject.get(thread.projectId) ?? {
      total: 0,
      active: 0,
      threads: [],
    };
    summary.total += 1;
    if (thread.latestTurn?.state === "running") summary.active += 1;
    if (input.includeThreadMetadata) summary.threads.push(thread);
    threadsByProject.set(thread.projectId, summary);
  }

  return input.projects
    .filter((project) => input.allowedProjectIds.has(project.id))
    .map((project) => {
      const summary = threadsByProject.get(project.id);
      return {
        projectId: project.id,
        title: project.title,
        path: project.workspaceRoot,
        threads: { total: summary?.total ?? 0, active: summary?.active ?? 0 },
        ...(input.includeThreadMetadata
          ? {
              recentThreads: [...(summary?.threads ?? [])]
                .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
                .slice(0, MAX_RECENT_THREADS)
                .map((thread) => ({
                  threadId: thread.id,
                  title: thread.title,
                  state: thread.latestTurn?.state ?? "idle",
                  updatedAt: thread.updatedAt,
                })),
            }
          : {}),
      };
    });
}

export function buildExternalMcpOverviewNextSteps(
  capabilities: ReadonlySet<ExternalMcpCapability>,
): ReadonlyArray<string> {
  return [
    "Call synara_capabilities with a projectId to list the exact provider/model targets available to this integration.",
    ...(capabilities.has("tasks:create") ? ["Create work with synara_create_task."] : []),
    ...(capabilities.has("tasks:wait") ? ["Follow permitted work with synara_wait_for_task."] : []),
    ...(capabilities.has("tasks:read")
      ? ["Read permitted task results with synara_read_task."]
      : []),
  ];
}
