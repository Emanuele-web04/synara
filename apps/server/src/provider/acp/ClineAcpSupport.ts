import type { ProviderInteractionMode, ProviderModelDescriptor } from "@synara/contracts";
import { resolveExecutable } from "@synara/shared/executable";
import { Effect, Layer, Scope, ServiceMap } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { buildProviderChildEnvironment } from "../../providerChildEnvironment.ts";
import { AcpRequestError, type AcpError } from "./AcpErrors.ts";
import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
  type AcpSessionRuntimeStartResult,
  type AcpSpawnInput,
} from "./AcpSessionRuntime.ts";

export interface ClineAcpRuntimeSettings {
  readonly binaryPath?: string | undefined;
}

export interface ClineAcpRuntimeInput extends Omit<
  AcpSessionRuntimeOptions,
  "spawn" | "authMethodId" | "resolveAuthMethodId" | "authPolicy"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly clineSettings?: ClineAcpRuntimeSettings;
}

export function buildClineAcpSpawnInput(
  settings: ClineAcpRuntimeSettings | undefined,
  cwd: string,
): AcpSpawnInput {
  return {
    command: settings?.binaryPath?.trim() || resolveExecutable("cline") || "cline",
    // Never inherit --yolo or a saved auto-approval preference. Synara owns approvals.
    args: ["--acp", "--auto-approve", "false"],
    cwd,
    env: buildProviderChildEnvironment({ provider: "cline" }),
  };
}

export const makeClineAcpRuntime = (
  input: ClineAcpRuntimeInput,
): Effect.Effect<AcpSessionRuntimeShape, AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildClineAcpSpawnInput(input.clineSettings, input.cwd),
        // Persisted credentials / CLINE_API_KEY are restored by Cline itself.
        // Do not open an interactive login flow inside an unattended ACP child.
        authPolicy: "on-demand",
        resolveAuthMethodId: () =>
          Effect.fail(
            new AcpRequestError({
              code: -32000,
              errorMessage:
                "Cline authentication is required. Run `cline auth` in a terminal, then retry in Synara.",
            }),
          ),
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return ServiceMap.getUnsafe(context, AcpSessionRuntime);
  });

export function clineDefaultModel(result: AcpSessionRuntimeStartResult): string | undefined {
  const config = result.sessionSetupResult.configOptions?.find(
    (option) => option.category === "model" || option.id === "model",
  );
  return config?.type === "select" ? config.currentValue : undefined;
}

/** Preserve provider-scoped IDs verbatim; Cline, not Synara, owns this catalog. */
export function mapClineModels(result: AcpSessionRuntimeStartResult): ProviderModelDescriptor[] {
  const models = new Map<string, ProviderModelDescriptor>();
  const add = (slug: string, name: string, description?: string | null) => {
    if (!slug.trim()) return;
    models.set(slug, {
      slug,
      name: name.trim() || slug,
      ...(description?.trim() ? { description: description.trim() } : {}),
      supportedReasoningEfforts: [],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      supportsAutoMode: false,
      optionDescriptors: [],
    });
  };
  const config = result.sessionSetupResult.configOptions?.find(
    (option) => option.category === "model" || option.id === "model",
  );
  if (config?.type === "select") {
    for (const entry of config.options) {
      for (const option of "value" in entry ? [entry] : entry.options) {
        add(option.value, option.name, option.description);
      }
    }
  }
  const defaultModel = clineDefaultModel(result);
  const configured = defaultModel ? models.get(defaultModel) : undefined;
  return configured
    ? [
        { ...configured, slug: "default", name: `Cline configured model (${configured.name})` },
        ...models.values(),
      ]
    : [...models.values()];
}

export function configureClineSession(input: {
  readonly runtime: Pick<
    AcpSessionRuntimeShape,
    "awaitLoadReplayReady" | "getConfigOptions" | "setConfigOption" | "setMode"
  >;
  readonly model: string;
  readonly defaultModel: string | undefined;
  readonly interactionMode?: ProviderInteractionMode;
}): Effect.Effect<void, AcpError> {
  return Effect.gen(function* () {
    yield* input.runtime.awaitLoadReplayReady;
    const options = yield* input.runtime.getConfigOptions;
    const modelOption = options.find(
      (option) => option.category === "model" || option.id === "model",
    );
    const model = input.model === "default" ? input.defaultModel : input.model;
    if (!model || !modelOption) {
      return yield* new AcpRequestError({
        code: -32602,
        errorMessage:
          "Cline did not advertise a configured model. Update Cline and run `cline auth` before retrying.",
      });
    }
    yield* input.runtime.setConfigOption("auto_approve", false);
    yield* input.runtime.setConfigOption(modelOption.id, model);
    // Native Plan is read-only. A failed mode change must prevent dispatch.
    yield* input.runtime.setMode(input.interactionMode === "plan" ? "plan" : "act");
  });
}

export function parseClineResumeCursor(value: unknown): { sessionId: string } | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== 1 ||
    !("sessionId" in value) ||
    typeof value.sessionId !== "string" ||
    !value.sessionId.trim()
  ) {
    return undefined;
  }
  return { sessionId: value.sessionId };
}
