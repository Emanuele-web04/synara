/**
 * OmpAdapterLive - Oh My Pi (OMP) CLI (`omp acp`) via ACP. Thin wiring of the
 * shared ACP adapter core with OMP's CLI model discovery, agentDir session
 * store import and `omp` binary resolution.
 *
 * @module OmpAdapterLive
 */
import { ThreadId, TurnId, type ProviderListModelsResult } from "@synara/contracts";
import { Effect, Layer, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeEffectProcessCommand } from "../../platform/effectProcessRuntime.ts";
import type { ServerConfigShape } from "../../config.ts";
import { readOmpSessionHistory } from "../OmpSessionHistory.ts";
import { OmpAdapter, type OmpAdapterShape } from "../Services/OmpAdapter.ts";
import { ProviderAdapterRequestError } from "../Errors.ts";
import { classifyAcpPromptTurnCompletion } from "../acp/AcpAdapterSupport.ts";
import {
  resolveAcpSessionCwd,
  scopeAcpRuntimeItemIdForTurn,
  scopeAcpToolCallStateForTurn,
} from "../acp/AcpAdapterSessionSupport.ts";
import {
  applyOmpAcpModelSelection,
  buildOmpProcessEnv,
  makeOmpAcpRuntime,
  parseOmpCliModelList,
  resolveOmpAgentDir,
  resolveOmpCliBinaryPath,
  type OmpAcpRuntimeSettings,
} from "../acp/OmpAcpSupport.ts";
import type { AcpAgentRuntimeSettings, AcpAgentBoundary } from "../acp/GenericAcpSupport.ts";
import {
  type SharedAcpAdapterHooks,
  makeSharedAcpAdapter,
  takeAcpSynaraHarnessPolicyTextPart,
  isRenderableAcpAssistantDelta,
  isAcpNestedTaskToolCall,
  shouldIgnoreAcpInterrupt,
} from "./AcpAdapterCore.ts";
import { createLogger } from "../../logger.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "omp" as const;
const log = createLogger(PROVIDER);

const OMP_PLAN_MODE_PROMPT_PREFIX = [
  "Synara OMP plan mode is active.",
  "Do not implement or mutate files in this turn.",
  "Do not ask follow-up questions or wait for confirmation; if scope is ambiguous, choose a reasonable default and state the assumption in the plan.",
  "When ready, create the final implementation plan.",
].join("\n");

export interface OmpAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

// OMP settings flow through the shared core as generic agent settings plus
// OMP's own binaryPath/agentDir extras.
type OmpSharedSettings = OmpAcpRuntimeSettings & AcpAgentRuntimeSettings;

export const takeOmpSynaraHarnessPolicyTextPart = (
  state: Parameters<typeof takeAcpSynaraHarnessPolicyTextPart>[1],
  scopedGatewayConnectionAvailable: boolean,
) => takeAcpSynaraHarnessPolicyTextPart(PROVIDER, state, scopedGatewayConnectionAvailable);

export const isRenderableOmpAssistantDelta = isRenderableAcpAssistantDelta;

export const classifyOmpPromptTurnCompletion = (input: {
  readonly stopReason: string | null | undefined;
  readonly failedToolDetail?: string | undefined;
}) => classifyAcpPromptTurnCompletion(input);

export const isOmpNestedTaskToolCall = isAcpNestedTaskToolCall;

export const shouldIgnoreOmpInterrupt = shouldIgnoreAcpInterrupt;

export function scopeOmpRuntimeItemIdForTurn(turnId: TurnId, itemId: string): string {
  return scopeAcpRuntimeItemIdForTurn(PROVIDER, turnId, itemId);
}

export function scopeOmpToolCallStateForTurn(
  turnId: TurnId,
  toolCall: Parameters<typeof scopeAcpToolCallStateForTurn>[2],
) {
  return scopeAcpToolCallStateForTurn(PROVIDER, turnId, toolCall);
}

