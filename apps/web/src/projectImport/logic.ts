import type {
  ImportProjectInput,
  ProjectImportProject,
  ProjectImportProvider,
} from "@synara/contracts";

export const IMPORT_PROVIDERS: readonly ProjectImportProvider[] = ["codex", "claudeAgent"];
export const IMPORT_PROVIDER_LABELS: Record<ProjectImportProvider, string> = {
  codex: "Codex",
  claudeAgent: "Claude Code",
};

export interface ProjectImportQueueItem {
  readonly key: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly input: ImportProjectInput;
}

export function projectImportItemKey(projectKey: string, threadKey: string | null): string {
  return JSON.stringify([projectKey, threadKey]);
}

export function selectableProjectImportKeys(
  project: ProjectImportProject,
  includeArchived: boolean,
): string[] {
  if (project.threads.length === 0) {
    return project.existingProjectId ? [] : [projectImportItemKey(project.key, null)];
  }
  return project.threads
    .filter((thread) => !thread.alreadyImported && (includeArchived || !thread.archived))
    .map((thread) => projectImportItemKey(project.key, thread.key));
}

export function buildProjectImportQueue(options: {
  readonly projects: readonly ProjectImportProject[];
  readonly selected: ReadonlySet<string>;
  readonly includeArchived: boolean;
  readonly workspaceRoots: Readonly<Record<string, string>>;
}): ProjectImportQueueItem[] {
  return options.projects.flatMap((project) => {
    const workspaceRoot = options.workspaceRoots[project.key]?.trim();
    const keys = new Set(selectableProjectImportKeys(project, options.includeArchived));
    const threads = project.threads.length === 0 ? [null] : project.threads;
    return threads.flatMap((thread) => {
      const key = projectImportItemKey(project.key, thread?.key ?? null);
      if (!keys.has(key) || !options.selected.has(key)) return [];
      return [
        {
          key,
          title: thread
            ? `${project.title} · ${thread.title || "Untitled conversation"}`
            : project.title,
          workspaceRoot: workspaceRoot || project.workspaceRoot,
          input: {
            projectKey: project.key,
            threadKey: thread?.key ?? null,
            ...(workspaceRoot ? { workspaceRoot } : {}),
            spaceId: null,
          },
        },
      ];
    });
  });
}
