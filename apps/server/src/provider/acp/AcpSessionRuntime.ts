// FILE: AcpSessionRuntime.ts
// Purpose: Owns one authenticated ACP process, session setup, configuration, and event stream.
// Layer: Provider ACP runtime
// Exports: AcpSessionRuntime and its typed runtime factory contracts.

import { randomUUID } from "node:crypto";
import { prepareWindowsSafeProcess } from "@synara/shared/windowsProcess";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  Queue,
  Ref,
  Schema,
  Scope,
  ServiceMap,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as EffectAcpClient from "effect-acp/client";
import * as EffectAcpErrors from "effect-acp/errors";
import * as EffectAcpSchema from "effect-acp/schema";
import type * as EffectAcpProtocol from "effect-acp/protocol";

import {
  collectSessionConfigOptionValues,
  extractModelConfigId,
  findSessionConfigOption,
  mergeToolCallState,
  parseSessionModeState,
  parseSessionUpdateEvent,
  type AcpParsedSessionEvent,
  type AcpSessionModeState,
  type AcpToolCallState,
} from "./AcpRuntimeModel.ts";

const CONFIG_OPTION_UPDATE_TIMEOUT = "5 seconds";

type ConfigOptionUpdateWaiter = {
  readonly configId: string;
  readonly value: string | boolean;
  readonly deferred: Deferred.Deferred<ReadonlyArray<EffectAcpSchema.SessionConfigOption>>;
};

export interface AcpSpawnInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface AcpSessionRuntimeOptions {
  readonly spawn: AcpSpawnInput;
  readonly cwd: string;
  readonly resumeSessionId?: string;
  readonly clientCapabilities?: EffectAcpSchema.InitializeRequest["clientCapabilities"];
  readonly clientInfo: {
    readonly name: string;
    readonly version: string;
  };
  readonly authMethodId?: string;
  readonly resolveAuthMethodId?: (
    initializeResult: EffectAcpSchema.InitializeResponse,
  ) => Effect.Effect<string, EffectAcpErrors.AcpError>;
  readonly authenticateMeta?: Record<string, unknown>;
  readonly requestLogger?: (event: AcpSessionRequestLogEvent) => Effect.Effect<void, never>;
  readonly protocolLogging?: {
    readonly logIncoming?: boolean;
    readonly logOutgoing?: boolean;
    readonly logger?: (event: EffectAcpProtocol.AcpProtocolLogEvent) => Effect.Effect<void, never>;
  };
}

export interface AcpSessionRequestLogEvent {
  readonly method: string;
  readonly payload: unknown;
  readonly status: "started" | "succeeded" | "failed";
  readonly result?: unknown;
  readonly cause?: Cause.Cause<EffectAcpErrors.AcpError>;
}

export interface AcpSessionRuntimeStartResult {
  readonly sessionId: string;
  readonly initializeResult: EffectAcpSchema.InitializeResponse;
  readonly sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse;
  readonly modelConfigId: string | undefined;
  /** `session/resume` does not replay transcript updates; `session/load` may. */
  readonly sessionSetupMethod: "new" | "load" | "resume";
}