// Signature kept for existing call sites/tests: explicit cwd > active thread
// session cwd > server fallback > home.
export const resolveOmpSessionCwd = (
  inputCwd: string | undefined,
  serverConfig: ServerConfigShape,
  sessionCwd?: string,
) =>
  resolveAcpSessionCwd({
    inputCwd,
    serverCwd: serverConfig.cwd,
    homeDir: serverConfig.homeDir,
    sessionCwd,
  });

const collectDiscoveryStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>) => {
  const decoder = new TextDecoder();
  return Stream.runFold(
    stream,
    () => "",
    (acc, chunk) => acc + decoder.decode(chunk, { stream: true }),
  ).pipe(Effect.map((acc) => acc + decoder.decode()));
};

// OMP publishes its full multi-provider catalog via `omp models --json` in a
// single subprocess call; each model carries its own `thinking` efforts
// inline. This is O(1) round-trips and scales to OMP's 300+ model catalogs.
// The in-band ACP model option exposes only slug/name and would need one
// session/set_config_option round-trip per model to read per-model thinking.
const runOmpCliModelList = (input: {
  readonly settings: OmpSharedSettings;
  readonly boundary: AcpAgentBoundary;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
}) =>
  Effect.gen(function* () {
    const { settings, boundary, childProcessSpawner } = input;
    const binaryPath = settings.binaryPath?.trim() || settings.command?.trim();
    const agentDir = settings.agentDir?.trim() || undefined;
    const executable = resolveOmpCliBinaryPath(binaryPath);
    log.info("model/list cli start", { binaryPath, executable });
    const env = buildOmpProcessEnv({ ...boundary, ...(agentDir ? { agentDir } : {}) });
    const command = makeEffectProcessCommand(executable, ["models", "--json"], {
      env,
      stdin: "ignore",
    });
    const child = yield* childProcessSpawner.spawn(command);
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectDiscoveryStreamAsString(child.stdout),
        collectDiscoveryStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );
    log.info("model/list cli spawned", {
      exitCode,
      stdoutBytes: stdout.length,
      stdoutHead: stdout.slice(0, 240),
      stderr,
    });
    if (exitCode !== 0) {
      log.warn("model/list cli non-zero exit", { exitCode, stderr });
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "model/list",
        detail: stderr.trim() || `'${executable} models --json' exited with code ${exitCode}.`,
      });
    }
    const models = parseOmpCliModelList(stdout);
    log.info("model/list cli parsed", { parsedCount: models.length });
    if (models.length === 0) {
      log.warn("model/list cli returned zero models", {
        stdoutHead: stdout.slice(0, 500),
      });
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "model/list",
        detail:
          "OMP model discovery returned no models. Run `omp` to authenticate so ~/.omp credentials exist.",
      });
    }
    return { models, source: "omp-cli", cached: false } satisfies ProviderListModelsResult;
  }).pipe(Effect.scoped);

