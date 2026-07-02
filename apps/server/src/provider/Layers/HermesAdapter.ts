import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import {
  ApprovalRequestId,
  EventId,
  type ProviderApprovalDecision,
  type ProviderComposerCapabilities,
  type ProviderListCommandsResult,
  type ProviderListModelsResult,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Effect, Exit, Layer, PubSub, Scope, Stream } from "effect";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { HermesAdapter, type HermesAdapterShape } from "../Services/HermesAdapter.ts";
import type { ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";

const PROVIDER = "hermes" as const;
const DEFAULT_HERMES_BINARY = "hermes";
const DEFAULT_HERMES_TIMEOUT_MS = 10 * 60 * 1000;

const execFileAsync = promisify(execFile);

interface HermesExecFileOptions {
  readonly cwd?: string;
  readonly timeout: number;
  readonly maxBuffer: number;
  readonly signal: AbortSignal;
}

interface HermesExecFileResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type HermesExecFile = (
  binaryPath: string,
  args: ReadonlyArray<string>,
  options: HermesExecFileOptions,
) => Promise<HermesExecFileResult>;

interface HermesSessionContext {
  session: ProviderSession;
  binaryPath: string;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  activeTurnId: TurnId | undefined;
  activeAbortController: AbortController | undefined;
}

export interface HermesAdapterLiveOptions {
  readonly binaryPath?: string;
  readonly execFile?: HermesExecFile;
  readonly timeoutMs?: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function eventBase(input: {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId;
  readonly itemId?: RuntimeItemId;
}): Pick<ProviderRuntimeEvent, "eventId" | "provider" | "threadId" | "createdAt"> & {
  readonly turnId?: TurnId;
  readonly itemId?: RuntimeItemId;
} {
  return {
    eventId: EventId.makeUnsafe(`hermes-event-${randomUUID()}`),
    provider: PROVIDER,
    threadId: input.threadId,
    createdAt: nowIso(),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.itemId ? { itemId: input.itemId } : {}),
  };
}

function sessionNotFound(threadId: ThreadId): ProviderAdapterSessionNotFoundError {
  return new ProviderAdapterSessionNotFoundError({
    provider: PROVIDER,
    threadId: String(threadId),
  });
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function buildHermesArgs(input: { readonly prompt: string; readonly model?: string }): string[] {
  const args = ["chat", "--quiet", "--query", input.prompt];
  if (input.model && input.model !== "default") {
    args.push("--profile", input.model);
  }
  return args;
}

function getHermesModel(session: ProviderSession, inputModel?: string): string | undefined {
  return inputModel?.trim() || session.model || undefined;
}

function readHermesBinaryPath(providerOptions: unknown, fallback: string): string {
  if (!providerOptions || typeof providerOptions !== "object" || Array.isArray(providerOptions)) {
    return fallback;
  }
  const hermesOptions = "hermes" in providerOptions ? providerOptions.hermes : undefined;
  if (!hermesOptions || typeof hermesOptions !== "object" || Array.isArray(hermesOptions)) {
    return fallback;
  }
  const binaryPath = "binaryPath" in hermesOptions ? hermesOptions.binaryPath : undefined;
  return typeof binaryPath === "string" && binaryPath.trim().length > 0
    ? binaryPath.trim()
    : fallback;
}

function makeHermesAdapter(options?: HermesAdapterLiveOptions) {
  return Effect.gen(function* () {
    const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const turnScope = yield* Scope.make("sequential");
    yield* Effect.addFinalizer(() => Scope.close(turnScope, Exit.void));
    const sessions = new Map<ThreadId, HermesSessionContext>();
    const binaryPath = options?.binaryPath?.trim() || DEFAULT_HERMES_BINARY;
    const runExecFile =
      options?.execFile ??
      ((executable, args, execOptions) => execFileAsync(executable, [...args], execOptions));
    const timeoutMs = options?.timeoutMs ?? DEFAULT_HERMES_TIMEOUT_MS;

    const publish = (event: ProviderRuntimeEvent) => PubSub.publish(events, event);

    const startSession: HermesAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* Effect.fail(
            new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            }),
          );
        }

        const createdAt = nowIso();
        const model =
          input.modelSelection?.provider === PROVIDER ? input.modelSelection.model : undefined;
        const sessionBinaryPath = readHermesBinaryPath(input.providerOptions, binaryPath);
        const session: ProviderSession = {
          provider: PROVIDER,
          status: "ready",
          runtimeMode: input.runtimeMode,
          threadId: input.threadId,
          createdAt,
          updatedAt: createdAt,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(model ? { model } : {}),
          ...(input.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
        };
        sessions.set(input.threadId, {
          session,
          binaryPath: sessionBinaryPath,
          turns: [],
          activeTurnId: undefined,
          activeAbortController: undefined,
        });
        yield* publish({
          ...eventBase({ threadId: input.threadId }),
          type: "session.started",
          payload: { message: "Hermes CLI session ready" },
        } as ProviderRuntimeEvent);
        return session;
      });

    const sendTurn: HermesAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const context = sessions.get(input.threadId);
        if (!context) {
          return yield* Effect.fail(sessionNotFound(input.threadId));
        }
        const prompt = input.input?.trim();
        if (!prompt) {
          return yield* Effect.fail(
            new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Hermes provider requires non-empty text input.",
            }),
          );
        }

        const turnId = TurnId.makeUnsafe(`hermes-turn-${randomUUID()}`);
        const itemId = RuntimeItemId.makeUnsafe(`hermes-assistant-${randomUUID()}`);
        const model = getHermesModel(
          context.session,
          input.modelSelection?.provider === PROVIDER ? input.modelSelection.model : undefined,
        );
        const startedAt = nowIso();
        const abortController = new AbortController();
        context.activeTurnId = turnId;
        context.activeAbortController = abortController;
        context.session = {
          ...context.session,
          status: "running",
          activeTurnId: turnId,
          updatedAt: startedAt,
          ...(model ? { model } : {}),
        };
        context.turns.push({ id: turnId, items: [] });

        yield* publish({
          ...eventBase({ threadId: input.threadId, turnId }),
          type: "turn.started",
          payload: { ...(model ? { model } : {}) },
        } as ProviderRuntimeEvent);

        const runEffect = Effect.gen(function* () {
          const args = buildHermesArgs({ prompt, ...(model ? { model } : {}) });
          const result = yield* Effect.tryPromise({
            try: () =>
              runExecFile(context.binaryPath, args, {
                ...(context.session.cwd ? { cwd: context.session.cwd } : {}),
                timeout: timeoutMs,
                maxBuffer: 10 * 1024 * 1024,
                signal: abortController.signal,
              }),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "chat",
                detail: cause instanceof Error ? cause.message : String(cause),
                cause,
              }),
          });
          const output = normalizeText(
            `${result.stdout ?? ""}${result.stderr ? `\n${result.stderr}` : ""}`,
          );
          if (output.length > 0) {
            yield* publish({
              ...eventBase({ threadId: input.threadId, turnId, itemId }),
              type: "item.started",
              payload: { itemType: "assistant_message", status: "inProgress" },
            } as ProviderRuntimeEvent);
            yield* publish({
              ...eventBase({ threadId: input.threadId, turnId, itemId }),
              type: "content.delta",
              payload: { streamKind: "assistant_text", delta: output },
            } as ProviderRuntimeEvent);
            yield* publish({
              ...eventBase({ threadId: input.threadId, turnId, itemId }),
              type: "item.completed",
              payload: { itemType: "assistant_message", status: "completed" },
            } as ProviderRuntimeEvent);
            const turn = context.turns.find((candidate) => candidate.id === turnId);
            turn?.items.push({ itemId, itemType: "assistant_message", text: output });
          }
          yield* publish({
            ...eventBase({ threadId: input.threadId, turnId }),
            type: "turn.completed",
            payload: { state: "completed", stopReason: "end_turn" },
          } as ProviderRuntimeEvent);
          context.activeTurnId = undefined;
          context.activeAbortController = undefined;
          context.session = {
            ...context.session,
            status: "ready",
            activeTurnId: undefined,
            updatedAt: nowIso(),
          };
        }).pipe(
          Effect.catch((error: ProviderAdapterError) =>
            Effect.gen(function* () {
              yield* publish({
                ...eventBase({ threadId: input.threadId, turnId }),
                type: "turn.completed",
                payload: { state: "failed", errorMessage: error.message },
              } as ProviderRuntimeEvent);
              context.activeTurnId = undefined;
              context.activeAbortController = undefined;
              context.session = {
                ...context.session,
                status: "error",
                activeTurnId: undefined,
                updatedAt: nowIso(),
                lastError: error.message,
              };
            }),
          ),
        );
        yield* runEffect.pipe(Effect.forkIn(turnScope));
        return { threadId: input.threadId, turnId } satisfies ProviderTurnStartResult;
      });

    const interruptTurn: HermesAdapterShape["interruptTurn"] = (threadId) =>
      Effect.sync(() => {
        const context = sessions.get(threadId);
        context?.activeAbortController?.abort();
      });

    const unsupported = (operation: string) =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation,
          issue: "Hermes CLI adapter does not support this operation yet.",
        }),
      );

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "restart-session",
        supportsSkillMentions: false,
        supportsSkillDiscovery: false,
        supportsNativeSlashCommandDiscovery: false,
        supportsPluginMentions: false,
        supportsPluginDiscovery: false,
        supportsRuntimeModelList: false,
        supportsTurnSteering: false,
        supportsLiveTurnDiffPatch: false,
      },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest: (
        _threadId: ThreadId,
        _requestId: ApprovalRequestId,
        _decision: ProviderApprovalDecision,
      ) => unsupported("respondToRequest"),
      respondToUserInput: (
        _threadId: ThreadId,
        _requestId: ApprovalRequestId,
        _answers: ProviderUserInputAnswers,
      ) => unsupported("respondToUserInput"),
      stopSession: (threadId: ThreadId) =>
        Effect.sync(() => {
          const context = sessions.get(threadId);
          context?.activeAbortController?.abort();
          sessions.delete(threadId);
        }),
      listSessions: () =>
        Effect.sync(() => Array.from(sessions.values()).map((context) => context.session)),
      hasSession: (threadId: ThreadId) => Effect.sync(() => sessions.has(threadId)),
      readThread: (
        threadId: ThreadId,
      ): Effect.Effect<ProviderThreadSnapshot, ProviderAdapterError> =>
        Effect.gen(function* () {
          const context = sessions.get(threadId);
          if (!context) {
            return yield* Effect.fail(sessionNotFound(threadId));
          }
          return { threadId, cwd: context.session.cwd ?? null, turns: context.turns };
        }),
      rollbackThread: (
        threadId: ThreadId,
        numTurns: number,
      ): Effect.Effect<ProviderThreadSnapshot, ProviderAdapterError> =>
        Effect.gen(function* () {
          const context = sessions.get(threadId);
          if (!context) {
            return yield* Effect.fail(sessionNotFound(threadId));
          }
          if (numTurns > 0) {
            context.turns.splice(Math.max(0, context.turns.length - numTurns), numTurns);
          }
          return { threadId, cwd: context.session.cwd ?? null, turns: context.turns };
        }),
      stopAll: () =>
        Effect.sync(() => {
          for (const context of sessions.values()) {
            context.activeAbortController?.abort();
          }
          sessions.clear();
        }),
      streamEvents: Stream.fromPubSub(events),
      getComposerCapabilities: (): Effect.Effect<
        ProviderComposerCapabilities,
        ProviderAdapterError
      > =>
        Effect.succeed({
          provider: PROVIDER,
          supportsSkillMentions: false,
          supportsSkillDiscovery: false,
          supportsNativeSlashCommandDiscovery: false,
          supportsPluginMentions: false,
          supportsPluginDiscovery: false,
          supportsRuntimeModelList: false,
        } as ProviderComposerCapabilities),
      listModels: (): Effect.Effect<ProviderListModelsResult, ProviderAdapterError> =>
        Effect.succeed({ models: [] } as ProviderListModelsResult),
      listCommands: (): Effect.Effect<ProviderListCommandsResult, ProviderAdapterError> =>
        Effect.succeed({ commands: [] } as ProviderListCommandsResult),
      transcribeVoice: () => unsupported("transcribeVoice"),
    } satisfies HermesAdapterShape;
  });
}

export const HermesAdapterLive = Layer.effect(HermesAdapter, makeHermesAdapter());

export function makeHermesAdapterLive(options?: HermesAdapterLiveOptions) {
  return Layer.effect(HermesAdapter, makeHermesAdapter(options));
}