export interface AcpSessionRuntimeShape {
  readonly handleRequestPermission: EffectAcpClient.AcpClientShape["handleRequestPermission"];
  readonly handleElicitation: EffectAcpClient.AcpClientShape["handleElicitation"];
  readonly handleReadTextFile: EffectAcpClient.AcpClientShape["handleReadTextFile"];
  readonly handleWriteTextFile: EffectAcpClient.AcpClientShape["handleWriteTextFile"];
  readonly handleCreateTerminal: EffectAcpClient.AcpClientShape["handleCreateTerminal"];
  readonly handleTerminalOutput: EffectAcpClient.AcpClientShape["handleTerminalOutput"];
  readonly handleTerminalWaitForExit: EffectAcpClient.AcpClientShape["handleTerminalWaitForExit"];
  readonly handleTerminalKill: EffectAcpClient.AcpClientShape["handleTerminalKill"];
  readonly handleTerminalRelease: EffectAcpClient.AcpClientShape["handleTerminalRelease"];
  readonly handleSessionUpdate: EffectAcpClient.AcpClientShape["handleSessionUpdate"];
  readonly handleElicitationComplete: EffectAcpClient.AcpClientShape["handleElicitationComplete"];
  readonly handleUnknownExtRequest: EffectAcpClient.AcpClientShape["handleUnknownExtRequest"];
  readonly handleUnknownExtNotification: EffectAcpClient.AcpClientShape["handleUnknownExtNotification"];
  readonly handleExtRequest: EffectAcpClient.AcpClientShape["handleExtRequest"];
  readonly handleExtNotification: EffectAcpClient.AcpClientShape["handleExtNotification"];
  readonly start: () => Effect.Effect<AcpSessionRuntimeStartResult, EffectAcpErrors.AcpError>;
  readonly getEvents: () => Stream.Stream<AcpParsedSessionEvent, never>;
  // Monotonic count of parsed session/update events enqueued for the
  // getEvents() consumer. Adapters snapshot it and wait until their own
  // processed count catches up, so turn attribution stays open until every
  // event received during the turn has actually been handled — immune to
  // stream chunk buffering and in-flight handlers, unlike a queue-size probe.
  readonly sessionUpdatesEnqueuedCount: Effect.Effect<number>;
  readonly supportsSessionFork: Effect.Effect<boolean, EffectAcpErrors.AcpError>;
  readonly getModeState: Effect.Effect<AcpSessionModeState | undefined>;
  readonly getConfigOptions: Effect.Effect<ReadonlyArray<EffectAcpSchema.SessionConfigOption>>;
  readonly getAvailableCommands: Effect.Effect<ReadonlyArray<EffectAcpSchema.AvailableCommand>>;
  readonly prompt: (
    payload: Omit<EffectAcpSchema.PromptRequest, "sessionId">,
  ) => Effect.Effect<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError>;
  readonly cancel: Effect.Effect<void, EffectAcpErrors.AcpError>;
  readonly setMode: (
    modeId: string,
  ) => Effect.Effect<EffectAcpSchema.SetSessionModeResponse, EffectAcpErrors.AcpError>;
  readonly setConfigOption: (
    configId: string,
    value: string | boolean,
  ) => Effect.Effect<EffectAcpSchema.SetSessionConfigOptionResponse, EffectAcpErrors.AcpError>;
  readonly setModel: (model: string) => Effect.Effect<void, EffectAcpErrors.AcpError>;
  readonly forkSession: (
    payload: Omit<EffectAcpSchema.ForkSessionRequest, "sessionId">,
  ) => Effect.Effect<EffectAcpSchema.ForkSessionResponse, EffectAcpErrors.AcpError>;
  readonly request: (
    method: string,
    payload: unknown,
  ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
  readonly notify: (
    method: string,
    payload: unknown,
  ) => Effect.Effect<void, EffectAcpErrors.AcpError>;
}

interface AcpStartedState extends AcpSessionRuntimeStartResult {}

type AcpStartState =
  | { readonly _tag: "NotStarted" }
  | {
      readonly _tag: "Starting";
      readonly deferred: Deferred.Deferred<AcpSessionRuntimeStartResult, EffectAcpErrors.AcpError>;
    }
  | { readonly _tag: "Started"; readonly result: AcpStartedState };

interface AcpAssistantSegmentState {
  readonly nextSegmentIndex: number;
  readonly activeItemId?: string;
}

interface EnsureActiveAssistantSegmentResult {
  readonly itemId: string;
  readonly completedEvent?: Extract<
    AcpParsedSessionEvent,
    { readonly _tag: "AssistantItemCompleted" }
  >;
  readonly startedEvent?: Extract<AcpParsedSessionEvent, { readonly _tag: "AssistantItemStarted" }>;
}

export class AcpSessionRuntime extends ServiceMap.Service<
  AcpSessionRuntime,
  AcpSessionRuntimeShape
>()("synara/provider/acp/AcpSessionRuntime") {
  static layer(
    options: AcpSessionRuntimeOptions,
  ): Layer.Layer<
    AcpSessionRuntime,
    EffectAcpErrors.AcpError,
    ChildProcessSpawner.ChildProcessSpawner
  > {
    return Layer.effect(AcpSessionRuntime, makeAcpSessionRuntime(options));
  }
}

const makeAcpSessionRuntime = (
  options: AcpSessionRuntimeOptions,
): Effect.Effect<
  AcpSessionRuntimeShape,
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtimeScope = yield* Scope.Scope;
    const eventQueue = yield* Queue.unbounded<AcpParsedSessionEvent>();
    const modeStateRef = yield* Ref.make<AcpSessionModeState | undefined>(undefined);
    const availableCommandsRef = yield* Ref.make<ReadonlyArray<EffectAcpSchema.AvailableCommand>>(
      [],
    );
    const toolCallsRef = yield* Ref.make(new Map<string, AcpToolCallState>());
    const assistantSegmentRef = yield* Ref.make<AcpAssistantSegmentState>({ nextSegmentIndex: 0 });
    // Unique per runtime instance so assistant message ids never collide across
    // server restarts or session resumes (segment index resets to 0 each time).
    const runtimeInstanceId = randomUUID().slice(0, 8);
    const configOptionsRef = yield* Ref.make(sessionConfigOptionsFromSetup(undefined));
    const configOptionUpdateWaitersRef = yield* Ref.make<ReadonlyArray<ConfigOptionUpdateWaiter>>(
      [],
    );
    const startStateRef = yield* Ref.make<AcpStartState>({ _tag: "NotStarted" });
    // session/load can replay a large history before the consumer attaches; drop
    // those notifications so they never accumulate in the unbounded queue. For
    // resumed sessions the gate stays closed past start() and only opens once the
    // adapter attaches a consumer via getEvents(), because the agent may keep
    // replaying after replying to session/load. Plain mutable state (not a Ref)
    // so getEvents() can open the gate synchronously at attach time.
    let acceptingSessionUpdates = false;
    // Counts every parsed event offered into eventQueue (see
    // sessionUpdatesEnqueuedCount on the shape). Plain mutable state: single
    // writer per offer, and readers only need a monotonic snapshot.
    let sessionUpdatesEnqueued = 0;
    const offerSessionEvent = (event: AcpParsedSessionEvent): Effect.Effect<void> =>
      Effect.suspend(() => {
        sessionUpdatesEnqueued += 1;
        return Effect.asVoid(Queue.offer(eventQueue, event));
      });

