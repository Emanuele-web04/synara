// merge native provider metadata by local workspace identity, retaining each thread's source cwd
import path from "node:path";
import { setImmediate } from "node:timers/promises";

import type { ProjectId, ProjectImportProvider } from "@synara/contracts";
import { isWorkspaceRootWithin } from "@synara/shared/threadWorkspace";

import type {
  NativeImportSession,
  NativeProjectImportCatalog,
} from "../provider/projectImportTypes";
import {
  canonicalImportPath,
  findImportGitWorkspace,
  importDirectoryExists,
  importPathIdentity,
  projectImportKey,
} from "./projectImportPaths";

export interface ResolvedImportSession extends NativeImportSession {
  key: string;
  provider: ProjectImportProvider;
  sourceHome: string;
}

export interface ResolvedImportProject {
  key: string;
  title: string;
  workspaceRoot: string;
  directoryExists: boolean;
  existingProjectId: ProjectId | null;
  providers: ProjectImportProvider[];
  threads: ResolvedImportSession[];
}

interface ExistingProject {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly kind?: string | undefined;
  readonly deletedAt: string | null;
}

function isAbsoluteDirectory(value: string): boolean {
  return value.trim().length > 0 && !value.includes("\0") && path.isAbsolute(value);
}

function contains(root: string, cwd: string): boolean {
  return isWorkspaceRootWithin(cwd, root, { platform: process.platform });
}

function mostSpecificRoot(roots: ReadonlyArray<string>, cwd: string): string | undefined {
  return roots
    .filter((root) => contains(root, cwd))
    .toSorted(
      (left, right) => importPathIdentity(right).length - importPathIdentity(left).length,
    )[0];
}

function cachedLookup<T>(lookup: (value: string) => Promise<T>): (value: string) => Promise<T> {
  const cache = new Map<string, Promise<T>>();
  return (value) => {
    let result = cache.get(value);
    if (!result) {
      result = lookup(value);
      cache.set(value, result);
    }
    return result;
  };
}

