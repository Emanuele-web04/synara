/**
 * Droid ACP support - builds the Factory Droid `droid exec --output-format acp` command and resolves auth.
 *
 * @module DroidAcpSupport
 */
import { existsSync } from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";

import { type DroidModelOptions } from "@t3tools/contracts";
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

export interface DroidAcpRuntimeSettings {
  readonly binaryPath?: string;
  readonly model?: string;
  readonly reasoningEffort?: DroidModelOptions["reasoningEffort"];
  readonly skipPermissionsUnsafe?: boolean;
}

export interface DroidAcpRuntimeInput extends Omit<
  AcpSessionRuntimeOptions,
  "authMethodId" | "resolveAuthMethodId" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly droidSettings: DroidAcpRuntimeSettings | null | undefined;
}

export interface DroidAcpModelSelectionErrorContext {
  readonly cause: EffectAcpErrors.AcpError;
  readonly method: "session/set_config_option";
}

const DROID_API_KEY_AUTH_METHOD_ID = "factory-api-key";
const DROID_DEVICE_PAIRING_AUTH_METHOD_ID = "device-pairing";
const DROID_API_KEY_ENV_KEYS = ["FACTORY_API_KEY"] as const;

export function getDroidApiKeyEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const key of DROID_API_KEY_ENV_KEYS) {
    const value = env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

export function hasDroidApiKeyEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return getDroidApiKeyEnv(env) !== undefined;
}

/** Resolves `droid` when the dev server PATH omits `~/.local/bin` (common under turbo). */
export function resolveDroidCliBinaryPath(binaryPath?: string | null): string {
  const configured = binaryPath?.trim();
  if (configured) {
    return configured;
  }
  const name = "droid";
  if (process.platform !== "win32") {
    const localBin = nodePath.join(nodeOs.homedir(), ".local", "bin", name);
    if (existsSync(localBin)) {
      return localBin;
    }
  }
  const searchPath = process.env.PATH ?? "";
  for (const directory of searchPath.split(nodePath.delimiter)) {
    if (!directory.trim()) {
      continue;
    }
    const candidate = nodePath.join(directory, name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return name;
}

export function buildDroidAcpSpawnInput(
  droidSettings: DroidAcpRuntimeSettings | null | undefined,
  cwd: string,
): AcpSpawnInput {
  const args = ["exec", "--output-format", "acp"];
  if (droidSettings?.skipPermissionsUnsafe === true) {
    args.push("--skip-permissions-unsafe");
  }
  const model = droidSettings?.model?.trim();
  if (model) {
    args.push("-m", model);
  }
  const reasoningEffort = droidSettings?.reasoningEffort?.trim();
  if (reasoningEffort) {
    args.push("-r", reasoningEffort);
  }

  return {
    command: resolveDroidCliBinaryPath(droidSettings?.binaryPath),
    args,
    cwd,
  };
}

function availableAuthMethodIds(
  initializeResult: EffectAcpSchema.InitializeResponse,
): ReadonlySet<string> {
  return new Set((initializeResult.authMethods ?? []).map((method) => method.id.trim()));
}

export const resolveDroidAcpAuthMethodId = (
  initializeResult: EffectAcpSchema.InitializeResponse,
): Effect.Effect<string, EffectAcpErrors.AcpError> =>
  Effect.gen(function* () {
    const authMethodIds = availableAuthMethodIds(initializeResult);
    if (hasDroidApiKeyEnv() && authMethodIds.has(DROID_API_KEY_AUTH_METHOD_ID)) {
      return DROID_API_KEY_AUTH_METHOD_ID;
    }
    if (authMethodIds.has(DROID_DEVICE_PAIRING_AUTH_METHOD_ID)) {
      return DROID_DEVICE_PAIRING_AUTH_METHOD_ID;
    }
    return yield* new EffectAcpErrorsRuntime.AcpRequestError({
      code: -32602,
      errorMessage: "Droid ACP authentication is unavailable.",
      data: {
        authMethods: [...authMethodIds],
        detail: "Run `droid` to authenticate locally, or set FACTORY_API_KEY.",
      },
    });
  });

export const makeDroidAcpRuntime = (
  input: DroidAcpRuntimeInput,
): Effect.Effect<AcpSessionRuntimeShape, EffectAcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildDroidAcpSpawnInput(input.droidSettings, input.cwd),
        resolveAuthMethodId: resolveDroidAcpAuthMethodId,
        authenticateMeta: { headless: true },
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return ServiceMap.getUnsafe(acpContext, AcpSessionRuntime);
  });

export function applyDroidAcpModelSelection<E>(input: {
  readonly runtime: Pick<
    AcpSessionRuntimeShape,
    "getConfigOptions" | "setConfigOption" | "setModel"
  >;
  readonly model: string;
  readonly options?: DroidModelOptions | null | undefined;
  readonly mapError: (context: DroidAcpModelSelectionErrorContext) => E;
}): Effect.Effect<void, E> {
  void input;
  return Effect.void;
}
