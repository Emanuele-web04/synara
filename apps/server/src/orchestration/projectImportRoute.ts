import { homedir } from "node:os";
import nodePath from "node:path";
import {
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  ProjectId,
  ThreadId,
  type ImportProjectInput,
  type ImportProjectResult,
  type ListProjectImportsInput,
  type ListProjectImportsResult,
  type ProjectImportProvider,
  type ProviderStartOptions,
} from "@synara/contracts";
import { isWorkspaceRootWithin, workspaceRootsEqual } from "@synara/shared/threadWorkspace";
import { Effect } from "effect";
import type {
  ProjectImportRepository,
  ProjectImportOrigin,
} from "../persistence/projectImportRepository";
import { discoverClaudeProjects } from "../provider/claudeProjectImport";
import {
  discoverCodexProjects,
  resolveCodexProjectImportHome,
} from "../provider/codexProjectImport";
import { ensureProviderEnabled } from "../provider/enabledProviderAdapter";
import { makeKeyedLock } from "../provider/keyedLock";
import type { NativeProjectImportCatalog } from "../provider/projectImportTypes";
import type { ProviderAdapterRegistryShape } from "../provider/Services/ProviderAdapterRegistry";
import type { ProviderServiceShape } from "../provider/Services/ProviderService";
import type { ServerSettingsShape } from "../serverSettings";
import {
  buildProjectImportCatalog,
  type ResolvedImportProject,
  type ResolvedImportSession,
} from "./projectImportCatalog";
import {
  canonicalImportPath,
  findImportGitWorkspace,
  importDirectoryExists,
} from "./projectImportPaths";
import {
  makeProjectImportHistoryReader,
  nativeImportId,
  ProjectImportError,
  projectImportPromise,
} from "./projectImportHistory";
import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine";
import { makeProjectImportDestinations } from "./projectImportDestinations";

interface ProjectImportRouteOptions {
  readonly repository: ProjectImportRepository;
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly providerService: ProviderServiceShape;
  readonly providerAdapterRegistry: ProviderAdapterRegistryShape;
  readonly serverSettings: ServerSettingsShape;
  readonly discover?: (
    provider: ProjectImportProvider,
    homePath?: string,
  ) => Promise<NativeProjectImportCatalog>;
  readonly readHistory?: ReturnType<typeof makeProjectImportHistoryReader>;
}

const CATALOG_TTL_MS = 30 * 60 * 1000;

