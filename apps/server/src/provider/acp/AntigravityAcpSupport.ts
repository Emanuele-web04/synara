/**
 * Antigravity ACP support - builds the `agy acp` stdio command, resolves auth,
 * applies model selection, and normalizes Antigravity's tool-call quirks.
 *
 * `agy acp` (Antigravity CLI 1.5.0+) accepts MCP servers per session, so
 * Synara's gateway and connector servers reach the agent without touching the
 * user's global or plugin MCP configuration.
 *
 * @module AntigravityAcpSupport
 */
import { Effect, Layer, Scope, ServiceMap } from "effect";
import type { UserInputQuestion } from "@synara/contracts";
import type * as Acp from "@agentclientprotocol/sdk";
import { ChildProcessSpawner } from "effect/unstable/process";
import { resolveExecutionWorkspacePath } from "@synara/shared/wslBridge";

import { buildProviderChildEnvironment } from "../../providerChildEnvironment.ts";
import * as AcpErrors from "./AcpErrors.ts";
import { parseAntigravityCliModelLabel } from "../antigravityCli.ts";
import {
  availableAuthMethodIds,
  findSelectConfig,
  flattenConfigOptions,
} from "./AcpConfigOptions.ts";
import type { AcpToolCallState } from "./AcpRuntimeModel.ts";
import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
  type AcpSpawnInput,
} from "./AcpSessionRuntime.ts";

export interface AntigravityAcpRuntimeSettings {
  readonly binaryPath?: string;
  readonly environment?: Readonly<Record<string, string>>;
}

export interface AntigravityAcpRuntimeInput extends Omit<
  AcpSessionRuntimeOptions,
  "authMethodId" | "resolveAuthMethodId" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly antigravitySettings: AntigravityAcpRuntimeSettings | null | undefined;
  readonly additionalDirectories?: ReadonlyArray<string>;
}

/** One entry of the model list `agy acp` returns from session setup. */
export interface AntigravityAcpModel {
  readonly modelId: string;
  readonly name: string;
}

export const antigravityModelConfig = (options: ReadonlyArray<Acp.SessionConfigOption>) =>
  findSelectConfig(options, { id: "model", category: "model" });

export const antigravityThoughtLevelConfig = (options: ReadonlyArray<Acp.SessionConfigOption>) =>
  findSelectConfig(options, { id: "thought_level", category: "thought_level" });

/** The config option is authoritative whenever the agent advertises it. */
export function readAntigravityConfigModels(
  config: NonNullable<ReturnType<typeof antigravityModelConfig>>,
) {
  return {
    currentModelId: config.currentValue,
    availableModels: flattenConfigOptions(config.options).map((option) => ({
      modelId: option.value,
      name: option.name,
    })),
  };
}

const ANTIGRAVITY_API_KEY_AUTH_METHOD_ID = "gemini-api-key";
const ANTIGRAVITY_API_KEY_ENV_KEYS = ["GEMINI_API_KEY"] as const;

/** 1.5.0 introduced live prompt injection. Unknown and prerelease versions use the fallback. */
export function antigravitySupportsTurnSteering(initialize: Acp.InitializeResponse): boolean {
  if (!/antigravity|\bagy\b/iu.test(initialize.agentInfo?.name ?? "")) return false;
  const version = initialize.agentInfo?.version?.match(/^v?(\d+)\.(\d+)\.(\d+)(?:\+[\w.-]+)?$/u);
  if (!version) return false;
  const major = Number(version[1]);
  return major > 1 || (major === 1 && Number(version[2]) >= 5);
}

export function buildAntigravityAcpSpawnInput(
  settings: AntigravityAcpRuntimeSettings | null | undefined,
  cwd: string,
  additionalDirectories: ReadonlyArray<string> = [],
): AcpSpawnInput {
  const baseEnv = { ...process.env, ...settings?.environment };
  return {
    command: settings?.binaryPath?.trim() || "agy",
    args: [
      "acp",
      // ACP workspace roots are process-scoped; the adapter supplies only project grants.
      ...additionalDirectories.flatMap((directory) => [
        "--add-dir",
        resolveExecutionWorkspacePath(directory, cwd),
      ]),
    ],
    cwd,
    env: buildProviderChildEnvironment({ provider: "antigravity", baseEnv }),
  };
}

