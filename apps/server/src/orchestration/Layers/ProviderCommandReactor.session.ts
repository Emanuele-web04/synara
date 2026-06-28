// Purpose: Session-lifecycle cluster for the ProviderCommandReactor — thread/workspace
//   resolution, thread-session dispatch helpers, stale-resume recovery, text-generation
//   input resolution, and ensureSessionForThread (start/resume/restart/fork wiring).
// Layer: dependency-parameterized Effect helpers; built once per reactor via makeReactorSession(deps).
// Exports: ReactorCoreDeps, ReactorSession, makeReactorSession.

import {
  EventId,
  type ModelSelection,
  ProviderKind,
  type ProviderStartOptions,
  type OrchestrationSession,
  type OrchestrationThread,
  ThreadId,
  type ProviderSession,
  type RuntimeMode,
  type TurnId,
} from "@t3tools/contracts";
import { Deferred, Effect, Equal, Option, Schema } from "effect";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { ProviderAdapterRequestError, type ProviderServiceError } from "../../provider/Errors.ts";
import { ExecutionRuntimeService } from "../../executionRuntime/Services/ExecutionRuntimeService.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import type { ProviderSessionStartServerOptions } from "../../provider/Services/ProviderAdapter.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { resolveThreadWorkspaceState } from "@t3tools/shared/threadEnvironment";
import {
  hasDedicatedTextGenerationProvider,
  isStaleCodexResumeError,
  mapProviderSessionStatusToOrchestrationStatus,
  serverCommandId,
} from "./ProviderCommandReactor.helpers.ts";
import {
  DEFAULT_RUNTIME_MODE,
  RECENT_SESSION_ENSURE_REUSE_WINDOW_MS,
} from "./ProviderCommandReactor.config.ts";

export interface ReactorCoreDeps {
  readonly orchestrationEngine: typeof OrchestrationEngineService.Service;
  readonly projectionSnapshotQuery: typeof ProjectionSnapshotQuery.Service;
  readonly providerService: typeof ProviderService.Service;
  readonly executionRuntimeService: typeof ExecutionRuntimeService.Service;
  readonly serverSettings: typeof ServerSettingsService.Service;
  readonly threadProviderOptions: Map<string, ProviderStartOptions>;
  readonly threadModelSelections: Map<string, ModelSelection>;
  readonly recentlyEnsuredSessionThreads: Map<
    string,
    {
      readonly ensuredAt: number;
      readonly modelSelection?: ModelSelection;
      readonly runtimeMode?: RuntimeMode;
    }
  >;
  readonly sidechatContextBootstrapThreadIds: Set<string>;
  readonly inFlightSessionEnsures: Map<string, Deferred.Deferred<void>>;
  readonly providerResumeCursorsByThreadId: Map<
    string,
    {
      readonly resumeCursor: unknown;
      readonly provider: ProviderKind;
      readonly runtimeMode: RuntimeMode;
      readonly modelSelection: ModelSelection;
      readonly cwd?: string;
    }
  >;
}

export type ReactorSession = ReturnType<typeof makeReactorSession>;

