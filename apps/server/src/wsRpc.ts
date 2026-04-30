import { realpathSync } from "node:fs";

import {
  CommandId,
  ORCHESTRATION_WS_METHODS,
  ThreadId,
  WS_METHODS,
  WsRpcError,
  WsRpcGroup,
  type GitActionProgressEvent,
  type OrchestrationEvent,
  type OrchestrationShellStreamEvent,
  type OrchestrationThreadStreamItem,
  type ServerConfigStreamEvent,
  type ServerLifecycleStreamEvent,
} from "@t3tools/contracts";
import { clamp } from "effect/Number";
import { Effect, FileSystem, Layer, Option, Path, Queue, Schema, Stream } from "effect";
import { HttpRouter, HttpServerRequest } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

import { authErrorResponse, makeEffectAuthRequest } from "./auth/http";
import { ServerAuth } from "./auth/Services/ServerAuth";
import { SessionCredentialService } from "./auth/Services/SessionCredentialService";
import { CheckpointDiffQuery } from "./checkpointing/Services/CheckpointDiffQuery";
import { ServerConfig } from "./config";
import { GitCore } from "./git/Services/GitCore";
import { GitManager } from "./git/Services/GitManager";
import { GitStatusBroadcaster } from "./git/Services/GitStatusBroadcaster";
import { Keybindings } from "./keybindings";
import { Open, resolveAvailableEditors } from "./open";
import { makeDispatchCommandNormalizer } from "./orchestration/dispatchCommandNormalization";
import { makeImportThreadHandler } from "./orchestration/importThreadRoute";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { ProviderDiscoveryService } from "./provider/Services/ProviderDiscoveryService";
import { ProviderAdapterRegistry } from "./provider/Services/ProviderAdapterRegistry";
import { ProviderHealth } from "./provider/Services/ProviderHealth";
import { ProviderService } from "./provider/Services/ProviderService";
import { getProviderUsageSnapshot } from "./providerUsageSnapshot";
import { ServerEnvironment } from "./environment/Services/ServerEnvironment";
import { ServerLifecycleEvents } from "./serverLifecycleEvents";
import { ServerRuntimeStartup } from "./serverRuntimeStartup";
import { ServerSettingsService } from "./serverSettings";
import { TerminalManager } from "./terminal/Services/Manager";
import { WorkspaceEntries } from "./workspace/Services/WorkspaceEntries";
import { WorkspaceFileSystem } from "./workspace/Services/WorkspaceFileSystem";

function toWsRpcError(cause: unknown, fallbackMessage: string) {
  return Schema.is(WsRpcError)(cause)
    ? cause
    : new WsRpcError({
        message:
          cause instanceof Error && cause.message.length > 0 ? cause.message : fallbackMessage,
        cause,
      });
}

function isThreadDetailEvent(event: OrchestrationEvent): event is Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.message-sent"
      | "thread.proposed-plan-upserted"
      | "thread.activity-appended"
      | "thread.turn-diff-completed"
      | "thread.reverted"
      | "thread.conversation-rolled-back"
      | "thread.session-set";
  }
> {
  return (
    event.type === "thread.message-sent" ||
    event.type === "thread.proposed-plan-upserted" ||
    event.type === "thread.activity-appended" ||
    event.type === "thread.turn-diff-completed" ||
    event.type === "thread.reverted" ||
    event.type === "thread.conversation-rolled-back" ||
    event.type === "thread.session-set"
  );
}