export const resolveAntigravityAcpAuthMethodId = (
  initializeResult: Acp.InitializeResponse,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.Effect<string, AcpErrors.AcpError> =>
  Effect.gen(function* () {
    const authMethodIds = availableAuthMethodIds(initializeResult);
    const hasApiKey = ANTIGRAVITY_API_KEY_ENV_KEYS.some((key) => environment[key]?.trim());
    if (hasApiKey && authMethodIds.has(ANTIGRAVITY_API_KEY_AUTH_METHOD_ID)) {
      return ANTIGRAVITY_API_KEY_AUTH_METHOD_ID;
    }
    return yield* new AcpErrors.AcpRequestError({
      code: -32602,
      errorMessage: "Antigravity is not signed in.",
      data: {
        authMethods: [...authMethodIds],
        detail:
          "Run `agy` in a terminal (or `agy acp --login` over SSH) and sign in with Google, or set GEMINI_API_KEY.",
      },
    });
  });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Agy sends native questions through request_permission even in full-access mode. */
export function antigravityInteractionQuestion(
  request: Acp.RequestPermissionRequest,
): UserInputQuestion | undefined {
  const ids = new Set(request.options.map((option) => option.optionId));
  if (ids.size !== request.options.length || ids.size === 0 || [...ids].some((id) => !id.trim())) {
    return undefined;
  }
  return {
    id: request.toolCall.toolCallId,
    header: "Question",
    question: request.toolCall.title?.trim().slice(0, 4_000) || "Choose an option.",
    multiSelect: false,
    allowCustomAnswer: false,
    options: request.options.map((option) => {
      const label = (option.name.trim() || option.optionId.trim()).slice(0, 512);
      return { value: option.optionId, label, description: label };
    }),
  };
}

/**
 * Native identifier for an Antigravity MCP call in the `mcp__<server>__<tool>`
 * form Claude uses, which the timeline splits into "Server: Tool". Antigravity
 * names eager MCP tools `mcp_<server>_<tool>` (server names may contain `_`,
 * so the session's own server names find the boundary) and calls lazy ones
 * through `call_mcp_tool` with `ServerName` and `ToolName`.
 */
function antigravityMcpToolName(
  name: string,
  rawInput: Record<string, unknown>,
  serverNames: ReadonlyArray<string>,
): string | undefined {
  if (name === "call_mcp_tool") {
    const server = stringField(rawInput, "ServerName");
    const tool = stringField(rawInput, "ToolName");
    return server && tool ? `mcp__${server}__${tool}` : undefined;
  }
  if (!name.startsWith("mcp_")) return undefined;
  const rest = name.slice("mcp_".length);
  const server = serverNames
    .filter((candidate) => rest.startsWith(`${candidate}_`))
    .toSorted((left, right) => right.length - left.length)[0];
  return server ? `mcp__${server}__${rest.slice(server.length + 1)}` : undefined;
}

/**
 * Rewrites Antigravity's tool-call quirks into the shapes the shared ACP model
 * and timeline already present for Claude, Codex, and other ACP agents:
 * - the non-standard `name` becomes `rawInput._toolName`, where native names
 *   are read (image generation, Computer tools, subagents);
 * - MCP calls are named `mcp__<server>__<tool>` instead of "Run mcp_...";
 * - `run_command` exposes its `CommandLine` as `command` ("Ran `ls -la`");
 * - "File <name>" titles on located read/edit calls are dropped so the row
 *   reads "Read"/"Edited" with the path, like other providers.
 */
export function normalizeAntigravityToolCallUpdate(
  message: unknown,
  serverNames: ReadonlyArray<string> = [],
): unknown {
  if (!isRecord(message) || message.method !== "session/update" || !isRecord(message.params)) {
    return message;
  }
  const update = message.params.update;
  if (
    !isRecord(update) ||
    (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update")
  ) {
    return message;
  }
  const name = stringField(update, "name");
  if (!name) return message;
  const rawInput = isRecord(update.rawInput) ? update.rawInput : {};
  const mcpName = antigravityMcpToolName(name, rawInput, serverNames);
  const { title: originalTitle, ...updateWithoutTitle } = update;
  let title = typeof originalTitle === "string" ? originalTitle : undefined;
  if (title?.trim() === `Run ${name}` || (mcpName && name === "call_mcp_tool")) {
    title = mcpName ?? name;
  }
  if (
    title &&
    /^File\s/u.test(title) &&
    Array.isArray(update.locations) &&
    update.locations.length > 0
  ) {
    title = undefined;
  }
  const commandLine = stringField(rawInput, "CommandLine");
  return {
    ...message,
    params: {
      ...message.params,
      update: {
        ...updateWithoutTitle,
        ...(title !== undefined ? { title } : {}),
        rawInput: {
          ...rawInput,
          ...(commandLine && rawInput.command === undefined ? { command: commandLine } : {}),
          _toolName: mcpName ?? name,
        },
      },
    },
  };
}

/**
 * Antigravity's own one-line description of a call (`toolSummary`), used as
 * the row preview when the shared model has nothing better than the title.
 */
export function withAntigravityToolSummary<T extends AcpToolCallState>(toolCall: T): T {
  const rawInput = toolCall.data.rawInput;
  const summary = isRecord(rawInput) ? stringField(rawInput, "toolSummary") : undefined;
  if (!summary || (toolCall.detail !== undefined && toolCall.detail !== toolCall.title)) {
    return toolCall;
  }
  return { ...toolCall, detail: summary };
}

export const makeAntigravityAcpRuntime = (
  input: AntigravityAcpRuntimeInput,
): Effect.Effect<AcpSessionRuntimeShape, AcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const spawn = yield* Effect.try({
      try: () =>
        buildAntigravityAcpSpawnInput(
          input.antigravitySettings,
          input.cwd,
          input.additionalDirectories,
        ),
      catch: (cause) =>
        new AcpErrors.AcpRequestError({
          code: -32602,
          errorMessage:
            cause instanceof Error ? cause.message : "Invalid Antigravity folder access.",
        }),
    });
    // The normalizer needs this session's MCP server names to split
    // `mcp_<server>_<tool>`; they are known once session setup builds them.
    const serverNames: string[] = [];
    const buildMcpServers = input.buildMcpServers;
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        ...(buildMcpServers
          ? {
              buildMcpServers: (initializeResult: Acp.InitializeResponse) => {
                const servers = buildMcpServers(initializeResult);
                serverNames.splice(0, serverNames.length, ...servers.map((server) => server.name));
                return servers;
              },
            }
          : {}),
        spawn,
        authPolicy: "on-demand",
        resolveAuthMethodId: (initializeResult) =>
          resolveAntigravityAcpAuthMethodId(initializeResult, {
            ...process.env,
            ...input.antigravitySettings?.environment,
          }),
        normalizeIncomingMessage: (message) =>
          normalizeAntigravityToolCallUpdate(message, serverNames),
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return ServiceMap.getUnsafe(acpContext, AcpSessionRuntime);
  });