    const logRequest = (event: AcpSessionRequestLogEvent) =>
      options.requestLogger ? options.requestLogger(event) : Effect.void;

    const runLoggedRequest = <A>(
      method: string,
      payload: unknown,
      effect: Effect.Effect<A, EffectAcpErrors.AcpError>,
    ): Effect.Effect<A, EffectAcpErrors.AcpError> =>
      logRequest({ method, payload, status: "started" }).pipe(
        Effect.flatMap(() =>
          effect.pipe(
            Effect.tap((result) =>
              logRequest({
                method,
                payload,
                status: "succeeded",
                result,
              }),
            ),
            Effect.onError((cause) =>
              logRequest({
                method,
                payload,
                status: "failed",
                cause,
              }),
            ),
          ),
        ),
      );

    const env = options.spawn.env ? { ...process.env, ...options.spawn.env } : process.env;
    const prepared = prepareWindowsSafeProcess(options.spawn.command, options.spawn.args, {
      cwd: options.spawn.cwd,
      env,
    });
    const child = yield* spawner
      .spawn(
        ChildProcess.make(prepared.command, prepared.args, {
          ...(options.spawn.cwd ? { cwd: options.spawn.cwd } : {}),
          env,
          shell: prepared.shell,
        }),
      )
      .pipe(
        Effect.provideService(Scope.Scope, runtimeScope),
        Effect.mapError(
          (cause) =>
            new EffectAcpErrors.AcpSpawnError({
              command: options.spawn.command,
              cause,
            }),
        ),
      );

    const acpContext = yield* Layer.build(
      EffectAcpClient.layerChildProcess(child, {
        ...(options.protocolLogging?.logIncoming !== undefined
          ? { logIncoming: options.protocolLogging.logIncoming }
          : {}),
        ...(options.protocolLogging?.logOutgoing !== undefined
          ? { logOutgoing: options.protocolLogging.logOutgoing }
          : {}),
        ...(options.protocolLogging?.logger ? { logger: options.protocolLogging.logger } : {}),
      }),
    ).pipe(Effect.provideService(Scope.Scope, runtimeScope));

    const acp = ServiceMap.getUnsafe(acpContext, EffectAcpClient.AcpClient);

    // The protocol layer offers every incoming notification into an unbounded
    // raw queue (acp.raw.notifications) in addition to invoking the
    // handleSessionUpdate callback. Nothing consumes that stream in this
    // runtime, so a resumed session's replay would accumulate there without
    // bound regardless of the accepting gate below — drain it for the
    // runtime's lifetime. (handleSessionUpdate delivery is unaffected: it is
    // driven by the callback path, not this queue.)
    yield* Stream.runDrain(acp.raw.notifications).pipe(Effect.forkIn(runtimeScope));

    const resolveConfigOptionUpdateWaiters = (
      configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
    ): Effect.Effect<void> =>
      Ref.modify(configOptionUpdateWaitersRef, (waiters) => {
        const resolved: ConfigOptionUpdateWaiter[] = [];
        const pending: ConfigOptionUpdateWaiter[] = [];
        for (const waiter of waiters) {
          const configOption = findSessionConfigOption(configOptions, waiter.configId);
          if (configOption && configOptionCurrentValueMatches(configOption, waiter.value)) {
            resolved.push(waiter);
          } else {
            pending.push(waiter);
          }
        }
        return [resolved, pending] as const;
      }).pipe(
        Effect.flatMap((waiters) =>
          Effect.forEach(waiters, (waiter) => Deferred.succeed(waiter.deferred, configOptions), {
            discard: true,
          }),
        ),
      );

    yield* acp.handleSessionUpdate((notification) =>
      Effect.suspend(() => {
        const update = notification.update;
        const rememberCommands =
          update.sessionUpdate === "available_commands_update"
            ? Ref.set(availableCommandsRef, update.availableCommands)
            : Effect.void;
        const rememberConfigOptions =
          update.sessionUpdate === "config_option_update"
            ? Ref.set(configOptionsRef, update.configOptions).pipe(
                Effect.andThen(resolveConfigOptionUpdateWaiters(update.configOptions)),
              )
            : Effect.void;
        const rememberBoundedState = rememberCommands.pipe(Effect.andThen(rememberConfigOptions));
        if (!acceptingSessionUpdates) {
          // Command and configuration inventories are bounded state, not
          // transcript replay; retain them even while historical session
          // updates are being suppressed.
          return rememberBoundedState;
        }
        return rememberBoundedState.pipe(
          Effect.andThen(
            handleSessionUpdate({
              offer: offerSessionEvent,
              modeStateRef,
              toolCallsRef,
              assistantSegmentRef,
              runtimeInstanceId,
              params: notification,
            }),
          ),
        );
      }),
    );

