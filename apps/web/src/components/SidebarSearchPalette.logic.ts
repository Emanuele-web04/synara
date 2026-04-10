import { basenameOfPath } from "../vscode-icons";

export interface SidebarSearchAction {
  id: string;
  label: string;
  description: string;
  keywords?: readonly string[];
  shortcutLabel?: string | null;
}

export interface SidebarSearchProject {
  id: string;
  name: string;
  cwd: string;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
}

export interface SidebarSearchProjectMatch {
  id: string;
  project: SidebarSearchProject;
}

export interface SidebarSearchThread {
  id: string;
  title: string;
  projectId: string;
  projectName: string;
  provider: "codex" | "claudeAgent";
  createdAt: string;
  updatedAt?: string | undefined;
}

export interface SidebarSearchThreadMatch {
  id: string;
  thread: SidebarSearchThread;
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

function scoreAction(action: SidebarSearchAction, query: string): number | null {
  if (!query) return 0;

  const label = normalizeText(action.label);
  const description = normalizeText(action.description);
  const keywords = (action.keywords ?? []).map(normalizeText);

  if (label === query) return 140;
  if (label.startsWith(query)) return 120;
  if (keywords.some((keyword) => keyword === query)) return 110;
  if (label.includes(query)) return 100;
  if (keywords.some((keyword) => keyword.includes(query))) return 90;
  if (description.includes(query)) return 70;
  return null;
}

function scoreProject(project: SidebarSearchProject, query: string): number | null {
  if (!query) return null;

  const name = normalizeText(project.name);
  const cwd = normalizeText(project.cwd);
  const folder = normalizeText(basenameOfPath(project.cwd));

  if (name === query) return 150;
  if (folder === query) return 145;
  if (name.startsWith(query)) return 130;
  if (folder.startsWith(query)) return 120;
  if (name.includes(query)) return 105;
  if (folder.includes(query)) return 95;
  if (cwd.includes(query)) return 70;
  return null;
}

function scoreThread(thread: SidebarSearchThread, query: string): number | null {
  if (!query) return null;

  const title = normalizeText(thread.title);
  const projectName = normalizeText(thread.projectName);

  if (title === query) return 170;
  if (title.startsWith(query)) return 145;
  if (title.includes(query)) return 125;
  if (projectName.startsWith(query)) return 80;
  if (projectName.includes(query)) return 65;
  return null;
}

export function matchSidebarSearchActions(
  actions: readonly SidebarSearchAction[],
  query: string,
): SidebarSearchAction[] {
  const normalizedQuery = normalizeText(query);

  return actions
    .map((action, index) => ({
      action,
      index,
      score: scoreAction(action, normalizedQuery),
    }))
    .filter((candidate) => candidate.score !== null)
    .toSorted((left, right) => {
      if (left.score !== right.score) return (right.score ?? 0) - (left.score ?? 0);
      return left.index - right.index;
    })
    .map((candidate) => candidate.action);
}

export function matchSidebarSearchProjects(
  projects: readonly SidebarSearchProject[],
  query: string,
  limit = 6,
): SidebarSearchProjectMatch[] {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return [];

  return projects
    .map((project) => ({
      id: `project:${project.id}`,
      project,
      score: scoreProject(project, normalizedQuery),
      recency: Date.parse(project.updatedAt ?? project.createdAt ?? "") || 0,
    }))
    .filter((candidate) => candidate.score !== null)
    .toSorted((left, right) => {
      if (left.score !== right.score) return (right.score ?? 0) - (left.score ?? 0);
      if (left.recency !== right.recency) return right.recency - left.recency;
      return left.project.name.localeCompare(right.project.name);
    })
    .slice(0, limit)
    .map(({ id, project }) => ({ id, project }));
}

export function matchSidebarSearchThreads(
  threads: readonly SidebarSearchThread[],
  query: string,
  limit = 8,
): SidebarSearchThreadMatch[] {
  const normalizedQuery = normalizeText(query);

  if (!normalizedQuery) {
    return threads
      .map((thread) => ({
        id: `thread:${thread.id}`,
        thread,
        recency: Date.parse(thread.updatedAt ?? thread.createdAt) || 0,
      }))
      .toSorted((left, right) => right.recency - left.recency)
      .slice(0, 3)
      .map(({ id, thread }) => ({ id, thread }));
  }

  return threads
    .map((thread, index) => ({
      id: `thread:${thread.id}`,
      thread,
      index,
      score: scoreThread(thread, normalizedQuery),
      recency: Date.parse(thread.updatedAt ?? thread.createdAt) || 0,
      titleLength: thread.title.length,
    }))
    .filter((candidate) => candidate.score !== null)
    .toSorted((left, right) => {
      if (left.score !== right.score) return (right.score ?? 0) - (left.score ?? 0);
      if (left.recency !== right.recency) return right.recency - left.recency;
      if (left.titleLength !== right.titleLength) return left.titleLength - right.titleLength;
      return left.index - right.index;
    })
    .slice(0, limit)
    .map(({ id, thread }) => ({ id, thread }));
}

export function hasSidebarSearchResults(input: {
  actions: readonly SidebarSearchAction[];
  projects: readonly SidebarSearchProjectMatch[];
  threads: readonly SidebarSearchThreadMatch[];
}): boolean {
  return input.actions.length > 0 || input.projects.length > 0 || input.threads.length > 0;
}
