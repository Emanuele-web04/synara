import type * as Acp from "@agentclientprotocol/sdk";
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

export interface CommandCodeAcpRuntimeSettings {
  readonly binaryPath?: string | undefined;
}

export interface CommandCodeAcpRuntimeInput extends Omit<
  AcpSessionRuntimeOptions,
  "spawn" | "authMethodId" | "resolveAuthMethodId" | "authPolicy"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly commandCodeSettings?: CommandCodeAcpRuntimeSettings;
}

export function buildCommandCodeAcpSpawnInput(
  settings: CommandCodeAcpRuntimeSettings | undefined,
  cwd: string,
): AcpSpawnInput {
  return {
    command: settings?.binaryPath?.trim() || resolveExecutable("cmd") || "cmd",
    // Never inherit a saved permission preference. Synara owns approvals.
    args: ["acp", "--permission-mode", "default"],
    cwd,
    env: buildProviderChildEnvironment({ provider: "commandCode" }),
  };
}

export const makeCommandCodeAcpRuntime = (
  input: CommandCodeAcpRuntimeInput,
): Effect.Effect<AcpSessionRuntimeShape, AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildCommandCodeAcpSpawnInput(input.commandCodeSettings, input.cwd),
        // COMMAND_CODE_API_KEY / `cmd login` credentials are restored by Command
        // Code itself. Do not open an interactive login inside an ACP child.
        authPolicy: "on-demand",
        resolveAuthMethodId: () =>
          Effect.fail(
            new AcpRequestError({
              code: -32000,
              errorMessage:
                "Command Code authentication is required. Run `cmd login` in a terminal or set COMMAND_CODE_API_KEY, then retry in Synara.",
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

export function commandCodeDefaultModel(result: AcpSessionRuntimeStartResult): string | undefined {
  const config = findCommandCodeModelOption(result.sessionSetupResult.configOptions);
  return config?.type === "select" ? config.currentValue : undefined;
}

function findCommandCodeModelOption(
  configOptions: ReadonlyArray<Acp.SessionConfigOption> | null | undefined,
): Acp.SessionConfigOption | undefined {
  return configOptions?.find((option) => option.id.trim().toLowerCase() === "model");
}

/** Preserve provider-scoped IDs verbatim; Command Code, not Synara, owns this catalog. */
export function mapCommandCodeModels(
  result: AcpSessionRuntimeStartResult,
): ProviderModelDescriptor[] {
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
  const config = findCommandCodeModelOption(result.sessionSetupResult.configOptions);
  if (config?.type === "select") {
    for (const entry of config.options) {
      for (const option of "value" in entry ? [entry] : entry.options) {
        add(option.value, option.name, option.description);
      }
    }
  }
  const defaultModel = commandCodeDefaultModel(result);
  const configured = defaultModel ? models.get(defaultModel) : undefined;
  return configured
    ? [
        {
          ...configured,
          slug: "default",
          name: `Command Code configured model (${configured.name})`,
        },
        ...models.values(),
      ]
    : [...models.values()];
}

export function configureCommandCodeSession(input: {
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
    const modelOption = findCommandCodeModelOption(options);
    const model = input.model === "default" ? input.defaultModel : input.model;
    if (!model || !modelOption) {
      return yield* new AcpRequestError({
        code: -32602,
        errorMessage:
          "Command Code did not advertise a configured model. Update Command Code and run `cmd login` before retrying.",
      });
    }
    yield* input.runtime.setConfigOption(modelOption.id, model);
    // `cmd` exposes permission modes as spawn flags, not an ACP mode option.
    // Set a session mode only when the agent advertises one.
    const modeOption = options.find(
      (option) => option.type === "select" && (option.category === "mode" || option.id === "mode"),
    );
    if (modeOption?.type === "select") {
      const wanted = input.interactionMode === "plan" ? "plan" : "act";
      const hasWanted = modeOption.options
        .flatMap((entry) => ("value" in entry ? [entry] : entry.options))
        .some((entry) => entry.value === wanted);
      if (hasWanted) {
        yield* input.runtime.setMode(wanted);
      }
    }
  });
}

export function parseCommandCodeResumeCursor(value: unknown): { sessionId: string } | undefined {
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