    const initializeClientCapabilities = {
      fs: {
        readTextFile: false,
        writeTextFile: false,
        ...options.clientCapabilities?.fs,
      },
      terminal: options.clientCapabilities?.terminal ?? false,
      ...(options.clientCapabilities?.auth ? { auth: options.clientCapabilities.auth } : {}),
      ...(options.clientCapabilities?.elicitation
        ? { elicitation: options.clientCapabilities.elicitation }
        : {}),
      ...(options.clientCapabilities?._meta ? { _meta: options.clientCapabilities._meta } : {}),
    } satisfies NonNullable<EffectAcpSchema.InitializeRequest["clientCapabilities"]>;

    const getStartedState = Effect.gen(function* () {
      const state = yield* Ref.get(startStateRef);
      if (state._tag === "Started") {
        return state.result;
      }
      return yield* new EffectAcpErrors.AcpTransportError({
        detail: "ACP session runtime has not been started",
        cause: new Error("ACP session runtime has not been started"),
      });
    });

    const validateConfigOptionValue = (
      configId: string,
      value: string | boolean,
    ): Effect.Effect<void, EffectAcpErrors.AcpError> =>
      Effect.gen(function* () {
        const configOption = findSessionConfigOption(yield* Ref.get(configOptionsRef), configId);
        if (!configOption) {
          return;
        }
        if (configOption.type === "boolean") {
          if (typeof value === "boolean") {
            return;
          }
          return yield* new EffectAcpErrors.AcpRequestError({
            code: -32602,
            errorMessage: `Invalid value ${JSON.stringify(value)} for session config option "${configOption.id}": expected boolean`,
            data: {
              configId: configOption.id,
              expectedType: "boolean",
              receivedValue: value,
            },
          });
        }
        if (typeof value !== "string") {
          return yield* new EffectAcpErrors.AcpRequestError({
            code: -32602,
            errorMessage: `Invalid value ${JSON.stringify(value)} for session config option "${configOption.id}": expected string`,
            data: {
              configId: configOption.id,
              expectedType: "string",
              receivedValue: value,
            },
          });
        }
        const allowedValues = collectSessionConfigOptionValues(configOption);
        if (allowedValues.includes(value)) {
          return;
        }
        return yield* new EffectAcpErrors.AcpRequestError({
          code: -32602,
          errorMessage: `Invalid value ${JSON.stringify(value)} for session config option "${configOption.id}": expected one of ${allowedValues.join(", ")}`,
          data: {
            configId: configOption.id,
            allowedValues,
            receivedValue: value,
          },
        });
      });

    const updateConfigOptions = (
      response:
        | EffectAcpSchema.SetSessionConfigOptionResponse
        | EffectAcpSchema.LoadSessionResponse
        | EffectAcpSchema.NewSessionResponse
        | EffectAcpSchema.ResumeSessionResponse,
    ): Effect.Effect<void> => Ref.set(configOptionsRef, sessionConfigOptionsFromSetup(response));

    const waitForConfigOptionUpdate = (
      configId: string,
      value: string | boolean,
    ): Effect.Effect<
      ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
      EffectAcpErrors.AcpError
    > =>
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<ReadonlyArray<EffectAcpSchema.SessionConfigOption>>();
        const waiter: ConfigOptionUpdateWaiter = { configId, value, deferred };
        yield* Ref.update(configOptionUpdateWaitersRef, (waiters) => [...waiters, waiter]);

        // The notification may have arrived before the empty response was
        // observed and this waiter was registered. Recheck the retained state
        // after registration so both event orderings are race-safe.
        const current = yield* Ref.get(configOptionsRef);
        const currentOption = findSessionConfigOption(current, configId);
        if (currentOption && configOptionCurrentValueMatches(currentOption, value)) {
          yield* Deferred.succeed(deferred, current);
        }

