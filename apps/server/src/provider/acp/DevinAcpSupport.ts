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
export const DEVIN_API_KEY_ENV_KEYS = ["WINDSURF_API_KEY"] as const;

/** Env var prefixes and names to pass through to the Devin ACP child process. */
const DEVIN_ENV_ALLOWLIST_PREFIXES = ["DEVIN_", "WINDSURF_"] as const;
const DEVIN_ENV_ALLOWLIST_NAMES = new Set([
  "PATH",
  "Path",
  "HOME",
  "USER",
  "SHELL",
  "LANG",
  "TERM",
  "TMPDIR",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "ALL_PROXY",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "all_proxy",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  // Windows equivalents
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "SystemRoot",
  "PATHEXT",
  "COMSPEC",
]);

function buildDevinSpawnEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (
      DEVIN_ENV_ALLOWLIST_NAMES.has(key) ||
      DEVIN_ENV_ALLOWLIST_PREFIXES.some((prefix) => key.startsWith(prefix))
    ) {
      env[key] = value;
    }
  }
  return env;
}

export function buildDevinAcpSpawnInput(
  devinSettings: DevinAcpRuntimeSettings | null | undefined,
  cwd: string,
): AcpSpawnInput {
  return {
    command: devinSettings?.binaryPath?.trim() || "devin",
    args: ["acp"],
    cwd,
    env: buildDevinSpawnEnv(),
  };
}

function availableAuthMethodIds(
  initializeResult: EffectAcpSchema.InitializeResponse,
): ReadonlySet<string> {
  return new Set((initializeResult.authMethods ?? []).map((method) => method.id.trim()));
}

export function hasDevinApiKeyEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return DEVIN_API_KEY_ENV_KEYS.some((key) => Boolean(env[key]?.trim()));
}

export const resolveDevinAcpAuthMethodId = (
  initializeResult: EffectAcpSchema.InitializeResponse,
): Effect.Effect<string, EffectAcpErrors.AcpError> =>
  Effect.gen(function* () {
    const authMethodIds = availableAuthMethodIds(initializeResult);
    if (authMethodIds.has(DEVIN_WINDSURF_API_KEY_AUTH_METHOD_ID)) {
      return DEVIN_WINDSURF_API_KEY_AUTH_METHOD_ID;
    }

    return yield* new EffectAcpErrorsRuntime.AcpRequestError({
      code: -32602,
      errorMessage: "Devin ACP authentication is unavailable.",
      data: {
        authMethods: [...authMethodIds],
        detail: hasDevinApiKeyEnv()
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