const OMP_HOOKS: SharedAcpAdapterHooks<OmpSharedSettings> = {
  provider: PROVIDER,
  agentDisplayName: "Omp",
  defaultInstanceId: "omp",
  debugEnvVar: "SYNARA_OMP_ACP_DEBUG",
  transportDebugMarker: "omp-acp-meta-stripper-v2",
  logPrefix: "omp.acp",
  idleTimeoutEnvVar: "SYNARA_OMP_TURN_IDLE_TIMEOUT_MS",
  planModePromptPrefix: OMP_PLAN_MODE_PROMPT_PREFIX,
  // OMP advertises image prompt support; blocks are always sent.
  gateImagesOnPromptCapabilities: false,
  // OMP persists every session under <agentDir>/sessions, so an external
  // session id can be read from the JSONL store and resumed over ACP.
  supportsThreadImport: true,
  effortFromModelOptions: (options) =>
    (options as { readonly thinkingLevel?: string } | null | undefined)?.thinkingLevel,
  settingsFromProviderOptions: (providerOptions) => {
    const omp = providerOptions?.omp;
    return {
      ...(omp?.binaryPath !== undefined ? { binaryPath: omp.binaryPath } : {}),
      ...(omp?.agentDir !== undefined ? { agentDir: omp.agentDir } : {}),
      ...(omp?.environment !== undefined ? { environment: omp.environment } : {}),
    };
  },
  settingsFromDiscoveryInput: (input) => {
    if (typeof input !== "object" || input === null) return {};
    const record = input as { binaryPath?: unknown; agentDir?: unknown; environment?: unknown };
    return {
      ...(typeof record.binaryPath === "string" && record.binaryPath.trim()
        ? { binaryPath: record.binaryPath }
        : {}),
      ...(typeof record.agentDir === "string" && record.agentDir.trim()
        ? { agentDir: record.agentDir }
        : {}),
      ...(typeof record.environment === "object" && record.environment !== null
        ? { environment: record.environment as Readonly<Record<string, string>> }
        : {}),
    };
  },
  finalizeSettings: (merged) => ({
    ...merged,
    command: resolveOmpCliBinaryPath(merged.binaryPath),
  }),
  discoveryCacheFields: (settings) => [settings.binaryPath, settings.agentDir],
  makeRuntime: ({ settings, ...runtimeInput }) =>
    makeOmpAcpRuntime({
      ...runtimeInput,
      ompSettings: settings,
      childProcessSpawner: runtimeInput.childProcessSpawner,
    }),
  applyModelSelection: (input) => applyOmpAcpModelSelection(input),
  discoverModels: (input) =>
    runOmpCliModelList(input).pipe(
      Effect.mapError((cause) =>
        cause instanceof ProviderAdapterRequestError
          ? cause
          : new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "model/list",
              detail: cause instanceof Error ? cause.message : "OMP model discovery failed.",
            }),
      ),
    ),
  readExternalThread: (input, resolveMergedSettings) =>
    Effect.tryPromise({
      // Resolve the agent dir with the same precedence OMP uses for its
      // session store: provider override, ambient env, then ~/.omp/agent.
      try: async () => {
        const merged = resolveMergedSettings(input.providerOptions, input.providerInstanceId);
        const agentDir = resolveOmpAgentDir(merged);
        return await readOmpSessionHistory(agentDir, input.externalThreadId);
      },
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "thread/read",
          detail: cause instanceof Error ? cause.message : "Failed to read the Oh My Pi session.",
          cause,
        }),
    }).pipe(
      Effect.flatMap((history) =>
        history
          ? Effect.succeed({
              threadId: ThreadId.makeUnsafe(history.sessionId),
              ...(history.cwd ? { cwd: history.cwd } : {}),
              ...(history.lastModel
                ? {
                    lastUsedModel: {
                      model: history.lastModel,
                      ...(history.lastThinkingLevel
                        ? { thinkingLevel: history.lastThinkingLevel }
                        : {}),
                    },
                  }
                : {}),
              turns: history.messages.map((message, index) => ({
                id: TurnId.makeUnsafe(`omp:${message.id}:${index}`),
                items: [{ type: "ompMessage", ...message }],
              })),
            })
          : Effect.fail(
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "thread/read",
                detail: `Oh My Pi session '${input.externalThreadId}' was not found locally.`,
              }),
            ),
      ),
    ),
};

export function makeOmpAdapter(
  ompSettings: OmpAcpRuntimeSettings,
  options?: OmpAdapterLiveOptions,
) {
  // The shared core builds the shape generically over hooks.provider; the
  // literal is fixed by OMP_HOOKS so the cast is safe.
  return makeSharedAcpAdapter(
    ompSettings as OmpSharedSettings,
    OMP_HOOKS,
    options,
  ) as Effect.Effect<OmpAdapterShape, never, never>;
}

export const OmpAdapterLive = Layer.effect(OmpAdapter, makeOmpAdapter({}));

export function makeOmpAdapterLive(
  ompSettings: OmpAcpRuntimeSettings = {},
  options?: OmpAdapterLiveOptions,
) {
  return Layer.effect(OmpAdapter, makeOmpAdapter(ompSettings, options));
}