        const result = yield* Deferred.await(deferred).pipe(
          Effect.timeoutOption(CONFIG_OPTION_UPDATE_TIMEOUT),
          Effect.ensuring(
            Ref.update(configOptionUpdateWaitersRef, (waiters) =>
              waiters.filter((candidate) => candidate !== waiter),
            ),
          ),
        );
        if (Option.isNone(result)) {
          return yield* new EffectAcpErrors.AcpTransportError({
            detail:
              "ACP agent returned an empty session/set_config_option response without a matching config_option_update notification",
            cause: new Error(
              `Timed out waiting for config option ${JSON.stringify(configId)} to become ${JSON.stringify(value)}`,
            ),
          });
        }
        return result.value;
      });

    const updateCurrentModeId = (modeId: string): Effect.Effect<void> =>
      Ref.update(modeStateRef, (current) =>
        current ? { ...current, currentModeId: modeId } : current,
      );

    const setConfigOption = (
      configId: string,
      value: string | boolean,
    ): Effect.Effect<EffectAcpSchema.SetSessionConfigOptionResponse, EffectAcpErrors.AcpError> =>
      validateConfigOptionValue(configId, value).pipe(
        Effect.flatMap(() => getStartedState),
        Effect.flatMap((started) =>
          Ref.get(configOptionsRef).pipe(
            Effect.flatMap((configOptions) => {
              const existing = findSessionConfigOption(configOptions, configId);
              if (existing && configOptionCurrentValueMatches(existing, value)) {
                return Effect.succeed({
                  configOptions,
                } satisfies EffectAcpSchema.SetSessionConfigOptionResponse);
              }
              const requestPayload =
                typeof value === "boolean"
                  ? ({
                      sessionId: started.sessionId,
                      configId,
                      type: "boolean",
                      value,
                    } satisfies EffectAcpSchema.SetSessionConfigOptionRequest)
                  : ({
                      sessionId: started.sessionId,
                      configId,
                      value: String(value),
                    } satisfies EffectAcpSchema.SetSessionConfigOptionRequest);
              return runLoggedRequest(
                "session/set_config_option",
                requestPayload,
                acp.raw
                  .request("session/set_config_option", requestPayload)
                  .pipe(
                    Effect.flatMap((response) =>
                      decodeSetSessionConfigOptionResponse(
                        response,
                        waitForConfigOptionUpdate(configId, value),
                      ),
                    ),
                  ),
              ).pipe(Effect.tap((response) => updateConfigOptions(response)));
            }),
          ),
        ),
      );

    const startOnce = Effect.gen(function* () {
      const initializePayload = {
        protocolVersion: 1,
        clientCapabilities: initializeClientCapabilities,
        clientInfo: options.clientInfo,
      } satisfies EffectAcpSchema.InitializeRequest;

      const initializeResult = yield* runLoggedRequest(
        "initialize",
        initializePayload,
        acp.agent.initialize(initializePayload),
      );
      const authMethodId =
        options.resolveAuthMethodId !== undefined
          ? yield* options.resolveAuthMethodId(initializeResult)
          : options.authMethodId;

      if (!authMethodId) {
        return yield* new EffectAcpErrors.AcpRequestError({
          code: -32602,
          errorMessage: "ACP agent did not provide an authentication method.",
          data: { authMethods: initializeResult.authMethods ?? [] },
        });
      }

      const authenticatePayload = {
        methodId: authMethodId,
        ...(options.authenticateMeta ? { _meta: options.authenticateMeta } : {}),
      } satisfies EffectAcpSchema.AuthenticateRequest;

      yield* runLoggedRequest(
        "authenticate",
        authenticatePayload,
        acp.agent.authenticate(authenticatePayload),
      );

      let sessionId: string;
      let sessionSetupResult:
        | EffectAcpSchema.LoadSessionResponse
        | EffectAcpSchema.NewSessionResponse
        | EffectAcpSchema.ResumeSessionResponse;
      let resumedExistingSession = false;
      let sessionSetupMethod: AcpSessionRuntimeStartResult["sessionSetupMethod"] = "new";
      if (options.resumeSessionId) {
        const resumePayload = {
          sessionId: options.resumeSessionId,
          cwd: options.cwd,
          mcpServers: [],
        } satisfies EffectAcpSchema.ResumeSessionRequest;
        const supportsResume =
          initializeResult.agentCapabilities?.sessionCapabilities?.resume != null;
        const resumed = yield* (
          supportsResume
            ? runLoggedRequest(
                "session/resume",
                resumePayload,
                acp.agent.resumeSession(resumePayload),
              )
            : (() => {
                const loadPayload = {
                  sessionId: options.resumeSessionId,
                  cwd: options.cwd,
                  mcpServers: [],
                } satisfies EffectAcpSchema.LoadSessionRequest;
                return runLoggedRequest(
                  "session/load",
                  loadPayload,
                  acp.agent.loadSession(loadPayload),
                );
              })()
        ).pipe(Effect.exit);
        if (Exit.isSuccess(resumed)) {
          // A resumed session may keep replaying history after session/load
          // returns; keep dropping until getEvents() attaches a consumer so
          // the replay cannot pile up in the unbounded queue.
          sessionId = options.resumeSessionId;
          sessionSetupResult = resumed.value;
          resumedExistingSession = true;
          sessionSetupMethod = supportsResume ? "resume" : "load";
        } else {
          // Fresh fallback session: no replay risk, and agents may emit early
          // session/update from inside session/new — accept from here so those
          // buffer for the consumer instead of being dropped.
          acceptingSessionUpdates = true;
          const createPayload = {
            cwd: options.cwd,
            mcpServers: [],
          } satisfies EffectAcpSchema.NewSessionRequest;
          const created = yield* runLoggedRequest(
            "session/new",
            createPayload,
            acp.agent.createSession(createPayload),
          );
          sessionId = created.sessionId;
          sessionSetupResult = created;
          sessionSetupMethod = "new";
        }
      } else {
        // Fresh session: accept updates from before session/new so any early
        // agent output emitted while the request is in flight is buffered.
        acceptingSessionUpdates = true;
        const createPayload = {
          cwd: options.cwd,
          mcpServers: [],
        } satisfies EffectAcpSchema.NewSessionRequest;
        const created = yield* runLoggedRequest(
          "session/new",
          createPayload,
          acp.agent.createSession(createPayload),
        );
        sessionId = created.sessionId;
        sessionSetupResult = created;
        sessionSetupMethod = "new";
      }

      yield* Ref.set(modeStateRef, parseSessionModeState(sessionSetupResult));
      yield* Ref.update(configOptionsRef, (current) =>
        sessionConfigOptionsFromSetup(sessionSetupResult, current),
      );
      // Fresh sessions accept session/update while session/new is in flight, and
      // those events are already in the queue; resetting the merge/segment state
      // they created would orphan their continuations (new segment ids, unmerged
      // tool updates). Only the resumed replay-dropping path starts clean.
      if (resumedExistingSession) {
        yield* Ref.set(toolCallsRef, new Map());
        yield* Ref.set(assistantSegmentRef, { nextSegmentIndex: 0 });
      }

      const nextState = {
        sessionId,
        initializeResult,
        sessionSetupResult,
        modelConfigId: extractModelConfigId(sessionSetupResult),
        sessionSetupMethod,
      } satisfies AcpStartedState;
      return nextState;
    });

    const start = Effect.gen(function* () {
      const deferred = yield* Deferred.make<
        AcpSessionRuntimeStartResult,
        EffectAcpErrors.AcpError
      >();
      const effect = yield* Ref.modify(startStateRef, (state) => {
        switch (state._tag) {
          case "Started":
            return [Effect.succeed(state.result), state] as const;
          case "Starting":
            return [Deferred.await(state.deferred), state] as const;
          case "NotStarted":
            return [
              startOnce.pipe(
                Effect.tap((result) =>
                  Ref.set(startStateRef, { _tag: "Started", result }).pipe(
                    Effect.andThen(Deferred.succeed(deferred, result)),
                  ),
                ),
                Effect.onError((cause) =>
                  Deferred.failCause(deferred, cause).pipe(
                    Effect.andThen(Ref.set(startStateRef, { _tag: "NotStarted" })),
                  ),
                ),
              ),
              { _tag: "Starting", deferred } satisfies AcpStartState,
            ] as const;
        }
      });
      return yield* effect;
    });

    return {
      handleRequestPermission: acp.handleRequestPermission,
      handleElicitation: acp.handleElicitation,
      handleReadTextFile: acp.handleReadTextFile,
      handleWriteTextFile: acp.handleWriteTextFile,
      handleCreateTerminal: acp.handleCreateTerminal,
      handleTerminalOutput: acp.handleTerminalOutput,
      handleTerminalWaitForExit: acp.handleTerminalWaitForExit,
      handleTerminalKill: acp.handleTerminalKill,
      handleTerminalRelease: acp.handleTerminalRelease,
      handleSessionUpdate: acp.handleSessionUpdate,
      handleElicitationComplete: acp.handleElicitationComplete,
      handleUnknownExtRequest: acp.handleUnknownExtRequest,
      handleUnknownExtNotification: acp.handleUnknownExtNotification,
      handleExtRequest: acp.handleExtRequest,
      handleExtNotification: acp.handleExtNotification,
      start: () => start,
      getEvents: () => {
        // Attaching a consumer opens the session/update gate: from here on the
        // queue is drained, so accepting notifications can no longer grow it
        // without bound (see acceptingSessionUpdates above).
        acceptingSessionUpdates = true;
        return Stream.fromQueue(eventQueue);
      },
      sessionUpdatesEnqueuedCount: Effect.sync(() => sessionUpdatesEnqueued),
      getModeState: Ref.get(modeStateRef),
      getConfigOptions: Ref.get(configOptionsRef),
      getAvailableCommands: Ref.get(availableCommandsRef),
      prompt: (payload) =>
        getStartedState.pipe(
          Effect.flatMap((started) => {
            const requestPayload = {
              sessionId: started.sessionId,
              ...payload,
            } satisfies EffectAcpSchema.PromptRequest;
            return closeActiveAssistantSegment({
              offer: offerSessionEvent,
              assistantSegmentRef,
            }).pipe(
              Effect.andThen(
                runLoggedRequest(
                  "session/prompt",
                  requestPayload,
                  acp.agent.prompt(requestPayload),
                ),
              ),
              Effect.tap(() =>
                closeActiveAssistantSegment({
                  offer: offerSessionEvent,
                  assistantSegmentRef,
                }),
              ),
            );
          }),
        ),
      cancel: getStartedState.pipe(
        Effect.flatMap((started) => acp.agent.cancel({ sessionId: started.sessionId })),
      ),
      setMode: (modeId) =>
        Ref.get(modeStateRef).pipe(
          Effect.flatMap((modeState) => {
            if (modeState?.currentModeId === modeId) {
              return Effect.succeed({} satisfies EffectAcpSchema.SetSessionModeResponse);
            }
            return Ref.get(configOptionsRef).pipe(
              Effect.map((options) =>
                options.find(
                  (option) =>
                    option.type === "select" &&
                    (option.category === "mode" || option.id === "mode") &&
                    flattenSessionConfigSelectOptions(option.options).some(
                      (entry) => entry.value === modeId,
                    ),
                ),
              ),
              Effect.flatMap((modeOption) => setConfigOption(modeOption?.id ?? "mode", modeId)),
              Effect.tap(() => updateCurrentModeId(modeId)),
              Effect.as({} satisfies EffectAcpSchema.SetSessionModeResponse),
            );
          }),
        ),
      setConfigOption,
      supportsSessionFork: getStartedState.pipe(
        Effect.map(
          (started) =>
            started.initializeResult.agentCapabilities?.sessionCapabilities?.fork != null,
        ),
      ),
      setModel: (model) =>
        getStartedState.pipe(
          Effect.flatMap((started) => setConfigOption(started.modelConfigId ?? "model", model)),
          Effect.asVoid,
        ),
      forkSession: (payload) =>
        getStartedState.pipe(
          Effect.flatMap((started) => {
            const requestPayload = {
              ...payload,
              sessionId: started.sessionId,
            } satisfies EffectAcpSchema.ForkSessionRequest;
            return runLoggedRequest(
              "session/fork",
              requestPayload,
              acp.agent.forkSession(requestPayload),
            );
          }),
        ),
      request: (method, payload) =>
        runLoggedRequest(method, payload, acp.raw.request(method, payload)),
      notify: acp.raw.notify,
    } satisfies AcpSessionRuntimeShape;
  });

