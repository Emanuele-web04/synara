import type * as Acp from "@agentclientprotocol/sdk";
import type { MuseModelOptions, ProviderModelDescriptor } from "@synara/contracts";
import { Effect, Layer, Scope, ServiceMap } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
  type AcpSpawnInput,
} from "./AcpSessionRuntime.ts";
import * as AcpErrors from "./AcpErrors.ts";

export interface MuseSettings {
  readonly binaryPath?: string | undefined;
  readonly environment?: Readonly<Record<string, string>> | undefined;
  readonly instanceId?: string;
  readonly homeDir?: string;
  readonly isolationRootDir?: string;
}

export function buildMuseSpawnInput(settings: MuseSettings, cwd: string): AcpSpawnInput {
  return {
    command: settings.binaryPath?.trim() || "muse-acp",
    args: [],
    cwd,
    providerEnvironment: { driver: "muse", ...settings },
    // Even full-access turns go through Synara's permission policy so Plan
    // and computer-consent boundaries remain enforceable on every request.
    env: { MUSE_APPROVAL_MODE: "promptUnmatched", MUSE_ALLOW_UNSCOPED_READS: "false" },
  };
}

export const makeMuseRuntime = (
  input: Omit<AcpSessionRuntimeOptions, "spawn"> & {
    readonly settings: MuseSettings;
    readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  },
): Effect.Effect<AcpSessionRuntimeShape, AcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildMuseSpawnInput(input.settings, input.cwd),
        authPolicy: "on-demand",
        resolveAuthMethodId: () =>
          Effect.fail(
            new AcpErrors.AcpRequestError({
              code: -32000,
              errorMessage:
                "Muse Code requires authentication. Use Sign in or run `muse-acp login`, then retry.",
            }),
          ),
        clientCapabilities: { elicitation: { form: {} } },
        startupTimeouts: {
          initializeMs: 30_000,
          authenticateMs: 30_000,
          sessionSetupMs: 180_000,
          totalMs: 210_000,
        },
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return ServiceMap.getUnsafe(context, AcpSessionRuntime);
  });

function choices(option: Acp.SessionConfigOption) {
  return option.type === "select"
    ? option.options.flatMap((entry) => ("value" in entry ? [entry] : entry.options))
    : [];
}

export function museModels(
  options: ReadonlyArray<Acp.SessionConfigOption>,
): ProviderModelDescriptor[] {
  const model = options.find((option) => option.category === "model");
  if (!model) return [];
  // Effort choices belong to the currently selected model, not every model
  // in the catalog. Do not promise unsupported tiers for other models.
  const effort = options.find((option) => option.id === "reasoning_effort");
  return choices(model).map((entry) => ({
    slug: entry.value,
    name: entry.name,
    ...(model.type === "select" && entry.value === model.currentValue && effort
      ? {
          supportedReasoningEfforts: choices(effort).map((choice) => ({
            value: choice.value,
            label: choice.value === "default" ? "Use session setting" : choice.name,
          })),
          ...(effort.type === "select" ? { defaultReasoningEffort: effort.currentValue } : {}),
        }
      : {}),
  }));
}

// Run only on the disposable discovery session. Muse exposes effort choices
// for its selected model; switching here never changes the user's live thread.
export function discoverMuseModels(
  runtime: Pick<AcpSessionRuntimeShape, "getConfigOptions" | "setModel">,
): Effect.Effect<ProviderModelDescriptor[], AcpErrors.AcpError> {
  return Effect.gen(function* () {
    const initial = yield* runtime.getConfigOptions;
    const selector = initial.find((option) => option.category === "model");
    if (!selector || selector.type !== "select") return [];
    const initialModels = museModels(initial);
    const selected = initialModels.find((model) => model.slug === selector.currentValue);
    const models: ProviderModelDescriptor[] = selected
      ? [Object.assign({}, selected, { slug: "default", name: "Muse default" })]
      : [];
    let currentModel = selector.currentValue;
    for (const model of initialModels) {
      if (model.slug !== currentModel) {
        yield* runtime.setModel(model.slug);
        currentModel = model.slug;
      }
      const options = yield* runtime.getConfigOptions;
      const descriptor = museModels(options).find((candidate) => candidate.slug === model.slug);
      if (!descriptor) {
        return yield* new AcpErrors.AcpRequestError({
          code: -32603,
          errorMessage: `Muse did not return configuration for model ${model.slug}.`,
        });
      }
      models.push(descriptor);
    }
    return models;
  });
}

export function configureMuse(
  runtime: Pick<AcpSessionRuntimeShape, "setModel" | "setMode" | "setConfigOption">,
  model: string | undefined,
  options: MuseModelOptions | undefined,
  plan: boolean,
) {
  return Effect.gen(function* () {
    if (model && model !== "default") yield* runtime.setModel(model);
    // MSP cannot clear a stored session effort. "default" is only a UI
    // placeholder before an explicit tier is set, not a reset command.
    const effort = options?.reasoningEffort?.trim();
    if (effort && effort !== "default") {
      yield* runtime.setConfigOption("reasoning_effort", effort);
    }
    yield* runtime.setMode(plan ? "plan" : "default");
    yield* runtime.setConfigOption("approval_mode", "promptUnmatched");
    yield* runtime.setConfigOption("auto_review", "off");
  });
}
