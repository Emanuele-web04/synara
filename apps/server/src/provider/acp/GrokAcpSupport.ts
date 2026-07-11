/**
 * Grok ACP support - builds the Grok Build stdio command and resolves auth.
 *
 * @module GrokAcpSupport
 */
import { type GrokModelOptions } from "@synara/contracts";
import { Effect, Layer, Scope, ServiceMap } from "effect";
import type * as EffectAcpErrors from "effect-acp/errors";
import * as EffectAcpErrorsRuntime from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
  type AcpSpawnInput,
} from "./AcpSessionRuntime.ts";
import { buildProviderProcessEnv } from "../providerProcessEnv.ts";

export interface GrokAcpRuntimeSettings {
  readonly binaryPath?: string;
  readonly model?: string;
  readonly reasoningEffort?: GrokModelOptions["reasoningEffort"];
  readonly alwaysApprove?: boolean;
  readonly environment?: Readonly<Record<string, string>>;
  readonly instanceId?: string;
  readonly homeDir?: string;
  readonly isolationRootDir?: string;
}

export interface GrokAcpRuntimeInput extends Omit<
  AcpSessionRuntimeOptions,
  "authMethodId" | "resolveAuthMethodId" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly grokSettings: GrokAcpRuntimeSettings | null | undefined;
}

export interface GrokAcpModelSelectionErrorContext {
  readonly cause: EffectAcpErrors.AcpError;
  readonly method: "session/set_config_option";
}

const GROK_API_KEY_AUTH_METHOD_ID = "xai.api_key";
const GROK_CACHED_TOKEN_AUTH_METHOD_ID = "cached_token";
const GROK_API_KEY_ENV_KEYS = ["XAI_API_KEY", "GROK_CODE_XAI_API_KEY"] as const;

export function getGrokApiKeyEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const key of GROK_API_KEY_ENV_KEYS) {
    const value = env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

export function hasGrokApiKeyEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return getGrokApiKeyEnv(env) !== undefined;
}

export function buildGrokAcpSpawnInput(
  grokSettings: GrokAcpRuntimeSettings | null | undefined,
  cwd: string,
): AcpSpawnInput {
  const args = ["agent", "--no-leader"];
  if (grokSettings?.alwaysApprove === true) {
    // Grok's approval flag belongs to `grok agent`, before the `stdio` subcommand.
    args.push("--always-approve");
  }
  const model = grokSettings?.model?.trim();
  if (model) {
    args.push("-m", model);
  }
  const reasoningEffort = grokSettings?.reasoningEffort?.trim();
  if (reasoningEffort) {
    args.push("--reasoning-effort", reasoningEffort);
  }
  args.push("stdio");

  return {
    command: grokSettings?.binaryPath || "grok",
    args,
    cwd,
    providerEnvironment: {
      driver: "grok",
      ...(grokSettings?.instanceId !== undefined ? { instanceId: grokSettings.instanceId } : {}),
      ...(grokSettings?.environment !== undefined ? { environment: grokSettings.environment } : {}),
      ...(grokSettings?.homeDir !== undefined ? { homeDir: grokSettings.homeDir } : {}),
      ...(grokSettings?.isolationRootDir !== undefined
        ? { isolationRootDir: grokSettings.isolationRootDir }
        : {}),
    },
  };
}

function availableAuthMethodIds(
  initializeResult: EffectAcpSchema.InitializeResponse,
): ReadonlySet<string> {
  return new Set((initializeResult.authMethods ?? []).map((method) => method.id.trim()));
}

export const resolveGrokAcpAuthMethodIdForEnv =
  (
    environment?: Readonly<Record<string, string>> | undefined,
    instanceId?: string | undefined,
    homeDir?: string | undefined,
    isolationRootDir?: string | undefined,
  ) =>
  (
    initializeResult: EffectAcpSchema.InitializeResponse,
  ): Effect.Effect<string, EffectAcpErrors.AcpError> =>
    Effect.gen(function* () {
      const authMethodIds = availableAuthMethodIds(initializeResult);
      const effectiveEnv = yield* Effect.try({
        try: () =>
          buildProviderProcessEnv({
            driver: "grok",
            ...(environment !== undefined ? { environment } : {}),
            ...(instanceId !== undefined ? { instanceId } : {}),
            ...(homeDir !== undefined ? { homeDir } : {}),
            ...(isolationRootDir !== undefined ? { isolationRootDir } : {}),
          }),
        catch: (cause) => new EffectAcpErrorsRuntime.AcpSpawnError({ command: "grok", cause }),
      });
      if (hasGrokApiKeyEnv(effectiveEnv) && authMethodIds.has(GROK_API_KEY_AUTH_METHOD_ID)) {
        return GROK_API_KEY_AUTH_METHOD_ID;
      }
      if (authMethodIds.has(GROK_CACHED_TOKEN_AUTH_METHOD_ID)) {
        return GROK_CACHED_TOKEN_AUTH_METHOD_ID;
      }
      return yield* new EffectAcpErrorsRuntime.AcpRequestError({
        code: -32602,
        errorMessage: "Grok ACP authentication is unavailable.",
        data: {
          authMethods: [...authMethodIds],
          detail: "Run `grok` to authenticate locally, or set XAI_API_KEY.",
        },
      });
    });

export const resolveGrokAcpAuthMethodId = resolveGrokAcpAuthMethodIdForEnv();

export const makeGrokAcpRuntime = (
  input: GrokAcpRuntimeInput,
): Effect.Effect<AcpSessionRuntimeShape, EffectAcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildGrokAcpSpawnInput(input.grokSettings, input.cwd),
        resolveAuthMethodId: resolveGrokAcpAuthMethodIdForEnv(
          input.grokSettings?.environment,
          input.grokSettings?.instanceId,
          input.grokSettings?.homeDir,
          input.grokSettings?.isolationRootDir,
        ),
        authenticateMeta: { headless: true },
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return ServiceMap.getUnsafe(acpContext, AcpSessionRuntime);
  });

export function applyGrokAcpModelSelection<E>(input: {
  readonly runtime: Pick<
    AcpSessionRuntimeShape,
    "getConfigOptions" | "setConfigOption" | "setModel"
  >;
  readonly model: string;
  readonly options?: GrokModelOptions | null | undefined;
  readonly mapError: (context: GrokAcpModelSelectionErrorContext) => E;
}): Effect.Effect<void, E> {
  void input;
  // Grok ACP 0.1.210 advertises models in initialize/session responses but does
  // not implement `session/set_config_option`. Model and effort are therefore
  // process-start settings supplied by `buildGrokAcpSpawnInput`.
  return Effect.void;
}