export async function buildProjectImportCatalog(
  sources: ReadonlyArray<{ provider: ProjectImportProvider; catalog: NativeProjectImportCatalog }>,
  existingProjects: ReadonlyArray<ExistingProject>,
): Promise<ResolvedImportProject[]> {
  const canonical = cachedLookup(canonicalImportPath);
  const gitWorkspace = cachedLookup(findImportGitWorkspace);
  const directoryExists = cachedLookup(importDirectoryExists);
  const existingByRoot = new Map<string, ExistingProject>();
  for (const project of existingProjects) {
    if (
      project.deletedAt !== null ||
      (project.kind && project.kind !== "project") ||
      !isAbsoluteDirectory(project.workspaceRoot)
    )
      continue;
    const root = await canonical(project.workspaceRoot);
    // keep a deterministic existing destination even if an older db contains duplicate roots
    const identity = importPathIdentity(root);
    if (!existingByRoot.has(identity))
      existingByRoot.set(identity, { ...project, workspaceRoot: root });
  }
  const declaredRoots = new Map<string, { root: string; title: string }>();
  for (const { provider, catalog } of sources) {
    if (provider !== "codex" || !isAbsoluteDirectory(catalog.sourceHome)) continue;
    for (const project of catalog.projects) {
      for (const value of project.roots) {
        if (!isAbsoluteDirectory(value)) continue;
        const root = await canonical(value);
        const identity = importPathIdentity(root);
        if (!declaredRoots.has(identity))
          declaredRoots.set(identity, { root, title: project.title });
      }
    }
  }
  const inferenceRoots = [
    ...[...existingByRoot.values()].map((project) => project.workspaceRoot),
    ...[...declaredRoots.values()].map((project) => project.root),
  ];
  const projects = new Map<string, ResolvedImportProject>();
  const importedSessionKeys = new Set<string>();

  const derivedWorkspace = cachedLookup(async (cwd: string): Promise<string> => {
    const git = await gitWorkspace(cwd);
    const existing = mostSpecificRoot(inferenceRoots, cwd);
    if (!git) return existing ?? cwd;
    // saved Synara and explicitly declared Codex subprojects both outrank Git's root
    if (existing && contains(git.worktree ?? git.root, existing)) return existing;
    if (git.worktree) {
      const originalCwd = path.join(git.root, path.relative(git.worktree, cwd));
      const originalExisting = mostSpecificRoot(inferenceRoots, originalCwd);
      if (originalExisting && contains(git.root, originalExisting)) return originalExisting;
    }
    return canonical(git.root);
  });

  const ensureProject = async (root: string, title: string, provider: ProjectImportProvider) => {
    const identity = importPathIdentity(root);
    let project = projects.get(identity);
    if (!project) {
      const existing = existingByRoot.get(identity);
      project = {
        key: projectImportKey("project", identity),
        title: existing?.title ?? declaredRoots.get(identity)?.title ?? title,
        workspaceRoot: root,
        directoryExists: await directoryExists(root),
        existingProjectId: existing?.id ?? null,
        providers: [],
        threads: [],
      };
      projects.set(identity, project);
    }
    if (!project.providers.includes(provider)) project.providers.push(provider);
    return project;
  };

  let sessionCount = 0;
  for (const { provider, catalog } of sources) {
    if (!isAbsoluteDirectory(catalog.sourceHome)) continue;
    const sourceHome = await canonical(catalog.sourceHome);
    const sourceProjects = new Map<string, { title: string; roots: string[] }>();
    for (const sourceProject of catalog.projects) {
      const roots = new Map<string, string>();
      for (const sourceRoot of sourceProject.roots) {
        if (!isAbsoluteDirectory(sourceRoot)) continue;
        const physicalRoot = await canonical(sourceRoot);
        // Claude has no native project ids — its discovery groups are cwd hints
        const root =
          provider === "claudeAgent" ? await derivedWorkspace(physicalRoot) : physicalRoot;
        roots.set(importPathIdentity(root), root);
        await ensureProject(
          root,
          provider === "claudeAgent"
            ? path.basename(root) || sourceProject.title
            : sourceProject.title,
          provider,
        );
      }
      sourceProjects.set(sourceProject.id, {
        title: sourceProject.title,
        roots: [...roots.values()],
      });
    }

    for (const session of catalog.sessions) {
      if (++sessionCount % 128 === 0) await setImmediate();
      if (!session.id.trim() || !isAbsoluteDirectory(session.cwd)) continue;
      const key = projectImportKey(provider, sourceHome, session.id);
      if (importedSessionKeys.has(key)) continue;
      const cwd = await canonical(session.cwd);
      const sourceProject =
        provider === "codex" && session.projectId
          ? sourceProjects.get(session.projectId)
          : undefined;
      let root: string | undefined;
      if (sourceProject?.roots.length === 1) {
        // explicit assignment survives even after a temporary worktree is deleted
        root = sourceProject.roots[0];
      } else if (sourceProject && sourceProject.roots.length > 1) {
        root = mostSpecificRoot(sourceProject.roots, cwd);
        if (!root) {
          const git = await gitWorkspace(cwd);
          if (git?.worktree) {
            const originalCwd = path.join(git.root, path.relative(git.worktree, cwd));
            root = mostSpecificRoot(sourceProject.roots, originalCwd);
          }
        }
      }
      const assigned = root !== undefined;
      root ??= await derivedWorkspace(cwd);
      const title = assigned ? sourceProject!.title : path.basename(root) || root;
      const project = await ensureProject(root, title, provider);
      project.threads.push({ ...session, key, provider, sourceHome });
      importedSessionKeys.add(key);
    }
  }

  for (const project of projects.values()) {
    project.providers = project.providers.toSorted();
    project.threads = project.threads.toSorted(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) || left.key.localeCompare(right.key),
    );
  }
  return [...projects.values()].toSorted(
    (left, right) => left.title.localeCompare(right.title) || left.key.localeCompare(right.key),
  );
}