export function sessionConfigOptionsFromSetup(
  response:
    | {
        readonly configOptions?: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null;
      }
    | undefined,
  fallback: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = [],
): ReadonlyArray<EffectAcpSchema.SessionConfigOption> {
  return response?.configOptions ?? fallback;
}

// Flattens grouped ACP select options so semantic configuration lookup stays provider-agnostic.
function flattenSessionConfigSelectOptions(
  options:
    | ReadonlyArray<EffectAcpSchema.SessionConfigSelectOption>
    | ReadonlyArray<EffectAcpSchema.SessionConfigSelectGroup>,
): ReadonlyArray<EffectAcpSchema.SessionConfigSelectOption> {
  return options.flatMap((entry) => ("options" in entry ? entry.options : [entry]));
}

function configOptionCurrentValueMatches(
  configOption: EffectAcpSchema.SessionConfigOption,
  value: string | boolean,
): boolean {
  const currentValue = configOption.currentValue;
  if (configOption.type === "boolean") {
    return currentValue === value;
  }
  if (typeof currentValue !== "string") {
    return false;
  }
  return currentValue.trim() === String(value).trim();
}

export function decodeSetSessionConfigOptionResponse(
  response: unknown,
  configUpdate: Effect.Effect<
    ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
    EffectAcpErrors.AcpError
  >,
): Effect.Effect<EffectAcpSchema.SetSessionConfigOptionResponse, EffectAcpErrors.AcpError> {
  if (isEmptyRecord(response)) {
    return configUpdate.pipe(Effect.map((configOptions) => ({ configOptions })));
  }
  return Schema.decodeUnknownEffect(EffectAcpSchema.SetSessionConfigOptionResponse)(response).pipe(
    Effect.mapError(
      (cause) =>
        new EffectAcpErrors.AcpTransportError({
          detail: "ACP agent returned an invalid session/set_config_option response",
          cause,
        }),
    ),
  );
}