export function makeProjectImportHandlers(options: ProjectImportRouteOptions) {
  const projects = new Map<string, { project: ResolvedImportProject; expiresAt: number }>();
  const sessions = new Map<
    string,
    { session: ResolvedImportSession; projectKey: string; expiresAt: number }
  >();
  // one native copy at a time bounds subprocesses and serializes project creation + origin reservations across browser clients
  const imports = makeKeyedLock<string>();
  const readHistory =
    options.readHistory ?? makeProjectImportHistoryReader(options.providerAdapterRegistry);
  const discover =
    options.discover ??
    ((provider, homePath) =>
      provider === "codex"
        ? discoverCodexProjects(homePath ? { homePath } : undefined)
        : discoverClaudeProjects());

  const readKnownBindings = Effect.fn(function* (
    destinations: ReturnType<typeof makeProjectImportDestinations>,
  ) {
    const bindings = yield* options.repository.listNativeBindings();
    const known = new Map<string, { projectId: ProjectId; threadId: ThreadId }>();
    for (const binding of bindings) {
      if (binding.provider !== "codex" && binding.provider !== "claudeAgent") continue;
      const destination = destinations.findThread(binding.threadId);
      if (!destination) continue;
      let cursor: unknown;
      try {
        cursor = JSON.parse(binding.cursor ?? "null");
      } catch {
        continue;
      }
      const externalId = nativeImportId(binding.provider, cursor);
      if (externalId) known.set(`${binding.provider}:${externalId}`, destination);
    }
    return known;
  });

  const listProjectImports = Effect.fn(function* (input: ListProjectImportsInput) {
    const settings = yield* options.serverSettings.getSettings;
    const providers = [...new Set(input.providers)];
    const results = yield* Effect.forEach(
      providers,
      (provider) =>
        projectImportPromise(async () => {
          try {
            return {
              provider,
              catalog: await discover(
                provider,
                provider === "codex" ? settings.providers.codex.homePath : undefined,
              ),
              error: null,
            };
          } catch (error) {
            return {
              provider,
              catalog: null,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }),
      { concurrency: 2 },
    );
    const readModel = yield* options.orchestrationEngine.getReadModel();
    const destinations = makeProjectImportDestinations(readModel);
    const candidates = yield* projectImportPromise(() =>
      buildProjectImportCatalog(
        results.flatMap((result) =>
          result.catalog ? [{ provider: result.provider, catalog: result.catalog }] : [],
        ),
        readModel.projects,
      ),
    );
    const origins = new Map(
      (yield* options.repository.list()).flatMap((origin) => {
        const destination = destinations.findOrigin(origin);
        return destination ? [[destination.sourceKey, destination] as const] : [];
      }),
    );
    const known = yield* readKnownBindings(destinations);
    const now = Date.now();
    for (const [key, value] of projects) if (value.expiresAt < now) projects.delete(key);
    for (const [key, value] of sessions) if (value.expiresAt < now) sessions.delete(key);
    for (const project of candidates) {
      projects.set(project.key, { project, expiresAt: now + CATALOG_TTL_MS });
      for (const session of project.threads)
        sessions.set(session.key, {
          session,
          projectKey: project.key,
          expiresAt: now + CATALOG_TTL_MS,
        });
    }
    return {
      projects: candidates.map((project) => ({
        key: project.key,
        title: project.title,
        workspaceRoot: project.workspaceRoot,
        directoryExists: project.directoryExists,
        existingProjectId: project.existingProjectId,
        providers: project.providers,
        threads: project.threads.map((session) => ({
          key: session.key,
          provider: session.provider,
          title: session.title,
          cwd: session.cwd,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          archived: session.archived,
          alreadyImported:
            origins.get(session.key)?.status === "completed" ||
            (!origins.has(session.key) && known.has(`${session.provider}:${session.id}`)),
        })),
      })),
      sources: results.map(({ provider, error }) => ({ provider, error })),
    } satisfies ListProjectImportsResult;
  });

  const importProject = (input: ImportProjectInput) =>
    imports.withLock(
      "imports",
      Effect.gen(function* () {
        const cached = projects.get(input.projectKey);
        if (!cached || cached.expiresAt < Date.now())
          return yield* new ProjectImportError({
            message: "Refresh the project list before importing.",
          });
        const selected = input.threadKey ? sessions.get(input.threadKey) : undefined;
        if (
          input.threadKey &&
          (!selected || selected.projectKey !== input.projectKey || selected.expiresAt < Date.now())
        ) {
          return yield* new ProjectImportError({
            message: "This conversation is no longer in the project preview. Refresh the list.",
          });
        }
        const source = selected?.session;
        let model = yield* options.orchestrationEngine.getReadModel();
        const destinations = makeProjectImportDestinations(model);
        const storedOrigin = source ? yield* options.repository.find(source.key) : undefined;
        let origin = destinations.findOrigin(storedOrigin);
        if (origin?.status === "completed")
          return {
            projectId: origin.projectId,
            threadId: origin.threadId,
            status: "already-present",
          } satisfies ImportProjectResult;
        if (source && !origin) {
          const known = (yield* readKnownBindings(destinations)).get(
            `${source.provider}:${source.id}`,
          );
          if (known) return { ...known, status: "already-present" } satisfies ImportProjectResult;
        }
        if (source) {
          yield* ensureProviderEnabled(source.provider, options.serverSettings);
          const settings = yield* options.serverSettings.getSettings;
          const currentHome = yield* projectImportPromise(() =>
            source.provider === "codex"
              ? resolveCodexProjectImportHome({ homePath: settings.providers.codex.homePath })
              : canonicalImportPath(
                  process.env.CLAUDE_CONFIG_DIR?.trim() || nodePath.join(homedir(), ".claude"),
                ),
          );
          if (
            !workspaceRootsEqual(currentHome, source.sourceHome, { platform: process.platform }) &&
            !options.discover
          ) {
            return yield* new ProjectImportError({
              message: "The provider's storage location changed. Refresh the project list.",
            });
          }
        }
        const rawRoot = input.workspaceRoot?.trim() || cached.project.workspaceRoot;
        const expandedRoot = rawRoot.startsWith("~/")
          ? nodePath.join(homedir(), rawRoot.slice(2))
          : rawRoot;
        if (!nodePath.isAbsolute(expandedRoot))
          return yield* new ProjectImportError({
            message: "Choose an absolute project folder path.",
          });
        const workspaceRoot = yield* projectImportPromise(() => canonicalImportPath(expandedRoot));
        const directoryExists = yield* projectImportPromise(() =>
          importDirectoryExists(workspaceRoot),
        );
        if (input.workspaceRoot && !directoryExists)
          return yield* new ProjectImportError({
            message: "The selected project folder does not exist.",
          });
        const reservedProjectId = origin?.projectId;
        const findExistingProject = () =>
          projectImportPromise(async () => {
            for (const entry of model.projects) {
              if ((entry.kind ?? "project") !== "project" || entry.deletedAt !== null) continue;
              const root = await canonicalImportPath(entry.workspaceRoot);
              if (workspaceRootsEqual(root, workspaceRoot, { platform: process.platform }))
                return entry;
            }
            return undefined;
          });
        let project = reservedProjectId
          ? model.projects.find(
              (entry) => entry.id === reservedProjectId && entry.deletedAt === null,
            )
          : yield* findExistingProject();
        if (origin && !project)
          return yield* new ProjectImportError({
            message: "The destination project was removed while this import was pending.",
          });
        if (origin && project) {
          const reservedWorkspaceRoot = project.workspaceRoot;
          const reservedRoot = yield* projectImportPromise(() =>
            canonicalImportPath(reservedWorkspaceRoot),
          );
          if (!workspaceRootsEqual(reservedRoot, workspaceRoot, { platform: process.platform }))
            return yield* new ProjectImportError({
              message: `This interrupted import keeps its original destination. Retry using ${project.workspaceRoot}.`,
            });
        }
        if (!project) {
          const projectId = ProjectId.makeUnsafe(crypto.randomUUID());
          const createResult = yield* Effect.result(
            options.orchestrationEngine.dispatch({
              type: "project.create",
              commandId: CommandId.makeUnsafe(crypto.randomUUID()),
              projectId,
              title: cached.project.title,
              workspaceRoot,
              kind: "project",
              defaultModelSelection: null,
              preserveExistingProject: true,
              ...(input.spaceId !== undefined ? { spaceId: input.spaceId } : {}),
              createdAt: new Date().toISOString(),
            }),
          );
          model = yield* options.orchestrationEngine.getReadModel();
          project = model.projects.find((entry) => entry.id === projectId);
          if (createResult._tag === "Failure") {
            project = yield* findExistingProject();
            if (!project) return yield* Effect.fail(createResult.failure);
          }
          if (!project)
            return yield* new ProjectImportError({
              message: "The imported project could not be loaded.",
            });
        }
        if (!source)
          return {
            projectId: project.id,
            threadId: null,
            status: "project-linked",
          } satisfies ImportProjectResult;
        if (
          !options.providerService.importExternalThread ||
          !options.providerService.stopRuntimeSession
        ) {
          return yield* new ProjectImportError({
            message: "Native conversation copying is unavailable.",
          });
        }
        const createdAt = new Date().toISOString();
        if (!origin) {
          origin = {
            sourceKey: source.key,
            provider: source.provider,
            sourceHome: source.sourceHome,
            externalId: source.id,
            projectId: project.id,
            threadId: ThreadId.makeUnsafe(crypto.randomUUID()),
            status: "pending",
            createdAt,
          } satisfies ProjectImportOrigin;
          const reserved = yield* options.repository.reserve(origin, storedOrigin?.threadId);
          if (!reserved)
            return yield* new ProjectImportError({
              message: "The import destination changed. Refresh the project list and retry.",
            });
        }
        const threadId = origin.threadId;
        const existingThread = model.threads.find((entry) => entry.id === threadId);
        if (existingThread?.deletedAt)
          return yield* new ProjectImportError({
            message: "The import destination was removed. Retry to create a new conversation copy.",
          });
        const modelSelection =
          project.defaultModelSelection?.provider === source.provider
            ? project.defaultModelSelection
            : { provider: source.provider, model: DEFAULT_MODEL_BY_PROVIDER[source.provider] };
        const sourceDirectoryExists = yield* projectImportPromise(() =>
          importDirectoryExists(source.cwd),
        );
        const sourceWorkingDirectory = sourceDirectoryExists
          ? yield* projectImportPromise(() => canonicalImportPath(source.cwd))
          : null;
        const workspace = sourceWorkingDirectory
          ? yield* projectImportPromise(() => findImportGitWorkspace(sourceWorkingDirectory))
          : null;
        const relinkedWorkspace = !workspaceRootsEqual(
          workspaceRoot,
          cached.project.workspaceRoot,
          {
            platform: process.platform,
          },
        );
        const originalWorkingDirectory =
          workspace?.worktree && sourceWorkingDirectory
            ? nodePath.join(
                workspace.root,
                nodePath.relative(workspace.worktree, sourceWorkingDirectory),
              )
            : sourceWorkingDirectory;
        const worktreePath =
          !relinkedWorkspace &&
          workspace?.worktree &&
          originalWorkingDirectory &&
          isWorkspaceRootWithin(originalWorkingDirectory, workspaceRoot, {
            platform: process.platform,
          })
            ? workspace.worktree
            : null;
        const workingDirectory =
          !relinkedWorkspace &&
          sourceWorkingDirectory &&
          (worktreePath ||
            isWorkspaceRootWithin(sourceWorkingDirectory, workspaceRoot, {
              platform: process.platform,
            }))
            ? sourceWorkingDirectory
            : null;
        if (!existingThread) {
          yield* options.orchestrationEngine.dispatch({
            type: "thread.create",
            commandId: CommandId.makeUnsafe(`project-import:${threadId}:create`),
            threadId,
            projectId: project.id,
            title: source.title,
            modelSelection,
            runtimeMode: "approval-required",
            interactionMode: "default",
            envMode: worktreePath ? "worktree" : "local",
            branch: null,
            worktreePath,
            ...(workingDirectory ? { workingDirectory } : {}),
            createdAt: source.createdAt,
          });
        }
        const settings = yield* options.serverSettings.getSettings;
        const providerOptions: ProviderStartOptions =
          source.provider === "codex"
            ? {
                codex: {
                  binaryPath: settings.providers.codex.binaryPath,
                  homePath: settings.providers.codex.homePath,
                },
              }
            : { claudeAgent: { binaryPath: settings.providers.claudeAgent.binaryPath } };
        const runtimeCwd = workingDirectory ?? (directoryExists ? workspaceRoot : undefined);
        // the ledger and native binding survive failures — retrying the same origin resumes this frozen copy while deterministic ids prevent replay
        const importHistory = Effect.gen(function* () {
          const copied = yield* options.providerService.importExternalThread!({
            threadId,
            provider: source.provider,
            externalThreadId: source.id,
            sourceCwd: source.cwd,
            ...(runtimeCwd ? { cwd: runtimeCwd } : {}),
            modelSelection,
            runtimeMode: "approval-required",
            providerOptions,
          });
          const nativeId = nativeImportId(source.provider, copied.resumeCursor);
          if (!nativeId || nativeId === source.id)
            return yield* new ProjectImportError({
              message: "The provider did not create an independent conversation copy.",
            });
          const messages = yield* readHistory({
            provider: source.provider,
            threadId,
            nativeId,
            sourceHome: source.sourceHome,
            sourceCwd: source.cwd,
            sourceCreatedAt: source.createdAt,
            providerOptions,
            ...(runtimeCwd ? { cwd: runtimeCwd } : {}),
          });
          for (let offset = 0; offset < messages.length; offset += 100) {
            yield* options.orchestrationEngine.dispatch({
              type: "thread.messages.import",
              commandId: CommandId.makeUnsafe(`project-import:${threadId}:messages:${offset}`),
              threadId,
              messages: messages.slice(offset, offset + 100),
              createdAt: origin!.createdAt,
            });
          }
        });
        // cleanup failure must surface — can't be reported as success with an unproven provider process still attached
        yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const result = yield* Effect.exit(restore(importHistory));
            yield* options.providerService.stopRuntimeSession!({ threadId });
            yield* result;
          }),
        );
        yield* options.orchestrationEngine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          threadId,
          session: {
            threadId,
            providerName: source.provider,
            status: "stopped",
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        });
        if (source.archived)
          yield* options.orchestrationEngine.dispatch({
            type: "thread.archive",
            commandId: CommandId.makeUnsafe(`project-import:${threadId}:archive`),
            threadId,
          });
        yield* options.repository.complete(source.key);
        return {
          projectId: project.id,
          threadId,
          status: "imported",
        } satisfies ImportProjectResult;
      }),
    );
  return { listProjectImports, importProject };
}