/** Reads the `models` block `agy acp` attaches to session/new, load, and resume. */
export function readAntigravityAcpModels(setupResult: unknown): {
  readonly currentModelId?: string;
  readonly availableModels: ReadonlyArray<AntigravityAcpModel>;
} {
  const models = isRecord(setupResult) && isRecord(setupResult.models) ? setupResult.models : {};
  const availableModels = Array.isArray(models.availableModels)
    ? models.availableModels.flatMap((entry): AntigravityAcpModel[] =>
        isRecord(entry) && typeof entry.modelId === "string" && typeof entry.name === "string"
          ? [{ modelId: entry.modelId, name: entry.name }]
          : [],
      )
    : [];
  return {
    ...(typeof models.currentModelId === "string" ? { currentModelId: models.currentModelId } : {}),
    availableModels,
  };
}

/**
 * Finds the ACP model id for a Synara selection. Selections use the CLI
 * display label ("Gemini 4 Neon (High)"), which `agy acp` reports verbatim as
 * each model's name; a raw model id is accepted as well.
 */
export function resolveAntigravityAcpModelId(
  availableModels: ReadonlyArray<AntigravityAcpModel>,
  cliModelLabel: string,
): string | undefined {
  const wanted = cliModelLabel.trim().toLowerCase();
  const exactId = availableModels.find((model) => model.modelId === cliModelLabel);
  if (exactId) return exactId.modelId;
  const matching = availableModels.filter(
    (model) => model.name.trim().toLowerCase() === wanted || model.modelId.toLowerCase() === wanted,
  );
  return matching.length === 1 ? matching[0]?.modelId : undefined;
}

export type AntigravityAcpModelChoice =
  /** An exact model (model + thinking level), applied with `session/set_model`. */
  | { readonly kind: "model"; readonly modelId: string }
  /** Only the base model is known; agy applies its default thinking level. */
  | { readonly kind: "base"; readonly baseName: string }
  | { readonly kind: "unavailable" };

function baseModelName(label: string): string {
  return (parseAntigravityCliModelLabel(label)?.model ?? label).trim();
}

/**
 * Picks the ACP model for a Synara selection. A selection without a usable
 * thinking level (a resumed thread before model discovery ran, or a level the
 * model no longer offers) keeps the session's current level of the same base
 * model, or lets agy choose its default, instead of failing or substituting
 * another model.
 */
export function chooseAntigravityAcpModel(
  availableModels: ReadonlyArray<AntigravityAcpModel>,
  cliModelLabel: string,
  currentModelId: string | undefined,
): AntigravityAcpModelChoice {
  const exact = resolveAntigravityAcpModelId(availableModels, cliModelLabel);
  if (exact) return { kind: "model", modelId: exact };
  const base = baseModelName(cliModelLabel).toLowerCase();
  // Orchestrator's parenthesized name identifies the planner, not a thinking level.
  if (base === "orchestrator" && cliModelLabel.trim().toLowerCase() !== base) {
    return { kind: "unavailable" };
  }
  const sameBase = availableModels.filter(
    (model) => baseModelName(model.name).toLowerCase() === base,
  );
  if (sameBase.length === 0) return { kind: "unavailable" };
  if (base === "orchestrator" && sameBase.length === 1) {
    return { kind: "model", modelId: sameBase[0]!.modelId };
  }
  if (currentModelId && sameBase.some((model) => model.modelId === currentModelId)) {
    return { kind: "model", modelId: currentModelId };
  }
  return { kind: "base", baseName: baseModelName(sameBase[0]!.name) };
}

/** Switches the session model with ACP's `session/set_model`, which `agy acp` implements. */
export function setAntigravityAcpModel(
  runtime: Pick<AcpSessionRuntimeShape, "request">,
  sessionId: string,
  modelId: string,
): Effect.Effect<void, AcpErrors.AcpError> {
  return runtime.request("session/set_model", { sessionId, modelId }).pipe(Effect.asVoid);
}