function isEmptyRecord(value: unknown): value is Record<string, never> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

const handleSessionUpdate = ({
  offer,
  modeStateRef,
  toolCallsRef,
  assistantSegmentRef,
  runtimeInstanceId,
  params,
}: {
  readonly offer: (event: AcpParsedSessionEvent) => Effect.Effect<void>;
  readonly modeStateRef: Ref.Ref<AcpSessionModeState | undefined>;
  readonly toolCallsRef: Ref.Ref<Map<string, AcpToolCallState>>;
  readonly assistantSegmentRef: Ref.Ref<AcpAssistantSegmentState>;
  readonly runtimeInstanceId: string;
  readonly params: EffectAcpSchema.SessionNotification;
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    const parsed = parseSessionUpdateEvent(params);
    if (parsed.modeId) {
      yield* Ref.update(modeStateRef, (current) =>
        current === undefined ? current : updateModeState(current, parsed.modeId!),
      );
    }
    for (const event of parsed.events) {
      if (event._tag === "ToolCallUpdated") {
        yield* closeActiveAssistantSegment({
          offer,
          assistantSegmentRef,
        });
        const { previous, merged } = yield* Ref.modify(toolCallsRef, (current) => {
          const previous = current.get(event.toolCall.toolCallId);
          const nextToolCall = mergeToolCallState(previous, event.toolCall);
          const next = new Map(current);
          if (nextToolCall.status === "completed" || nextToolCall.status === "failed") {
            next.delete(nextToolCall.toolCallId);
          } else {
            next.set(nextToolCall.toolCallId, nextToolCall);
          }
          return [{ previous, merged: nextToolCall }, next] as const;
        });
        if (!shouldEmitToolCallUpdate(previous, merged)) {
          continue;
        }
        yield* offer({
          _tag: "ToolCallUpdated",
          toolCall: merged,
          rawPayload: event.rawPayload,
        });
        continue;
      }
      if (event._tag === "ContentDelta") {
        if (event.streamKind === "reasoning_text") {
          yield* offer(event);
          continue;
        }
        if (event.text.trim().length === 0) {
          const assistantSegmentState = yield* Ref.get(assistantSegmentRef);
          if (!assistantSegmentState.activeItemId) {
            continue;
          }
        }
        const itemId = yield* ensureActiveAssistantSegment({
          offer,
          assistantSegmentRef,
          sessionId: params.sessionId,
          runtimeInstanceId,
          requestedItemId: event.itemId,
        });
        yield* offer({
          ...event,
          itemId,
        });
        continue;
      }
      yield* offer(event);
    }
  });

