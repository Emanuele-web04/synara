/**
 * Devin ACP support - builds the Devin stdio command and resolves auth.
 *
 * Devin sessions use on-demand authentication: they try stored CLI credentials first,
 * and only call authenticate (browser PKCE) when the agent explicitly rejects session
 * creation as unauthenticated.
 *
 * @module DevinAcpSupport
 */
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
import { buildProviderChildEnvironment } from "../../providerChildEnvironment.ts";

export interface DevinAcpRuntimeSettings {
  readonly binaryPath?: string;
}

export interface DevinAcpRuntimeInput extends Omit<
  AcpSessionRuntimeOptions,
  "authMethodId" | "resolveAuthMethodId" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly devinSettings: DevinAcpRuntimeSettings | null | undefined;
}

export const DEVIN_WINDSURF_API_KEY_AUTH_METHOD_ID = "windsurf-api-key";
export const DEVIN_BROWSER_LOGIN_AUTH_METHOD_ID = "browser_login";
// Accept both the canonical uppercase `WINDSURF_API_KEY` and the lowercase
// `windsurf_api_key` that some secret/credential injectors provide.
export const DEVIN_API_KEY_ENV_KEYS = ["WINDSURF_API_KEY", "windsurf_api_key"] as const;

export function resolveDevinApiKeyEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const key of DEVIN_API_KEY_ENV_KEYS) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

export function hasDevinApiKeyEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(resolveDevinApiKeyEnv(env));
}

export function resolveDevinBinaryPath(binaryPath?: string | null | undefined): string {
  const trimmed = binaryPath?.trim();
  return trimmed || "devin";
}

export function buildDevinAcpSpawnInput(
  devinSettings: DevinAcpRuntimeSettings | null | undefined,
  cwd: string,
): AcpSpawnInput {
  // The Devin ACP server expects `WINDSURF_API_KEY`. If only the lowercase
  // variant is present, normalize it to the canonical key for the child.
  const apiKey = resolveDevinApiKeyEnv();
  const overrides: NodeJS.ProcessEnv = apiKey ? { WINDSURF_API_KEY: apiKey } : {};
  return {
    command: resolveDevinBinaryPath(devinSettings?.binaryPath),
    args: ["acp"],
    cwd,
    env: buildProviderChildEnvironment({
      provider: "devin",
      overrides,
    }),
  };
}

function availableAuthMethodIds(
  initializeResult: EffectAcpSchema.InitializeResponse,
): ReadonlySet<string> {
  return new Set((initializeResult.authMethods ?? []).map((method) => method.id.trim()));
}

export const resolveDevinAcpAuthMethodId = (
  initializeResult: EffectAcpSchema.InitializeResponse,
  env: NodeJS.ProcessEnv = process.env,
): Effect.Effect<string, EffectAcpErrors.AcpError> =>
  Effect.gen(function* () {
    const authMethodIds = availableAuthMethodIds(initializeResult);
    const hasApiKey = hasDevinApiKeyEnv(env);

    if (hasApiKey && authMethodIds.has(DEVIN_WINDSURF_API_KEY_AUTH_METHOD_ID)) {
      return DEVIN_WINDSURF_API_KEY_AUTH_METHOD_ID;
    }
    // Prefer the interactive flow when no API key is available. Selecting the
    // advertised API-key method without a key makes on-demand recovery fail
    // before the usable browser-login method gets a chance to run.
    if (authMethodIds.has(DEVIN_BROWSER_LOGIN_AUTH_METHOD_ID)) {
      return DEVIN_BROWSER_LOGIN_AUTH_METHOD_ID;
    }

    return yield* new EffectAcpErrorsRuntime.AcpRequestError({
      code: -32602,
      errorMessage: "Devin ACP authentication is unavailable.",
      data: {
        authMethods: [...authMethodIds],
        detail: hasApiKey
          ? "Devin did not advertise Windsurf API key authentication."
          : "Run `devin auth login`, or set WINDSURF_API_KEY.",
      },
    });
  });

export const makeDevinAcpRuntime = (
  input: DevinAcpRuntimeInput,
): Effect.Effect<AcpSessionRuntimeShape, EffectAcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildDevinAcpSpawnInput(input.devinSettings, input.cwd),
        resolveAuthMethodId: resolveDevinAcpAuthMethodId,
        authenticateMeta: { headless: true },
        authPolicy: "on-demand",
        clientCapabilities: {
          ...input.clientCapabilities,
          elicitation: { form: {} },
        },
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return ServiceMap.getUnsafe(acpContext, AcpSessionRuntime);
  });