export const makeWsRpcLayer = () =>
  WsRpcGroup.toLayer(
    Effect.gen(function* () {
      const checkpointDiffQuery = yield* CheckpointDiffQuery;
      const config = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const git = yield* GitCore;
      const gitManager = yield* GitManager;
      const gitStatusBroadcaster = yield* GitStatusBroadcaster;
      const keybindings = yield* Keybindings;
      const open = yield* Open;
      const orchestrationEngine = yield* OrchestrationEngineService;
      const path = yield* Path.Path;
      const projectionReadModelQuery = yield* ProjectionSnapshotQuery;
      const providerAdapterRegistry = yield* ProviderAdapterRegistry;
      const providerDiscoveryService = yield* ProviderDiscoveryService;
      const providerHealth = yield* ProviderHealth;
      const providerService = yield* ProviderService;
      const lifecycleEvents = yield* ServerLifecycleEvents;
      const runtimeStartup = yield* ServerRuntimeStartup;
      const serverEnvironment = yield* ServerEnvironment;
      const serverSettings = yield* ServerSettingsService;
      const terminalManager = yield* TerminalManager;
      const workspaceEntries = yield* WorkspaceEntries;
      const workspaceFileSystem = yield* WorkspaceFileSystem;

      const canonicalizeProjectWorkspaceRoot = Effect.fnUntraced(function* (
        workspaceRoot: string,
        options: { readonly createIfMissing?: boolean } = {},
      ) {
        const rawWorkspaceRoot = workspaceRoot.trim();
        const expandedWorkspaceRoot =
          rawWorkspaceRoot === "~"
            ? config.homeDir
            : rawWorkspaceRoot.startsWith("~/") || rawWorkspaceRoot.startsWith("~\\")
              ? path.join(config.homeDir, rawWorkspaceRoot.slice(2))
              : rawWorkspaceRoot;
        const normalizedWorkspaceRoot = path.resolve(expandedWorkspaceRoot);
        let workspaceStat = yield* fileSystem
          .stat(normalizedWorkspaceRoot)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (!workspaceStat) {
          if (!options.createIfMissing) {
            return yield* new WsRpcError({
              message: `Project directory does not exist: ${normalizedWorkspaceRoot}`,
            });
          }
          yield* fileSystem.makeDirectory(normalizedWorkspaceRoot, { recursive: true }).pipe(
            Effect.mapError(
              (cause) =>
                new WsRpcError({
                  message: `Failed to create project directory: ${normalizedWorkspaceRoot}`,
                  cause,
                }),
            ),
          );
          workspaceStat = yield* fileSystem
            .stat(normalizedWorkspaceRoot)
            .pipe(Effect.catch(() => Effect.succeed(null)));
          if (!workspaceStat) {
            return yield* new WsRpcError({
              message: `Failed to create project directory: ${normalizedWorkspaceRoot}`,
            });
          }
        }
        if (workspaceStat.type !== "Directory") {
          return yield* new WsRpcError({
            message: `Project path is not a directory: ${normalizedWorkspaceRoot}`,
          });
        }
        try {
          return realpathSync.native(normalizedWorkspaceRoot);
        } catch {
          return normalizedWorkspaceRoot;
        }
      });

      const normalizeDispatchCommand = makeDispatchCommandNormalizer<WsRpcError>({
        attachmentsDir: config.attachmentsDir,
        fileSystem,
        path,
        canonicalizeProjectWorkspaceRoot,
      });

      const importThread = makeImportThreadHandler({
        fileSystem,
        orchestrationEngine,
        path,
        platform: process.platform,
        providerAdapterRegistry,
        providerService,
      });

      const loadServerConfig = Effect.gen(function* () {
        const keybindingsConfig = yield* keybindings.loadConfigState;
        const providerStatuses = yield* providerHealth.getStatuses;
        return {
          cwd: config.cwd,
          homeDir: config.homeDir,
          worktreesDir: config.worktreesDir,
          keybindingsConfigPath: config.keybindingsConfigPath,
          keybindings: keybindingsConfig.keybindings,
          issues: keybindingsConfig.issues,
          providers: providerStatuses,
          availableEditors: resolveAvailableEditors(),
        };
      });

      const refreshGitStatus = (cwd: string) =>
        gitStatusBroadcaster.refreshStatus(cwd).pipe(Effect.catchCause(() => Effect.void));

      const toShellStreamEvent = (
        event: OrchestrationEvent,
      ): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, never> => {
        switch (event.type) {
          case "project.created":
          case "project.meta-updated":
            return projectionReadModelQuery.getProjectShellById(event.payload.projectId).pipe(
              Effect.map((project) =>
                Option.map(project, (nextProject) => ({
                  kind: "project-upserted" as const,
                  sequence: event.sequence,
                  project: nextProject,
                })),
              ),
              Effect.catch(() => Effect.succeed(Option.none())),
            );
          case "project.deleted":
            return Effect.succeed(
              Option.some({
                kind: "project-removed" as const,
                sequence: event.sequence,
                projectId: event.payload.projectId,
              }),
            );
          case "thread.deleted":
            return Effect.succeed(
              Option.some({
                kind: "thread-removed" as const,
                sequence: event.sequence,
                threadId: event.payload.threadId,
              }),
            );
          default:
            if (event.aggregateKind !== "thread") return Effect.succeed(Option.none());
            return projectionReadModelQuery
              .getThreadShellById(ThreadId.makeUnsafe(String(event.aggregateId)))
              .pipe(
                Effect.map((thread) =>
                  Option.map(thread, (nextThread) => ({
                    kind: "thread-upserted" as const,
                    sequence: event.sequence,
                    thread: nextThread,
                  })),
                ),
                Effect.catch(() => Effect.succeed(Option.none())),
              );
        }
      };

      const rpcEffect = <A, E, R>(effect: Effect.Effect<A, E, R>, fallbackMessage: string) =>
        effect.pipe(Effect.mapError((cause) => toWsRpcError(cause, fallbackMessage)));

      return WsRpcGroup.of({
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command) =>
          rpcEffect(
            Effect.gen(function* () {
              const normalizedCommand = yield* normalizeDispatchCommand({ command });
              return yield* runtimeStartup.enqueueCommand(
                orchestrationEngine.dispatch(normalizedCommand),
              );
            }),
            "Failed to dispatch orchestration command",
          ),
        [ORCHESTRATION_WS_METHODS.importThread]: (input) =>
          rpcEffect(importThread(input), "Failed to import thread"),
        [ORCHESTRATION_WS_METHODS.getSnapshot]: () =>
          rpcEffect(
            projectionReadModelQuery.getSnapshot(),
            "Failed to load orchestration snapshot",
          ),
        [ORCHESTRATION_WS_METHODS.repairState]: () =>
          rpcEffect(orchestrationEngine.repairState(), "Failed to repair orchestration state"),
        [ORCHESTRATION_WS_METHODS.getTurnDiff]: (input) =>
          rpcEffect(checkpointDiffQuery.getTurnDiff(input), "Failed to load turn diff"),
        [ORCHESTRATION_WS_METHODS.getFullThreadDiff]: (input) =>
          rpcEffect(
            checkpointDiffQuery.getFullThreadDiff(input),
            "Failed to load full thread diff",
          ),
        [ORCHESTRATION_WS_METHODS.replayEvents]: (input) =>
          rpcEffect(
            Stream.runCollect(
              orchestrationEngine.readEvents(
                clamp(input.fromSequenceExclusive, {
                  maximum: Number.MAX_SAFE_INTEGER,
                  minimum: 0,
                }),
              ),
            ).pipe(Effect.map((events) => Array.from(events))),
            "Failed to replay orchestration events",
          ),
        [ORCHESTRATION_WS_METHODS.subscribeShell]: () =>
          Stream.concat(
            Stream.fromEffect(
              projectionReadModelQuery.getShellSnapshot().pipe(
                Effect.map((snapshot) => ({ kind: "snapshot" as const, snapshot })),
                Effect.mapError((cause) => toWsRpcError(cause, "Failed to load shell snapshot")),
              ),
            ),
            orchestrationEngine.streamDomainEvents.pipe(
              Stream.mapEffect(toShellStreamEvent),
              Stream.flatMap((event) =>
                Option.isSome(event) ? Stream.succeed(event.value) : Stream.empty,
              ),
            ),
          ),
        [ORCHESTRATION_WS_METHODS.unsubscribeShell]: () => Effect.void,
        [ORCHESTRATION_WS_METHODS.subscribeThread]: (input) =>
          Stream.concat(
            Stream.fromEffect(
              Effect.all([
                projectionReadModelQuery.getThreadDetailById(input.threadId),
                orchestrationEngine
                  .getReadModel()
                  .pipe(Effect.map((model) => model.snapshotSequence)),
              ]).pipe(
                Effect.flatMap(([thread, snapshotSequence]) =>
                  Option.isSome(thread)
                    ? Effect.succeed({
                        kind: "snapshot" as const,
                        snapshot: { snapshotSequence, thread: thread.value },
                      })
                    : Effect.fail(
                        new WsRpcError({ message: `Thread ${input.threadId} was not found` }),
                      ),
                ),
                Effect.mapError((cause) => toWsRpcError(cause, "Failed to load thread snapshot")),
              ),
            ),
            orchestrationEngine.streamDomainEvents.pipe(
              Stream.filter(
                (event): event is OrchestrationEvent & { readonly aggregateKind: "thread" } =>
                  event.aggregateKind === "thread" &&
                  event.aggregateId === input.threadId &&
                  isThreadDetailEvent(event),
              ),
              Stream.map(
                (event): OrchestrationThreadStreamItem => ({
                  kind: "event",
                  event,
                }),
              ),
            ),
          ),
        [ORCHESTRATION_WS_METHODS.unsubscribeThread]: () => Effect.void,
        [WS_METHODS.subscribeOrchestrationDomainEvents]: () =>
          orchestrationEngine.streamDomainEvents,

        [WS_METHODS.projectsListDirectories]: (input) =>
          rpcEffect(
            workspaceEntries.listDirectories(input),
            "Failed to list workspace directories",
          ),
        [WS_METHODS.projectsSearchEntries]: (input) =>
          rpcEffect(workspaceEntries.search(input), "Failed to search workspace entries"),
        [WS_METHODS.projectsSearchLocalEntries]: (input) =>
          rpcEffect(workspaceEntries.searchLocal(input), "Failed to search local entries"),
        [WS_METHODS.projectsWriteFile]: (input) =>
          rpcEffect(workspaceFileSystem.writeFile(input), "Failed to write workspace file"),
        [WS_METHODS.filesystemBrowse]: (input) =>
          rpcEffect(workspaceEntries.browse(input), "Failed to browse filesystem"),
        [WS_METHODS.shellOpenInEditor]: (input) =>
          rpcEffect(open.openInEditor(input), "Failed to open editor"),

        [WS_METHODS.gitStatus]: (input) =>
          rpcEffect(gitStatusBroadcaster.getStatus(input), "Failed to read git status"),
        [WS_METHODS.gitReadWorkingTreeDiff]: (input) =>
          rpcEffect(gitManager.readWorkingTreeDiff(input), "Failed to read working tree diff"),
        [WS_METHODS.gitSummarizeDiff]: (input) =>
          rpcEffect(gitManager.summarizeDiff(input), "Failed to summarize diff"),
        [WS_METHODS.gitPull]: (input) =>
          rpcEffect(
            git.pullCurrentBranch(input.cwd).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            "Failed to pull branch",
          ),
        [WS_METHODS.gitRunStackedAction]: (input) =>
          Stream.callback<GitActionProgressEvent, WsRpcError>((queue) =>
            gitManager
              .runStackedAction(input, {
                actionId: input.actionId,
                progressReporter: {
                  publish: (event) => Queue.offer(queue, event).pipe(Effect.asVoid),
                },
              })
              .pipe(
                Effect.tap(() => refreshGitStatus(input.cwd)),
                Effect.matchCauseEffect({
                  onFailure: (cause) => Queue.fail(queue, toWsRpcError(cause, "Git action failed")),
                  onSuccess: () => Queue.end(queue).pipe(Effect.asVoid),
                }),
              ),
          ),
        [WS_METHODS.gitResolvePullRequest]: (input) =>
          rpcEffect(gitManager.resolvePullRequest(input), "Failed to resolve pull request"),
        [WS_METHODS.gitPreparePullRequestThread]: (input) =>
          rpcEffect(
            gitManager
              .preparePullRequestThread(input)
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            "Failed to prepare pull request thread",
          ),
        [WS_METHODS.gitListBranches]: (input) =>
          rpcEffect(git.listBranches(input), "Failed to list branches"),
        [WS_METHODS.gitCreateWorktree]: (input) =>
          rpcEffect(
            git.createWorktree(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            "Failed to create worktree",
          ),
        [WS_METHODS.gitCreateDetachedWorktree]: (input) =>
          rpcEffect(
            git.createDetachedWorktree(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            "Failed to create detached worktree",
          ),
        [WS_METHODS.gitRemoveWorktree]: (input) =>
          rpcEffect(
            git.removeWorktree(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            "Failed to remove worktree",
          ),
        [WS_METHODS.gitCreateBranch]: (input) =>
          rpcEffect(
            git.createBranch(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            "Failed to create branch",
          ),
        [WS_METHODS.gitCheckout]: (input) =>
          rpcEffect(
            Effect.scoped(git.checkoutBranch(input)).pipe(
              Effect.tap(() => refreshGitStatus(input.cwd)),
            ),
            "Failed to checkout branch",
          ),
        [WS_METHODS.gitStashAndCheckout]: (input) =>
          rpcEffect(
            Effect.scoped(git.stashAndCheckout(input)).pipe(
              Effect.tap(() => refreshGitStatus(input.cwd)),
            ),
            "Failed to stash and checkout",
          ),
        [WS_METHODS.gitStashDrop]: (input) =>
          rpcEffect(
            git.stashDrop(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            "Failed to drop stash",
          ),
        [WS_METHODS.gitStashInfo]: (input) =>
          rpcEffect(git.stashInfo(input), "Failed to read stash"),
        [WS_METHODS.gitRemoveIndexLock]: (input) =>
          rpcEffect(git.removeIndexLock(input), "Failed to remove Git index lock"),
        [WS_METHODS.gitInit]: (input) =>
          rpcEffect(
            git.initRepo(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            "Failed to initialize repository",
          ),
        [WS_METHODS.gitHandoffThread]: (input) =>
          rpcEffect(
            gitManager.handoffThread(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            "Failed to hand off thread",
          ),

        [WS_METHODS.terminalOpen]: (input) =>
          rpcEffect(terminalManager.open(input), "Failed to open terminal"),
        [WS_METHODS.terminalWrite]: (input) =>
          rpcEffect(terminalManager.write(input), "Failed to write terminal"),
        [WS_METHODS.terminalResize]: (input) =>
          rpcEffect(terminalManager.resize(input), "Failed to resize terminal"),
        [WS_METHODS.terminalClear]: (input) =>
          rpcEffect(terminalManager.clear(input), "Failed to clear terminal"),
        [WS_METHODS.terminalRestart]: (input) =>
          rpcEffect(terminalManager.restart(input), "Failed to restart terminal"),
        [WS_METHODS.terminalClose]: (input) =>
          rpcEffect(terminalManager.close(input), "Failed to close terminal"),
        [WS_METHODS.subscribeTerminalEvents]: () =>
          Stream.callback((queue) =>
            terminalManager
              .subscribe((event) => Queue.offer(queue, event).pipe(Effect.asVoid))
              .pipe(
                Effect.map((unsubscribe) => Effect.addFinalizer(() => Effect.sync(unsubscribe))),
              ),
          ),

        [WS_METHODS.serverGetConfig]: () =>
          rpcEffect(loadServerConfig, "Failed to load server config"),
        [WS_METHODS.serverGetEnvironment]: () =>
          rpcEffect(serverEnvironment.getDescriptor, "Failed to load server environment"),
        [WS_METHODS.serverGetSettings]: () =>
          rpcEffect(serverSettings.getSettings, "Failed to load server settings"),
        [WS_METHODS.serverUpdateSettings]: (input) =>
          rpcEffect(serverSettings.updateSettings(input), "Failed to update server settings"),
        [WS_METHODS.serverRefreshProviders]: () =>
          rpcEffect(
            providerHealth.refresh.pipe(Effect.map((providers) => ({ providers }))),
            "Failed to refresh providers",
          ),
        [WS_METHODS.serverListWorktrees]: () => Effect.succeed({ worktrees: [] }),
        [WS_METHODS.serverGetProviderUsageSnapshot]: (input) =>
          rpcEffect(getProviderUsageSnapshot(input), "Failed to load provider usage"),
        [WS_METHODS.serverTranscribeVoice]: (input) =>
          rpcEffect(
            providerAdapterRegistry
              .getByProvider(input.provider)
              .pipe(
                Effect.flatMap((adapter) =>
                  adapter.transcribeVoice
                    ? adapter.transcribeVoice(input)
                    : Effect.fail(
                        new Error(
                          `Voice transcription is unavailable for provider '${input.provider}'.`,
                        ),
                      ),
                ),
              ),
            "Voice transcription failed",
          ),
        [WS_METHODS.serverUpsertKeybinding]: (input) =>
          rpcEffect(
            keybindings
              .upsertKeybindingRule(input)
              .pipe(
                Effect.map((keybindingsConfig) => ({ keybindings: keybindingsConfig, issues: [] })),
              ),
            "Failed to update keybinding",
          ),
        [WS_METHODS.subscribeServerLifecycle]: () =>
          Stream.concat(
            Stream.fromEffect(
              lifecycleEvents.snapshot.pipe(
                Effect.map((snapshot) =>
                  Array.from(snapshot.events).toSorted(
                    (left, right) => left.sequence - right.sequence,
                  ),
                ),
              ),
            ).pipe(Stream.flatMap(Stream.fromIterable)),
            lifecycleEvents.stream,
          ).pipe(
            Stream.map(
              (event): ServerLifecycleStreamEvent =>
                event.type === "welcome"
                  ? { type: "welcome", payload: event.payload }
                  : { type: "ready", payload: event.payload },
            ),
          ),
        [WS_METHODS.subscribeServerConfig]: () =>
          Stream.concat(
            Stream.fromEffect(
              loadServerConfig.pipe(
                Effect.map(
                  (config): ServerConfigStreamEvent => ({ type: "snapshot" as const, config }),
                ),
              ),
            ),
            Stream.merge(
              keybindings.streamChanges.pipe(
                Stream.map((event) => ({
                  type: "configUpdated" as const,
                  payload: { issues: event.issues, providers: [] },
                })),
              ),
              Stream.merge(
                providerHealth.streamChanges.pipe(
                  Stream.map((providers) => ({
                    type: "providerStatuses" as const,
                    payload: { providers },
                  })),
                ),
                serverSettings.streamChanges.pipe(
                  Stream.map((settings) => ({
                    type: "settingsUpdated" as const,
                    payload: { settings },
                  })),
                ),
              ),
            ),
          ).pipe(Stream.mapError((cause) => toWsRpcError(cause, "Server config stream failed"))),
        [WS_METHODS.subscribeServerProviderStatuses]: () =>
          providerHealth.streamChanges.pipe(Stream.map((providers) => ({ providers }))),
        [WS_METHODS.subscribeServerSettings]: () =>
          serverSettings.streamChanges.pipe(Stream.map((settings) => ({ settings }))),

        [WS_METHODS.providerGetComposerCapabilities]: (input) =>
          rpcEffect(
            providerDiscoveryService.getComposerCapabilities(input),
            "Failed to get composer capabilities",
          ),
        [WS_METHODS.providerCompactThread]: (input) =>
          rpcEffect(providerService.compactThread(input), "Failed to compact thread"),
        [WS_METHODS.providerListCommands]: (input) =>
          rpcEffect(providerDiscoveryService.listCommands(input), "Failed to list commands"),
        [WS_METHODS.providerListSkills]: (input) =>
          rpcEffect(providerDiscoveryService.listSkills(input), "Failed to list skills"),
        [WS_METHODS.providerListPlugins]: (input) =>
          rpcEffect(providerDiscoveryService.listPlugins(input), "Failed to list plugins"),
        [WS_METHODS.providerReadPlugin]: (input) =>
          rpcEffect(providerDiscoveryService.readPlugin(input), "Failed to read plugin"),
        [WS_METHODS.providerListModels]: (input) =>
          rpcEffect(providerDiscoveryService.listModels(input), "Failed to list models"),
        [WS_METHODS.providerListAgents]: (input) =>
          rpcEffect(providerDiscoveryService.listAgents(input), "Failed to list agents"),
      });
    }),
  );

const makeRpcWebSocketHttpEffect = RpcServer.toHttpEffectWebsocket(WsRpcGroup, {
  spanPrefix: "ws.rpc",
  spanAttributes: {
    "rpc.transport": "websocket",
    "rpc.system": "effect-rpc",
  },
}).pipe(Effect.provide(makeWsRpcLayer().pipe(Layer.provideMerge(RpcSerialization.layerJson))));

export const websocketRpcRouteLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const rpcWebSocketHttpEffect = yield* makeRpcWebSocketHttpEffect;
    const router = yield* HttpRouter.HttpRouter;
    yield* router.add(
      "GET",
      "/ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const config = yield* ServerConfig;
        const serverAuth = yield* ServerAuth;
        const sessions = yield* SessionCredentialService;
        const url = HttpServerRequest.toURL(request);
        const legacyToken = url ? url.searchParams.get("token") : null;
        const authenticatedSession =
          !config.authToken || legacyToken === config.authToken
            ? null
            : yield* serverAuth.authenticateWebSocketUpgrade(makeEffectAuthRequest(request));

        if (!authenticatedSession) {
          return yield* rpcWebSocketHttpEffect;
        }

        return yield* Effect.acquireUseRelease(
          sessions.markConnected(authenticatedSession.sessionId),
          () => rpcWebSocketHttpEffect,
          () => sessions.markDisconnected(authenticatedSession.sessionId),
        );
      }).pipe(
        Effect.catchTag("AuthError", (error) => Effect.succeed(authErrorResponse(error))),
      ),
    );
  }),
);