function updateModeState(modeState: AcpSessionModeState, nextModeId: string): AcpSessionModeState {
  const normalized = nextModeId.trim();
  if (!normalized) {
    return modeState;
  }
  return modeState.availableModes.some((mode) => mode.id === normalized)
    ? {
        ...modeState,
        currentModeId: normalized,
      }
    : modeState;
}

function shouldEmitToolCallUpdate(
  previous: AcpToolCallState | undefined,
  next: AcpToolCallState,
): boolean {
  if (previous === undefined) {
    return true;
  }
  if (next.status === "completed" || next.status === "failed") {
    return true;
  }
  if (previous.status !== next.status || previous.title !== next.title) {
    return true;
  }
  if (!next.detail) {
    return false;
  }
  return previous.detail !== next.detail;
}

export const assistantItemId = (
  sessionId: string,
  runtimeInstanceId: string,
  segmentIndex: number,
) => `assistant:${sessionId}:${runtimeInstanceId}:segment:${segmentIndex}`;

const ensureActiveAssistantSegment = ({
  offer,
  assistantSegmentRef,
  sessionId,
  runtimeInstanceId,
  requestedItemId,
}: {
  readonly offer: (event: AcpParsedSessionEvent) => Effect.Effect<void>;
  readonly assistantSegmentRef: Ref.Ref<AcpAssistantSegmentState>;
  readonly sessionId: string;
  readonly runtimeInstanceId: string;
  readonly requestedItemId?: string | undefined;
}) =>
  Ref.modify<AcpAssistantSegmentState, EnsureActiveAssistantSegmentResult>(
    assistantSegmentRef,
    (current) => {
      if (current.activeItemId && current.activeItemId === requestedItemId) {
        return [{ itemId: current.activeItemId }, current] as const;
      }
      if (current.activeItemId && requestedItemId === undefined) {
        return [{ itemId: current.activeItemId }, current] as const;
      }
      // Cursor can provide stable message ids for chunks that resume after tool calls.
      // Keep those ids so projection appends the pieces instead of displaying broken segments.
      const itemId =
        requestedItemId ?? assistantItemId(sessionId, runtimeInstanceId, current.nextSegmentIndex);
      const completedEvent = current.activeItemId
        ? ({
            _tag: "AssistantItemCompleted",
            itemId: current.activeItemId,
          } satisfies Extract<AcpParsedSessionEvent, { readonly _tag: "AssistantItemCompleted" }>)
        : undefined;
      return [
        {
          itemId,
          ...(completedEvent ? { completedEvent } : {}),
          startedEvent: {
            _tag: "AssistantItemStarted",
            itemId,
          } satisfies Extract<AcpParsedSessionEvent, { readonly _tag: "AssistantItemStarted" }>,
        },
        {
          nextSegmentIndex:
            requestedItemId === undefined ? current.nextSegmentIndex + 1 : current.nextSegmentIndex,
          activeItemId: itemId,
        } satisfies AcpAssistantSegmentState,
      ] as const;
    },
  ).pipe(
    Effect.flatMap((result) =>
      Effect.gen(function* () {
        if (result.completedEvent) {
          yield* offer(result.completedEvent);
        }
        if (result.startedEvent) {
          yield* offer(result.startedEvent);
        }
        return result.itemId;
      }),
    ),
  );

const closeActiveAssistantSegment = ({
  offer,
  assistantSegmentRef,
}: {
  readonly offer: (event: AcpParsedSessionEvent) => Effect.Effect<void>;
  readonly assistantSegmentRef: Ref.Ref<AcpAssistantSegmentState>;
}) =>
  Ref.modify(assistantSegmentRef, (current) => {
    if (!current.activeItemId) {
      return [undefined, current] as const;
    }
    return [
      {
        _tag: "AssistantItemCompleted",
        itemId: current.activeItemId,
      } satisfies AcpParsedSessionEvent,
      {
        nextSegmentIndex: current.nextSegmentIndex,
      } satisfies AcpAssistantSegmentState,
    ] as const;
  }).pipe(Effect.flatMap((event) => (event ? offer(event) : Effect.void)));
