/**
 * AcpAdapterLive - generic ACP agent (`acp`) via ACP. Thin wiring of the
 * shared ACP adapter core for user-registered agents.
 *
 * @module AcpAdapterLive
 */
import { Effect, Layer } from "effect";

import { AcpAdapter, type AcpAdapterShape } from "../Services/AcpAdapter.ts";
import {
  applyAcpAgentModelSelection,
  makeGenericAcpRuntime,
  type AcpAgentRuntimeSettings,
} from "../acp/GenericAcpSupport.ts";
import {
  type SharedAcpAdapterHooks,
  type SharedAcpAdapterOptions,
  makeSharedAcpAdapter,
} from "./AcpAdapterCore.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";

export interface AcpAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

const ACP_PLAN_MODE_PROMPT_PREFIX = [
  "Synara ACP agent plan mode is active.",
  "Do not implement or mutate files in this turn.",
  "Do not ask follow-up questions or wait for confirmation; if scope is ambiguous, choose a reasonable default and state the assumption in the plan.",
  "When ready, create the final implementation plan.",
].join("\n");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The resolved instance's ACP launch config reaches session start and
// discovery as top-level keys merged by ProviderDiscoveryService; the
// contract types stop at `binaryPath`, so read the extras defensively.
const acpOptionsToSettings = (input: unknown): Partial<AcpAgentRuntimeSettings> => {
  if (!isRecord(input)) return {};
  const command = typeof input.command === "string" ? input.command.trim() : "";
  const args = Array.isArray(input.args)
    ? input.args.filter((entry): entry is string => typeof entry === "string")
    : undefined;
  const authMethodId = typeof input.authMethodId === "string" ? input.authMethodId : undefined;
  const modelConfigId = typeof input.modelConfigId === "string" ? input.modelConfigId : undefined;
  const effortConfigId =
    typeof input.effortConfigId === "string" ? input.effortConfigId : undefined;
  const models = Array.isArray(input.models)
    ? (input.models as AcpAgentRuntimeSettings["models"])
    : undefined;
  const environment =
    isRecord(input.environment) && input.environment !== undefined
      ? (input.environment as Readonly<Record<string, string>>)
      : undefined;
  return {
    ...(command ? { command } : {}),
    ...(args !== undefined ? { args } : {}),
    ...(authMethodId !== undefined ? { authMethodId } : {}),
    ...(modelConfigId !== undefined ? { modelConfigId } : {}),
    ...(effortConfigId !== undefined ? { effortConfigId } : {}),
    ...(models !== undefined ? { models } : {}),
    ...(environment !== undefined ? { environment } : {}),
  };
};

const GENERIC_ACP_HOOKS: SharedAcpAdapterHooks<AcpAgentRuntimeSettings> = {
  provider: "acp",
  agentDisplayName: "The ACP agent",
  defaultInstanceId: "acp",
  debugEnvVar: "SYNARA_ACP_DEBUG",
  transportDebugMarker: "acp-meta-stripper-v2",
  logPrefix: "acp.agent",
  idleTimeoutEnvVar: "SYNARA_ACP_TURN_IDLE_TIMEOUT_MS",
  planModePromptPrefix: ACP_PLAN_MODE_PROMPT_PREFIX,
  // Baseline ACP guarantees only text + resource_link prompts; richer blocks
  // are gated on the agent's advertised prompt capabilities.
  gateImagesOnPromptCapabilities: true,
  // ACP exposes no standard on-disk session store to import transcripts from.
  supportsThreadImport: false,
  effortFromModelOptions: (options) =>
    (options as { readonly reasoningEffort?: string } | null | undefined)?.reasoningEffort,
  settingsFromProviderOptions: (providerOptions) => acpOptionsToSettings(providerOptions?.acp),
  settingsFromDiscoveryInput: acpOptionsToSettings,
  finalizeSettings: (merged) => merged,
  discoveryCacheFields: (settings) => [
    settings.args,
    settings.models,
    settings.authMethodId,
    settings.modelConfigId,
    settings.effortConfigId,
  ],
  makeRuntime: ({ settings, ...runtimeInput }) =>
    makeGenericAcpRuntime({
      ...runtimeInput,
      agentSettings: settings,
      childProcessSpawner: runtimeInput.childProcessSpawner,
    }),
  applyModelSelection: (input) => applyAcpAgentModelSelection(input),
};

export function makeAcpAdapter(
  agentSettings: AcpAgentRuntimeSettings,
  options?: AcpAdapterLiveOptions,
) {
  // The shared core builds the shape generically over hooks.provider; the
  // literal is fixed by GENERIC_ACP_HOOKS so the cast is safe.
  return makeSharedAcpAdapter(agentSettings, GENERIC_ACP_HOOKS, options) as Effect.Effect<
    AcpAdapterShape,
    never,
    never
  >;
}

export const AcpAdapterLive = Layer.effect(AcpAdapter, makeAcpAdapter({}));

export function makeAcpAdapterLive(
  agentSettings: AcpAgentRuntimeSettings = {},
  options?: AcpAdapterLiveOptions,
) {
  return Layer.effect(AcpAdapter, makeAcpAdapter(agentSettings, options));
}
