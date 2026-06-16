/**
 * Kimi ACP support - builds the Kimi Code `kimi acp` stdio command and resolves auth.
 *
 * Kimi Code speaks the Agent Client Protocol over stdio via `kimi acp`. Unlike
 * Grok it takes no model/effort argv flags: the managed `kimi-for-coding` model
 * is selected by the CLI itself, so the spawn command is just `kimi acp`.
 *
 * Credentials live in Kimi's on-disk store (populated by `kimi login` / the
 * in-CLI `/login` flow); the ACP server reuses them. The runtime always issues
 * an ACP `authenticate` call, so we resolve the advertised login method (and
 * default to "login") — Kimi answers `authRequired` when no credentials exist,
 * which surfaces as a clear "run `kimi login`" error.
 *
 * @module KimiAcpSupport
 */
import { type ProviderModelDescriptor } from "@t3tools/contracts";
import { Effect, Layer, Scope, ServiceMap } from "effect";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
  type AcpSpawnInput,
} from "./AcpSessionRuntime.ts";

export interface KimiAcpRuntimeSettings {
  readonly binaryPath?: string;
}

export interface KimiAcpRuntimeInput extends Omit<
  AcpSessionRuntimeOptions,
  "authMethodId" | "resolveAuthMethodId" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly kimiSettings: KimiAcpRuntimeSettings | null | undefined;
}

export interface KimiAcpModelSelectionErrorContext {
  readonly cause: EffectAcpErrors.AcpError;
  readonly method: "session/set_config_option";
}

export const DEFAULT_KIMI_BINARY = "kimi";
const KIMI_LOGIN_AUTH_METHOD_ID = "login";

export function buildKimiAcpSpawnInput(
  kimiSettings: KimiAcpRuntimeSettings | null | undefined,
  cwd: string,
): AcpSpawnInput {
  return {
    command: kimiSettings?.binaryPath?.trim() || DEFAULT_KIMI_BINARY,
    args: ["acp"],
    cwd,
  };
}

function availableAuthMethodIds(
  initializeResult: EffectAcpSchema.InitializeResponse,
): ReadonlyArray<string> {
  return (initializeResult.authMethods ?? [])
    .map((method) => method.id.trim())
    .filter((id) => id.length > 0);
}

export const resolveKimiAcpAuthMethodId = (
  initializeResult: EffectAcpSchema.InitializeResponse,
): Effect.Effect<string, EffectAcpErrors.AcpError> =>
  Effect.sync(() => {
    const authMethodIds = availableAuthMethodIds(initializeResult);
    if (authMethodIds.includes(KIMI_LOGIN_AUTH_METHOD_ID)) {
      return KIMI_LOGIN_AUTH_METHOD_ID;
    }
    // Prefer whatever the agent advertised; fall back to "login" so the runtime
    // still issues `authenticate` and Kimi can answer `authRequired` itself.
    return authMethodIds[0] ?? KIMI_LOGIN_AUTH_METHOD_ID;
  });

export const makeKimiAcpRuntime = (
  input: KimiAcpRuntimeInput,
): Effect.Effect<AcpSessionRuntimeShape, EffectAcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildKimiAcpSpawnInput(input.kimiSettings, input.cwd),
        resolveAuthMethodId: resolveKimiAcpAuthMethodId,
        authenticateMeta: { headless: true },
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return ServiceMap.getUnsafe(acpContext, AcpSessionRuntime);
  });

// Kimi reports its current model(s) in the `model` config option returned by
// `session/new` (e.g. value `kimi-code/kimi-for-coding`, name "K2.7 Code"). The
// backend behind the managed alias auto-updates, so this is the authoritative,
// always-live source for the picker's model name.
export function buildKimiModelDescriptorsFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): ReadonlyArray<ProviderModelDescriptor> {
  const modelOption = configOptions.find(
    (option) =>
      option.type === "select" &&
      (option.category === "model" || option.id.trim().toLowerCase() === "model"),
  );
  if (!modelOption || modelOption.type !== "select") {
    return [];
  }

  const seen = new Set<string>();
  const descriptors: Array<ProviderModelDescriptor> = [];
  for (const entry of modelOption.options) {
    const flattened = "value" in entry ? [entry] : entry.options;
    for (const option of flattened) {
      const value = option.value.trim();
      if (!value) {
        continue;
      }
      // Kimi reports managed model values as `<provider>/<model>`; keep the bare
      // model id as the Synara slug so it stays consistent with the configured
      // default (`kimi-for-coding`) and dedupes against the built-in fallback.
      const slug = value.includes("/") ? value.slice(value.lastIndexOf("/") + 1).trim() : value;
      if (!slug || seen.has(slug)) {
        continue;
      }
      seen.add(slug);
      const name = option.name?.trim();
      descriptors.push({ slug, name: name && name.length > 0 ? name : slug });
    }
  }
  return descriptors;
}

export function applyKimiAcpModelSelection<E>(input: {
  readonly runtime: Pick<
    AcpSessionRuntimeShape,
    "getConfigOptions" | "setConfigOption" | "setModel"
  >;
  readonly model: string;
  readonly mapError: (context: KimiAcpModelSelectionErrorContext) => E;
}): Effect.Effect<void, E> {
  void input;
  // Kimi Code exposes a single managed model (`kimi-for-coding`) selected by the
  // CLI; there are no client-tunable model/effort knobs to push over ACP today.
  return Effect.void;
}