export function makeReactorSession(deps: ReactorCoreDeps) {
  const {
    orchestrationEngine,
    projectionSnapshotQuery,
    providerService,
    executionRuntimeService,
    serverSettings,
    threadModelSelections,
    recentlyEnsuredSessionThreads,
    sidechatContextBootstrapThreadIds,
    inFlightSessionEnsures,
    providerResumeCursorsByThreadId,
  } = deps;

  const resolveThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    return Option.getOrUndefined(yield* projectionSnapshotQuery.getThreadDetailById(threadId));
  });

  const resolveThreadWorkspaceProject = Effect.fnUntraced(function* (
    thread: Pick<OrchestrationThread, "projectId">,
  ) {
    return Option.getOrUndefined(
      yield* projectionSnapshotQuery
        .getProjectShellById(thread.projectId)
        .pipe(Effect.catch(() => Effect.succeed(Option.none()))),
    );
  });

  const resolveProjectedThreadWorkspaceCwd = Effect.fnUntraced(function* (
    thread: Pick<OrchestrationThread, "projectId" | "envMode" | "worktreePath">,
  ) {
    const project = yield* resolveThreadWorkspaceProject(thread);
    if (!project) {
      return undefined;
    }
    return resolveThreadWorkspaceCwd({
      thread,
      projects: [project],
    });
  });

  const resolveTextGenerationInputForSelection = (
    modelSelection: ModelSelection | undefined,
    providerOptions: ProviderStartOptions | undefined,
  ) => {
    if (!hasDedicatedTextGenerationProvider(modelSelection?.provider)) {
      return null;
    }

    if (modelSelection?.provider === "codex") {
      return {
        modelSelection,
        ...(providerOptions ? { providerOptions } : {}),
        ...(providerOptions?.codex?.homePath
          ? { codexHomePath: providerOptions.codex.homePath }
          : {}),
      } as const;
    }

    return {
      modelSelection,
      ...(providerOptions ? { providerOptions } : {}),
    } as const;
  };

  const resolveThreadTextGenerationInput = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly modelSelection?: ModelSelection;
    readonly providerOptions?: ProviderStartOptions;
    readonly useConfiguredFallback?: boolean;
  }) {
    const thread = yield* resolveThread(input.threadId);
    const modelSelection =
      input.modelSelection ?? threadModelSelections.get(input.threadId) ?? thread?.modelSelection;
    const providerOptions = input.providerOptions ?? deps.threadProviderOptions.get(input.threadId);
    const threadTextGenerationInput = resolveTextGenerationInputForSelection(
      modelSelection,
      providerOptions,
    );

    if (threadTextGenerationInput || !input.useConfiguredFallback) {
      return threadTextGenerationInput;
    }

    // Non-generating chat providers still get AI titles via the configured git-writing model.
    const settings = yield* serverSettings.getSettings;
    return resolveTextGenerationInputForSelection(
      settings.textGenerationModelSelection,
      providerOptions,
    );
  });

  const appendProviderFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind:
      | "provider.turn.start.failed"
      | "provider.turn.interrupt.failed"
      | "provider.approval.respond.failed"
      | "provider.user-input.respond.failed"
      | "provider.context.inject.failed"
      | "provider.session.stop.failed";
    readonly summary: string;
    readonly detail: string;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
    readonly requestId?: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("provider-failure-activity"),
      threadId: input.threadId,
      activity: {
        id: EventId.makeUnsafe(crypto.randomUUID()),
        tone: "error",
        kind: input.kind,
        summary: input.summary,
        payload: {
          detail: input.detail,
          ...(input.requestId ? { requestId: input.requestId } : {}),
        },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  const setThreadSession = (input: {
    readonly threadId: ThreadId;
    readonly session: OrchestrationSession;
    readonly createdAt: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.session.set",
      commandId: serverCommandId("provider-session-set"),
      threadId: input.threadId,
      session: input.session,
      createdAt: input.createdAt,
    });

  const setThreadSessionError = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly runtimeMode?: RuntimeMode;
    readonly detail: string;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return;
    }
    yield* setThreadSession({
      threadId: input.threadId,
      session: {
        threadId: input.threadId,
        status: "error",
        providerName: thread.session?.providerName ?? thread.modelSelection.provider,
        runtimeMode: input.runtimeMode ?? thread.session?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        activeTurnId: null,
        lastError: input.detail,
        updatedAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  const joinPendingSessionEnsure = (threadId: ThreadId) =>
    Effect.sync(() => {
      const recentEnsure = recentlyEnsuredSessionThreads.get(threadId);
      if (recentEnsure === undefined) {
        return null;
      }
      recentlyEnsuredSessionThreads.delete(threadId);
      return Date.now() - recentEnsure.ensuredAt <= RECENT_SESSION_ENSURE_REUSE_WINDOW_MS
        ? recentEnsure
        : null;
    });

  const joinInFlightSessionEnsure = Effect.fnUntraced(function* (threadId: ThreadId) {
    const deferred = inFlightSessionEnsures.get(threadId);
    if (deferred === undefined) {
      return;
    }
    yield* Deferred.await(deferred);
  });

  // Recovers the parent thread when older/local-only subagent rows are missing parentThreadId metadata.
  const inferParentThreadFromSyntheticSubagentId = Effect.fnUntraced(function* (
    threadId: ThreadId,
  ) {
    const rawThreadId = threadId as string;
    if (!rawThreadId.startsWith("subagent:")) {
      return null;
    }

    return Option.getOrNull(
      yield* projectionSnapshotQuery.findSyntheticSubagentParentThread(threadId),
    );
  });

  const resolveProviderSessionThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    const thread = yield* resolveThread(threadId);
    if (!thread) {
      return null;
    }
    if (!thread.parentThreadId) {
      return (yield* inferParentThreadFromSyntheticSubagentId(thread.id)) ?? thread;
    }
    const parentThread = yield* resolveThread(thread.parentThreadId);
    return parentThread ?? thread;
  });

  const clearStaleProviderResumeState = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly cause: ProviderServiceError;
  }) {
    providerResumeCursorsByThreadId.delete(input.threadId);
    if (providerService.clearSessionResumeCursor) {
      yield* providerService
        .clearSessionResumeCursor({ threadId: input.threadId })
        .pipe(Effect.catch(() => Effect.void));
    } else {
      yield* providerService
        .stopSession({ threadId: input.threadId })
        .pipe(Effect.catch(() => Effect.void));
    }
    yield* Effect.logWarning(
      "provider command reactor cleared stale provider resume state during conversation rollback",
      {
        threadId: input.threadId,
        cause: input.cause.message,
      },
    );
  });

  const ensureSessionForThread = Effect.fnUntraced(function* (
    threadId: ThreadId,
    createdAt: string,
    options?: {
      readonly modelSelection?: ModelSelection;
      readonly providerOptions?: ProviderStartOptions;
      readonly runtimeMode?: RuntimeMode;
    },
  ) {
    const thread = yield* resolveThread(threadId);
    if (!thread) {
      return yield* Effect.die(
        new Error(`Thread '${threadId}' was not found in projection state.`),
      );
    }

    const desiredRuntimeMode = options?.runtimeMode ?? thread.runtimeMode;
    const currentProvider: ProviderKind | undefined = Schema.is(ProviderKind)(
      thread.session?.providerName,
    )
      ? thread.session.providerName
      : undefined;
    const requestedModelSelection = options?.modelSelection;
    const threadProvider: ProviderKind = currentProvider ?? thread.modelSelection.provider;
    if (
      requestedModelSelection !== undefined &&
      requestedModelSelection.provider !== threadProvider
    ) {
      return yield* new ProviderAdapterRequestError({
        provider: threadProvider,
        method: "thread.turn.start",
        detail: `Thread '${threadId}' is bound to provider '${threadProvider}' and cannot switch to '${requestedModelSelection.provider}'.`,
      });
    }
    const preferredProvider: ProviderKind = currentProvider ?? threadProvider;
    const desiredModelSelection = requestedModelSelection ?? thread.modelSelection;
    // Provision (or resolve) the execution target before the provider session
    // starts. For local/worktree threads this returns no cwd override and no
    // instance, preserving the existing local spawn path exactly. For a remote
    // target it returns the provisioned root plus an opaque instance id. The
    // reactor stays provider-agnostic: it reads the resolved cwd and the opaque
    // instance id, never any provider-specific states or routes.
    const resolvedTarget = yield* executionRuntimeService
      .ensureTargetForThread(threadId, thread.runtime)
      .pipe(
        Effect.catchTag("RuntimeProvisionFailedError", (error) =>
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: threadProvider,
              method: "thread.turn.start",
              detail: error.message,
            }),
          ),
        ),
      );
    const projectedCwd = yield* resolveProjectedThreadWorkspaceCwd(thread);
    const effectiveCwd = resolvedTarget.cwd ?? projectedCwd;
    // For a remote target, bind a transport factory to this thread's instance so
    // the provider runs its agent process *inside* the sandbox (and streams back
    // over that transport) rather than spawning locally. `exec` starts the agent
    // the provider describes and returns its line transport; the env is left to
    // the target. Absent for local/worktree threads, so the local path is
    // untouched.
    const remoteInstanceId = resolvedTarget.instanceId;
    const sessionServerOptions: ProviderSessionStartServerOptions | undefined =
      remoteInstanceId !== null || thread.reviewChatTarget
        ? {
            ...(thread.reviewChatTarget ? { reviewProfile: "review-chat" as const } : {}),
            ...(remoteInstanceId !== null
              ? {
                  remoteTransport: (spec) =>
                    Effect.runPromise(
                      executionRuntimeService
                        .exec({
                          threadId,
                          instanceId: remoteInstanceId,
                          role: "agent",
                          command: spec.command,
                          args: spec.args,
                        })
                        .pipe(Effect.map((handle) => handle.transport)),
                    ).catch((cause: unknown) => {
                      // The Effect→Promise boundary (the manager is a plain class, not
                      // an Effect service) flattens a typed failure/defect into an
                      // opaque rejection. Re-wrap with the instance so a failed remote
                      // start is diagnosable instead of a bare "transport failed".
                      throw new Error(
                        `Remote runtime exec failed for instance ${remoteInstanceId}: ${
                          cause instanceof Error ? cause.message : String(cause)
                        }`,
                        { cause },
                      );
                    }),
                }
              : {}),
          }
        : undefined;
    const workspaceState = resolveThreadWorkspaceState({
      envMode: thread.envMode,
      worktreePath: thread.worktreePath,
    });
    if (workspaceState === "worktree-pending") {
      return yield* new ProviderAdapterRequestError({
        provider: threadProvider,
        method: "thread.turn.start",
        detail: `Thread '${threadId}' targets a worktree that has not been created yet.`,
      });
    }

    const resolveActiveSession = (threadId: ThreadId) =>
      providerService
        .listSessions()
        .pipe(Effect.map((sessions) => sessions.find((session) => session.threadId === threadId)));

    const startProviderSession = (input?: {
      readonly resumeCursor?: unknown;
      readonly provider?: ProviderKind;
    }) =>
      providerService.startSession(
        threadId,
        {
          threadId,
          ...(preferredProvider ? { provider: preferredProvider } : {}),
          ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
          modelSelection: desiredModelSelection,
          ...(options?.providerOptions !== undefined
            ? { providerOptions: options.providerOptions }
            : {}),
          ...(thread.reviewChatTarget
            ? { approvalPolicy: "never" as const, sandboxMode: "read-only" as const }
            : {}),
          ...(input?.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
          runtimeMode: desiredRuntimeMode,
        },
        sessionServerOptions,
      );
    const startProviderSessionWithStaleResumeRetry = (input?: {
      readonly resumeCursor?: unknown;
      readonly provider?: ProviderKind;
    }) =>
      startProviderSession(input).pipe(
        Effect.catch((error) => {
          if (!isStaleCodexResumeError(error)) {
            return Effect.fail(error);
          }
          return Effect.gen(function* () {
            yield* clearStaleProviderResumeState({ threadId, cause: error });
            yield* Effect.logWarning(
              "provider command reactor retrying provider session after stale resume cursor",
              {
                threadId,
                provider: preferredProvider,
                runtimeMode: desiredRuntimeMode,
                cause: error.message,
              },
            );
            return yield* startProviderSession(undefined);
          });
        }),
      );

    const bindSessionToThread = (session: ProviderSession) =>
      Effect.gen(function* () {
        if (session.resumeCursor !== undefined) {
          providerResumeCursorsByThreadId.set(threadId, {
            resumeCursor: session.resumeCursor,
            provider: session.provider,
            runtimeMode: desiredRuntimeMode,
            modelSelection: desiredModelSelection,
            ...(effectiveCwd !== undefined ? { cwd: effectiveCwd } : {}),
          });
        }
        yield* setThreadSession({
          threadId,
          session: {
            threadId,
            status: mapProviderSessionStatusToOrchestrationStatus(session.status),
            providerName: session.provider,
            runtimeMode: desiredRuntimeMode,
            // Provider turn ids are not orchestration turn ids.
            activeTurnId: null,
            lastError: session.lastError ?? null,
            updatedAt: session.updatedAt,
          },
          createdAt,
        });
      });

    // Only reuse projected session state when the runtime still has a live session to attach to.
    const activeSession = yield* resolveActiveSession(threadId);
    const activeSessionMatchesDesired =
      activeSession !== undefined &&
      activeSession.status !== "closed" &&
      activeSession.provider === preferredProvider &&
      activeSession.runtimeMode === desiredRuntimeMode &&
      (requestedModelSelection === undefined ||
        activeSession.model === undefined ||
        activeSession.model === requestedModelSelection.model);
    if (
      activeSessionMatchesDesired &&
      (thread.session === null || thread.session.status === "stopped")
    ) {
      yield* bindSessionToThread(activeSession);
      return threadId;
    }
    const existingSessionThreadId =
      thread.session && thread.session.status !== "stopped" && activeSession ? thread.id : null;
    if (existingSessionThreadId) {
      const runtimeModeChanged = desiredRuntimeMode !== thread.session?.runtimeMode;
      const providerChanged =
        requestedModelSelection !== undefined &&
        requestedModelSelection.provider !== currentProvider;
      const sessionModelSwitch =
        currentProvider === undefined
          ? "in-session"
          : (yield* providerService.getCapabilities(currentProvider)).sessionModelSwitch;
      const modelChanged =
        requestedModelSelection !== undefined &&
        requestedModelSelection.model !== activeSession?.model;
      const shouldRestartForModelChange = modelChanged && sessionModelSwitch === "restart-session";
      const previousModelSelection = threadModelSelections.get(threadId);
      const shouldRestartForModelSelectionChange =
        (currentProvider === "claudeAgent" || currentProvider === "grok") &&
        requestedModelSelection !== undefined &&
        !Equal.equals(previousModelSelection, requestedModelSelection);

      if (
        !runtimeModeChanged &&
        !providerChanged &&
        !shouldRestartForModelChange &&
        !shouldRestartForModelSelectionChange
      ) {
        return existingSessionThreadId;
      }

      const resumeCursor =
        providerChanged || shouldRestartForModelChange || runtimeModeChanged
          ? undefined
          : (activeSession?.resumeCursor ?? undefined);
      yield* Effect.logInfo("provider command reactor restarting provider session", {
        threadId,
        existingSessionThreadId,
        currentProvider,
        desiredProvider: desiredModelSelection.provider,
        currentRuntimeMode: thread.session?.runtimeMode,
        desiredRuntimeMode,
        runtimeModeChanged,
        providerChanged,
        modelChanged,
        shouldRestartForModelChange,
        shouldRestartForModelSelectionChange,
        hasResumeCursor: resumeCursor !== undefined,
      });
      const restartedSession = yield* startProviderSessionWithStaleResumeRetry(
        resumeCursor !== undefined ? { resumeCursor } : undefined,
      );
      yield* Effect.logInfo("provider command reactor restarted provider session", {
        threadId,
        previousSessionId: existingSessionThreadId,
        restartedSessionThreadId: restartedSession.threadId,
        provider: restartedSession.provider,
        runtimeMode: restartedSession.runtimeMode,
      });
      yield* bindSessionToThread(restartedSession);
      return restartedSession.threadId;
    }

    // Native provider fork spawns the agent locally, so it cannot back a remote
    // thread. Skip it for remote targets and start a fresh sandbox session via
    // `startProviderSession` (which carries `sessionServerOptions`) instead. The
    // fork's prior conversation is unavailable on the remote agent, so this is a
    // deliberate, logged degradation rather than a silent local spawn.
    if (remoteInstanceId !== null && thread.forkSourceThreadId) {
      yield* Effect.logInfo(
        "provider command reactor skipping native fork for remote thread; starting a fresh remote session",
        { threadId, forkSourceThreadId: thread.forkSourceThreadId },
      );
    }
    if (providerService.forkThread && thread.forkSourceThreadId && remoteInstanceId === null) {
      const forked = yield* providerService.forkThread({
        sourceThreadId: thread.forkSourceThreadId,
        threadId,
        ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
        modelSelection: desiredModelSelection,
        ...(options?.providerOptions !== undefined
          ? { providerOptions: options.providerOptions }
          : {}),
        runtimeMode: desiredRuntimeMode,
      });
      if (forked) {
        const forkedSession =
          (yield* resolveActiveSession(threadId)) ??
          ({
            provider: preferredProvider,
            status: "ready",
            runtimeMode: desiredRuntimeMode,
            ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
            model: desiredModelSelection.model,
            threadId,
            ...(forked.resumeCursor !== undefined ? { resumeCursor: forked.resumeCursor } : {}),
            createdAt,
            updatedAt: createdAt,
          } satisfies ProviderSession);
        yield* bindSessionToThread(forkedSession);
        return threadId;
      }
    }

    if (thread.sidechatSourceThreadId && thread.forkSourceThreadId) {
      sidechatContextBootstrapThreadIds.add(threadId);
    }

    const cachedResumeCursor = providerResumeCursorsByThreadId.get(threadId);
    const cachedResumeCursorMatches =
      cachedResumeCursor !== undefined &&
      cachedResumeCursor.provider === preferredProvider &&
      cachedResumeCursor.runtimeMode === desiredRuntimeMode &&
      Equal.equals(cachedResumeCursor.modelSelection, desiredModelSelection) &&
      cachedResumeCursor.cwd === effectiveCwd;
    const startedSession = yield* startProviderSessionWithStaleResumeRetry(
      cachedResumeCursorMatches ? { resumeCursor: cachedResumeCursor.resumeCursor } : undefined,
    );
    yield* bindSessionToThread(startedSession);
    return startedSession.threadId;
  });

  return {
    resolveThread,
    resolveThreadWorkspaceProject,
    resolveProjectedThreadWorkspaceCwd,
    resolveProviderSessionThread,
    resolveThreadTextGenerationInput,
    appendProviderFailureActivity,
    setThreadSession,
    setThreadSessionError,
    clearStaleProviderResumeState,
    ensureSessionForThread,
    joinPendingSessionEnsure,
    joinInFlightSessionEnsure,
  };
}
