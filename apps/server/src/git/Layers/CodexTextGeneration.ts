// FILE: CodexTextGeneration.ts
// Purpose: Runs schema-constrained Codex CLI text generation against account-owned auth.
// Layer: Git and orchestration text-generation service.

import {
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Schema,
  Scope,
  ServiceMap,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { DEFAULT_GIT_TEXT_GENERATION_MODEL } from "@synara/contracts";
import { sanitizeGeneratedThreadTitle } from "@synara/shared/chatThreads";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@synara/shared/git";

import {
  hydrateCodexProviderCredentialEnvironment,
  prepareCodexAuthTracking,
  type CodexPreparedAuthSource,
} from "../../codexProcessEnv.ts";
import { compareCodexCliVersions, parseCodexCliVersion } from "../../provider/codexCliVersion.ts";
import { TextGenerationError } from "../Errors.ts";
import {
  CodexTextGeneration,
  type BranchNameGenerationInput,
  type BranchNameGenerationResult,
  type CommitMessageGenerationResult,
  type DiffSummaryGenerationResult,
  type PrContentGenerationResult,
  type ThreadTitleGenerationResult,
  type ThreadRecapGenerationResult,
  type TextGenerationOperation,
  type TextGenerationShape,
  TextGeneration,
} from "../Services/TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildAutomationIntentPrompt,
  buildAutomationCompletionEvaluationPrompt,
  buildCommitMessagePrompt,
  buildDiffSummaryPrompt,
  buildPrContentPrompt,
  buildThreadRecapPrompt,
  buildThreadTitlePrompt,
  sanitizeCommitSubject,
  sanitizeDiffSummary,
  sanitizeThreadRecap,
  sanitizePrTitle,
  toJsonSchemaObject,
} from "../textGenerationShared.ts";
import {
  acquireSecureTempDirectory,
  acquireSecureTempFile,
  assertNoExternalCodexConfigLayers,
  buildCodexTextGenerationChildEnv,
  buildCodexTextGenerationCliConfigArgs,
  buildCodexTextGenerationConfig,
  buildCodexTextGenerationModelCatalog,
  buildCodexTextGenerationRuntimeConfig,
  CodexTextGenerationAuthError,
  type CodexTextGenerationConfig,
  CodexTextGenerationConfigError,
  prepareCodexTextGenerationAuthSnapshot,
  writePrivateFileString,
} from "./codexTextGenerationIsolation.ts";

const CODEX_REASONING_EFFORT = "low";
const CODEX_VERSION_PROBE_TIMEOUT_MS = 5_000;
const CODEX_CHATGPT_REFRESH_WINDOW_MS = 300_000;
const CODEX_AUTH_EXPIRY_CLOCK_SAFETY_MS = 30_000;
const MINIMUM_CODEX_TEXT_GENERATION_CLI_VERSION = "0.105.0";

export type CodexTextGenerationTiming = {
  readonly requestTimeoutMs: number;
  readonly killGraceMs: number;
  readonly outputDrainMs: number;
  readonly finalOutputDrainMs: number;
};

const DEFAULT_CODEX_TEXT_GENERATION_TIMING: CodexTextGenerationTiming = {
  requestTimeoutMs: 180_000,
  killGraceMs: 1_500,
  outputDrainMs: 750,
  finalOutputDrainMs: 1_000,
};

function minimumCodexAuthValidityMs(timing: CodexTextGenerationTiming): number {
  const boundedPostExitMs = timing.outputDrainMs + timing.killGraceMs + timing.finalOutputDrainMs;
  return (
    CODEX_VERSION_PROBE_TIMEOUT_MS +
    timing.requestTimeoutMs +
    boundedPostExitMs * 2 +
    CODEX_CHATGPT_REFRESH_WINDOW_MS +
    CODEX_AUTH_EXPIRY_CLOCK_SAFETY_MS
  );
}

class CodexTextGenerationTimingConfig extends ServiceMap.Service<
  CodexTextGenerationTimingConfig,
  CodexTextGenerationTiming
>()("synara/git/CodexTextGenerationTimingConfig") {}

export function codexTextGenerationPlatformError(
  platform: NodeJS.Platform,
  operation: TextGenerationOperation,
): TextGenerationError | undefined {
  if (platform !== "win32") return undefined;
  return new TextGenerationError({
    operation,
    detail:
      "Auxiliary Codex text generation is unavailable on Windows because descendant process containment cannot be guaranteed; use the configured text-generation fallback.",
  });
}

function signalCodexProcessGroup(
  child: ChildProcessSpawner.ChildProcessHandle,
  signal: NodeJS.Signals | 0,
): boolean {
  try {
    process.kill(-Number(child.pid), signal);
    return true;
  } catch (cause) {
    const code =
      typeof cause === "object" && cause !== null && "code" in cause
        ? String((cause as { readonly code?: unknown }).code ?? "")
        : "";
    if (code === "ESRCH") return false;
    throw cause;
  }
}

function terminateCodexChild(
  child: ChildProcessSpawner.ChildProcessHandle,
  killGraceMs: number,
  operation: TextGenerationOperation,
) {
  const signalGroup = (signal: NodeJS.Signals | 0) =>
    Effect.try({
      try: () => signalCodexProcessGroup(child, signal),
      catch: (cause) =>
        new TextGenerationError({
          operation,
          detail: `Failed to signal the isolated Codex process group with ${String(signal)}.`,
          cause,
        }),
    });

  // Signal the detached POSIX group directly. ChildProcessHandle.kill waits for
  // the root exit, which would deadlock the TERM grace path when the root traps
  // TERM. ESRCH means the group is already gone and is a successful cleanup.
  return Effect.gen(function* () {
    const termSent = yield* signalGroup("SIGTERM");
    if (!termSent) return;
    const groupIsAlive = yield* signalGroup(0);
    if (!groupIsAlive) return;
    yield* Effect.sleep(killGraceMs);
    yield* signalGroup("SIGKILL");
  });
}

function normalizeCodexError(
  binaryPath: string,
  operation: string,
  error: unknown,
  fallback: string,
): TextGenerationError {
  if (Schema.is(TextGenerationError)(error)) {
    return error;
  }

  if (error instanceof Error) {
    const lower = error.message.toLowerCase();
    if (
      error.message.includes(`Command not found: ${binaryPath}`) ||
      lower.includes(`spawn ${binaryPath.toLowerCase()}`) ||
      lower.includes("enoent")
    ) {
      return new TextGenerationError({
        operation,
        detail: `Codex CLI (${binaryPath}) is required but not available.`,
        cause: error,
      });
    }
    return new TextGenerationError({
      operation,
      detail: `${fallback}: ${error.message}`,
      cause: error,
    });
  }

  return new TextGenerationError({
    operation,
    detail: fallback,
    cause: error,
  });
}

const makeCodexTextGeneration = Effect.gen(function* () {
  const timingOption = yield* Effect.serviceOption(CodexTextGenerationTimingConfig);
  const timing = Option.getOrElse(timingOption, () => DEFAULT_CODEX_TEXT_GENERATION_TIMING);
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const readStreamAsString = <E>(
    operation: string,
    stream: Stream.Stream<Uint8Array, E>,
  ): Effect.Effect<string, TextGenerationError> =>
    Effect.gen(function* () {
      let text = "";
      yield* Stream.runForEach(stream, (chunk) =>
        Effect.sync(() => {
          text += Buffer.from(chunk).toString("utf8");
        }),
      ).pipe(
        Effect.mapError((cause) =>
          normalizeCodexError("codex", operation, cause, "Failed to collect process output"),
        ),
      );
      return text;
    });

  const collectCodexChildResult = (input: {
    readonly binaryPath: string;
    readonly child: ChildProcessSpawner.ChildProcessHandle;
    readonly operation: TextGenerationOperation;
    readonly timeoutMs: number;
    readonly timeoutDetail: string;
  }) =>
    Effect.gen(function* () {
      const cleanupHandled = yield* Ref.make(false);
      yield* Effect.addFinalizer(() =>
        Ref.get(cleanupHandled).pipe(
          Effect.flatMap((handled) =>
            handled
              ? Effect.void
              : terminateCodexChild(input.child, timing.killGraceMs, input.operation),
          ),
          Effect.ignore,
        ),
      );

      const stdoutFiber = yield* readStreamAsString(input.operation, input.child.stdout).pipe(
        Effect.forkScoped,
      );
      const stderrFiber = yield* readStreamAsString(input.operation, input.child.stderr).pipe(
        Effect.forkScoped,
      );
      const exitCode = yield* input.child.exitCode.pipe(
        Effect.map((value) => Number(value)),
        Effect.mapError((cause) =>
          normalizeCodexError(
            input.binaryPath,
            input.operation,
            cause,
            "Failed to read Codex CLI exit code",
          ),
        ),
        Effect.timeoutOrElse({
          duration: input.timeoutMs,
          onTimeout: () =>
            terminateCodexChild(input.child, timing.killGraceMs, input.operation).pipe(
              Effect.andThen(Ref.set(cleanupHandled, true)),
              Effect.andThen(
                Effect.fail(
                  new TextGenerationError({
                    operation: input.operation,
                    detail: input.timeoutDetail,
                  }),
                ),
              ),
            ),
        }),
      );

      const collectOutput = Effect.all(
        [Fiber.join(stdoutFiber).pipe(Effect.exit), Fiber.join(stderrFiber).pipe(Effect.exit)],
        { concurrency: "unbounded" },
      );
      const [stdoutExit, stderrExit] = yield* collectOutput.pipe(
        Effect.timeoutOrElse({
          duration: timing.outputDrainMs,
          onTimeout: () =>
            terminateCodexChild(input.child, timing.killGraceMs, input.operation).pipe(
              Effect.andThen(Ref.set(cleanupHandled, true)),
              Effect.andThen(
                collectOutput.pipe(
                  Effect.timeoutOrElse({
                    duration: timing.finalOutputDrainMs,
                    onTimeout: () =>
                      Effect.fail(
                        new TextGenerationError({
                          operation: input.operation,
                          detail:
                            "Codex CLI descendants kept output pipes open after process-group termination.",
                        }),
                      ),
                  }),
                ),
              ),
            ),
        }),
      );
      const alreadyTerminated = yield* Ref.get(cleanupHandled);
      if (!alreadyTerminated) {
        yield* terminateCodexChild(input.child, timing.killGraceMs, input.operation);
      }
      yield* Ref.set(cleanupHandled, true);

      if (stdoutExit._tag === "Failure") return yield* Effect.failCause(stdoutExit.cause);
      if (stderrExit._tag === "Failure") return yield* Effect.failCause(stderrExit.cause);
      return { exitCode, stdout: stdoutExit.value, stderr: stderrExit.value };
    });

  const tempDir = () => process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP ?? "/tmp";

  const verifyCodexTextGenerationVersion = (
    operation: TextGenerationOperation,
    binaryPath: string,
    cwd: string,
    env: Record<string, string>,
  ) =>
    Effect.gen(function* () {
      const command = ChildProcess.make(binaryPath, ["--version"], {
        cwd,
        detached: true,
        env,
        killSignal: "SIGKILL",
        stdin: "ignore",
      });
      const child = yield* commandSpawner
        .spawn(command)
        .pipe(
          Effect.mapError((cause) =>
            normalizeCodexError(binaryPath, operation, cause, "Failed to probe Codex CLI version"),
          ),
        );
      const result = yield* collectCodexChildResult({
        binaryPath,
        child,
        operation,
        timeoutMs: CODEX_VERSION_PROBE_TIMEOUT_MS,
        timeoutDetail: "Codex CLI version probe timed out.",
      });
      const version = parseCodexCliVersion(`${result.stdout}\n${result.stderr}`);
      if (
        result.exitCode !== 0 ||
        version === null ||
        compareCodexCliVersions(version, MINIMUM_CODEX_TEXT_GENERATION_CLI_VERSION) < 0
      ) {
        const versionLabel = version ? `v${version}` : "an unrecognized version";
        return yield* new TextGenerationError({
          operation,
          detail: `Auxiliary Codex text generation requires Codex CLI v${MINIMUM_CODEX_TEXT_GENERATION_CLI_VERSION} or newer; found ${versionLabel}.`,
        });
      }
    });

  const parsePreparedCodexConfig = (
    operation: TextGenerationOperation,
    sourceConfigSnapshot: string,
  ): Effect.Effect<CodexTextGenerationConfig, TextGenerationError> =>
    Effect.try({
      try: () => buildCodexTextGenerationConfig(sourceConfigSnapshot),
      catch: (cause) =>
        new TextGenerationError({
          operation,
          detail:
            cause instanceof CodexTextGenerationConfigError
              ? cause.message
              : "The prepared Codex config.toml snapshot could not be parsed safely.",
          cause,
        }),
    });

  const prepareIsolatedCodexHome = (
    operation: TextGenerationOperation,
    config: CodexTextGenerationConfig,
    authSource: CodexPreparedAuthSource,
    selectedModel: string,
  ): Effect.Effect<
    {
      readonly homePath: string;
      readonly workDirectoryPath: string;
      readonly tempDirectoryPath: string;
      readonly modelCatalogPath: string;
    },
    TextGenerationError,
    FileSystem.FileSystem | Scope.Scope
  > => {
    return Effect.gen(function* () {
      const homePath = yield* acquireSecureTempDirectory({
        directory: tempDir(),
        prefix: "synara-codex-text-home-",
      }).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Failed to create a private isolated Codex home.",
              cause,
            }),
        ),
      );

      const modelCatalogPath = path.join(homePath, "models.json");
      yield* writePrivateFileString(
        modelCatalogPath,
        buildCodexTextGenerationModelCatalog(selectedModel),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Failed to write the private text-only Codex model catalog.",
              cause,
            }),
        ),
      );

      yield* writePrivateFileString(
        path.join(homePath, "config.toml"),
        buildCodexTextGenerationRuntimeConfig(config.content, modelCatalogPath),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Failed to write private isolated Codex provider routing.",
              cause,
            }),
        ),
      );

      yield* Effect.try({
        try: () =>
          prepareCodexTextGenerationAuthSnapshot(authSource, homePath, {
            minimumValidityMs: minimumCodexAuthValidityMs(timing),
          }),
        catch: (cause) =>
          new TextGenerationError({
            operation,
            detail:
              cause instanceof CodexTextGenerationAuthError
                ? cause.message
                : "Failed to prepare a private Codex auth snapshot for text generation.",
            cause,
          }),
      });
      const workDirectoryPath = yield* acquireSecureTempDirectory({
        directory: homePath,
        prefix: "work-",
      }).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Failed to create an empty isolated Codex working directory.",
              cause,
            }),
        ),
      );
      const tempDirectoryPath = yield* acquireSecureTempDirectory({
        directory: homePath,
        prefix: "tmp-",
      }).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Failed to create an isolated Codex temporary directory.",
              cause,
            }),
        ),
      );
      return {
        homePath,
        workDirectoryPath,
        tempDirectoryPath,
        modelCatalogPath,
      };
    });
  };

  const runCodexJson = <S extends Schema.Top>({
    operation,
    cwd: _requestedCwd,
    prompt,
    outputSchemaJson,
    codexHomePath,
    model,
    modelSelection,
    providerOptions,
  }: {
    operation: TextGenerationOperation;
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    codexHomePath?: string;
    model?: string;
    modelSelection?: BranchNameGenerationInput["modelSelection"];
    providerOptions?: BranchNameGenerationInput["providerOptions"];
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.scoped(
      Effect.gen(function* () {
        const platformError = codexTextGenerationPlatformError(process.platform, operation);
        if (platformError) return yield* platformError;
        yield* Effect.try({
          try: assertNoExternalCodexConfigLayers,
          catch: (cause) =>
            new TextGenerationError({
              operation,
              detail:
                cause instanceof CodexTextGenerationConfigError
                  ? cause.message
                  : "External Codex configuration layers could not be checked safely.",
              cause,
            }),
        });
        const codexBinaryPath = resolveCodexBinaryPath(providerOptions);
        const resolvedCodexHomePath = resolveCodexHomePath(codexHomePath, providerOptions);
        const resolvedCodexAuthHomePath = resolveCodexAuthHomePath(providerOptions);
        const resolvedCodexAccountId = resolveCodexAccountId(providerOptions);
        const trustedProcessEnv = { ...process.env };
        const instanceLaunchEnv = {
          ...trustedProcessEnv,
          ...providerOptions?.codex?.environment,
        };
        const authTracking = yield* Effect.try({
          try: () =>
            prepareCodexAuthTracking({
              env: instanceLaunchEnv,
              ...(resolvedCodexHomePath ? { homePath: resolvedCodexHomePath } : {}),
              ...(resolvedCodexAuthHomePath ? { shadowHomePath: resolvedCodexAuthHomePath } : {}),
              ...(resolvedCodexAccountId ? { accountId: resolvedCodexAccountId } : {}),
            }),
          catch: (cause) =>
            new TextGenerationError({
              operation,
              detail:
                cause instanceof Error
                  ? cause.message
                  : "Codex authentication storage cannot be resolved safely.",
              cause,
            }),
        });
        const isolatedConfig = yield* parsePreparedCodexConfig(
          operation,
          authTracking.sourceConfigSnapshot,
        );
        const hydratedLaunchEnv = hydrateCodexProviderCredentialEnvironment({
          env: instanceLaunchEnv,
          credentialEnvNames: isolatedConfig.providerEnvKeys,
          trustedEnv: trustedProcessEnv,
        });
        const schemaPath = yield* acquireSecureTempFile({
          directory: tempDir(),
          prefix: "synara-codex-schema-",
          content: JSON.stringify(toJsonSchemaObject(outputSchemaJson)),
        }).pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation,
                detail: "Failed to create a private Codex output-schema file.",
                cause,
              }),
          ),
        );
        const outputPath = yield* acquireSecureTempFile({
          directory: tempDir(),
          prefix: "synara-codex-output-",
          content: "",
        }).pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation,
                detail: "Failed to create a private Codex output file.",
                cause,
              }),
          ),
        );
        const selectedModel =
          resolveCodexModel(model, modelSelection) ?? DEFAULT_GIT_TEXT_GENERATION_MODEL;
        const isolatedCodexHome = yield* prepareIsolatedCodexHome(
          operation,
          isolatedConfig,
          authTracking.authSource,
          selectedModel,
        );

        const runCodexCommand = Effect.gen(function* () {
          // The CLI starts in an empty directory with only parsed provider/auth
          // routing in CODEX_HOME, so user and repository execution surfaces are
          // absent even on older CLIs without `--ignore-user-config`.
          const env = yield* Effect.try({
            try: () =>
              buildCodexTextGenerationChildEnv({
                sourceEnv: hydratedLaunchEnv,
                trustedPlatformEnv: trustedProcessEnv,
                isolatedHomePath: isolatedCodexHome.homePath,
                isolatedTempPath: isolatedCodexHome.tempDirectoryPath,
                providerEnvKeys: isolatedConfig.providerEnvKeys,
                usesAwsCredentials: isolatedConfig.usesAwsCredentials,
                ...(isolatedConfig.awsRegion ? { awsRegion: isolatedConfig.awsRegion } : {}),
              }),
            catch: (cause) =>
              new TextGenerationError({
                operation,
                detail:
                  cause instanceof CodexTextGenerationConfigError
                    ? cause.message
                    : "Failed to build the isolated Codex child environment.",
                cause,
              }),
          });
          yield* verifyCodexTextGenerationVersion(
            operation,
            codexBinaryPath,
            isolatedCodexHome.workDirectoryPath,
            env,
          );
          const args = [
            "exec",
            "--ephemeral",
            "--skip-git-repo-check",
            "-s",
            "read-only",
            "--model",
            selectedModel,
            ...buildCodexTextGenerationCliConfigArgs(isolatedCodexHome.modelCatalogPath),
            "--config",
            `model_reasoning_effort="${CODEX_REASONING_EFFORT}"`,
            "--output-schema",
            schemaPath,
            "--output-last-message",
            outputPath,
            "-",
          ];
          const command = ChildProcess.make(codexBinaryPath, args, {
            cwd: isolatedCodexHome.workDirectoryPath,
            detached: true,
            env,
            killSignal: "SIGKILL",
            stdin: {
              stream: Stream.make(new TextEncoder().encode(prompt)),
            },
          });

          const child = yield* commandSpawner
            .spawn(command)
            .pipe(
              Effect.mapError((cause) =>
                normalizeCodexError(
                  codexBinaryPath,
                  operation,
                  cause,
                  "Failed to spawn Codex CLI process",
                ),
              ),
            );
          const { exitCode, stdout, stderr } = yield* collectCodexChildResult({
            binaryPath: codexBinaryPath,
            child,
            operation,
            timeoutMs: timing.requestTimeoutMs,
            timeoutDetail: "Codex CLI request timed out.",
          });

          if (exitCode !== 0) {
            const stderrDetail = stderr.trim();
            const stdoutDetail = stdout.trim();
            const detail = stderrDetail.length > 0 ? stderrDetail : stdoutDetail;
            return yield* new TextGenerationError({
              operation,
              detail:
                detail.length > 0
                  ? `Codex CLI command failed: ${detail}`
                  : `Codex CLI command failed with code ${exitCode}.`,
            });
          }
        });

        const request = Effect.gen(function* () {
          yield* runCodexCommand.pipe(Effect.scoped);

          return yield* fileSystem.readFileString(outputPath).pipe(
            Effect.mapError(
              (cause) =>
                new TextGenerationError({
                  operation,
                  detail: "Failed to read Codex output file.",
                  cause,
                }),
            ),
            Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson))),
            Effect.catchTag("SchemaError", (cause) =>
              Effect.fail(
                new TextGenerationError({
                  operation,
                  detail: "Codex returned invalid structured output.",
                  cause,
                }),
              ),
            ),
          );
        });

        return yield* request;
      }),
    );

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = (input) => {
    const wantsBranch = input.includeBranch === true;
    const { prompt, outputSchemaJson } = buildCommitMessagePrompt({
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: wantsBranch,
    });

    return runCodexJson({
      operation: "generateCommitMessage",
      cwd: input.cwd,
      prompt,
      outputSchemaJson,
      ...(input.codexHomePath ? { codexHomePath: input.codexHomePath } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
      ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
    }).pipe(
      Effect.map(
        (generated) =>
          ({
            subject: sanitizeCommitSubject(generated.subject),
            body: generated.body.trim(),
            ...("branch" in generated && typeof generated.branch === "string"
              ? { branch: sanitizeFeatureBranchName(generated.branch) }
              : {}),
          }) satisfies CommitMessageGenerationResult,
      ),
    );
  };

  const generatePrContent: TextGenerationShape["generatePrContent"] = (input) => {
    const { prompt, outputSchemaJson } = buildPrContentPrompt({
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      commitSummary: input.commitSummary,
      diffSummary: input.diffSummary,
      diffPatch: input.diffPatch,
    });

    return runCodexJson({
      operation: "generatePrContent",
      cwd: input.cwd,
      prompt,
      outputSchemaJson,
      ...(input.codexHomePath ? { codexHomePath: input.codexHomePath } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
      ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
    }).pipe(
      Effect.map(
        (generated) =>
          ({
            title: sanitizePrTitle(generated.title),
            body: generated.body.trim(),
          }) satisfies PrContentGenerationResult,
      ),
    );
  };

  const generateDiffSummary: TextGenerationShape["generateDiffSummary"] = (input) => {
    const { prompt, outputSchemaJson } = buildDiffSummaryPrompt({
      patch: input.patch,
    });

    return runCodexJson({
      operation: "generateDiffSummary",
      cwd: input.cwd,
      prompt,
      outputSchemaJson,
      ...(input.codexHomePath ? { codexHomePath: input.codexHomePath } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
      ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
    }).pipe(
      Effect.map(
        (generated) =>
          ({
            summary: sanitizeDiffSummary(generated.summary),
          }) satisfies DiffSummaryGenerationResult,
      ),
    );
  };

  const generateBranchName: TextGenerationShape["generateBranchName"] = (input) => {
    return Effect.gen(function* () {
      const { prompt, outputSchemaJson } = buildBranchNamePrompt({
        message: input.message,
        ...(input.attachments ? { attachments: input.attachments } : {}),
      });

      const generated = yield* runCodexJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson,
        ...(input.model ? { model: input.model } : {}),
        ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
        ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
      });

      return {
        branch: sanitizeBranchFragment(generated.branch),
      } satisfies BranchNameGenerationResult;
    });
  };

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = (input) => {
    return Effect.gen(function* () {
      const { prompt, outputSchemaJson } = buildThreadTitlePrompt({
        message: input.message,
        ...(input.attachments ? { attachments: input.attachments } : {}),
      });

      const generated = yield* runCodexJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson,
        ...(input.model ? { model: input.model } : {}),
        ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
        ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
      });

      return {
        title: sanitizeGeneratedThreadTitle(generated.title),
      } satisfies ThreadTitleGenerationResult;
    });
  };

  const generateThreadRecap: TextGenerationShape["generateThreadRecap"] = (input) => {
    const { prompt, outputSchemaJson } = buildThreadRecapPrompt({
      ...(input.previousRecap ? { previousRecap: input.previousRecap } : {}),
      newMaterial: input.newMaterial,
      ...(input.currentState ? { currentState: input.currentState } : {}),
    });

    return runCodexJson({
      operation: "generateThreadRecap",
      cwd: input.cwd,
      prompt,
      outputSchemaJson,
      ...(input.codexHomePath ? { codexHomePath: input.codexHomePath } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
      ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
    }).pipe(
      Effect.map(
        (generated) =>
          ({
            recap: sanitizeThreadRecap(generated.recap, input.previousRecap),
          }) satisfies ThreadRecapGenerationResult,
      ),
    );
  };

  const generateAutomationIntent: TextGenerationShape["generateAutomationIntent"] = (input) => {
    const { prompt, outputSchemaJson } = buildAutomationIntentPrompt({
      message: input.message,
      ...(input.defaultMode ? { defaultMode: input.defaultMode } : {}),
      nowIso: input.nowIso,
    });

    return runCodexJson({
      operation: "generateAutomationIntent",
      cwd: input.cwd,
      prompt,
      outputSchemaJson,
      ...(input.codexHomePath ? { codexHomePath: input.codexHomePath } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
      ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
    });
  };

  const evaluateAutomationCompletion: TextGenerationShape["evaluateAutomationCompletion"] = (
    input,
  ) => {
    const { prompt, outputSchemaJson } = buildAutomationCompletionEvaluationPrompt(input);

    return runCodexJson({
      operation: "evaluateAutomationCompletion",
      cwd: input.cwd,
      prompt,
      outputSchemaJson,
      ...(input.codexHomePath ? { codexHomePath: input.codexHomePath } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
      ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
    });
  };

  return {
    generateCommitMessage,
    generatePrContent,
    generateDiffSummary,
    generateBranchName,
    generateThreadTitle,
    generateThreadRecap,
    generateAutomationIntent,
    evaluateAutomationCompletion,
  } satisfies TextGenerationShape;
});

function resolveCodexBinaryPath(
  providerOptions: BranchNameGenerationInput["providerOptions"] | undefined,
): string {
  return providerOptions?.codex?.binaryPath?.trim() || "codex";
}

function resolveCodexHomePath(
  codexHomePath: string | undefined,
  providerOptions: BranchNameGenerationInput["providerOptions"] | undefined,
): string | undefined {
  // The routed instance home wins: the legacy top-level codexHomePath is the
  // global default and must not override a selected account's own home.
  const resolved = providerOptions?.codex?.homePath?.trim() || codexHomePath?.trim();
  return resolved && resolved.length > 0 ? resolved : undefined;
}

function resolveCodexAuthHomePath(
  providerOptions: BranchNameGenerationInput["providerOptions"] | undefined,
): string | undefined {
  const resolved = providerOptions?.codex?.shadowHomePath?.trim();
  return resolved && resolved.length > 0 ? resolved : undefined;
}

function resolveCodexAccountId(
  providerOptions: BranchNameGenerationInput["providerOptions"] | undefined,
): string | undefined {
  const resolved = providerOptions?.codex?.accountId?.trim();
  return resolved && resolved.length > 0 ? resolved : undefined;
}

function resolveCodexModel(
  model: string | undefined,
  modelSelection: BranchNameGenerationInput["modelSelection"] | undefined,
): string | undefined {
  return modelSelection?.model ?? model;
}

export const CodexTextGenerationServiceLive = Layer.effect(
  CodexTextGeneration,
  makeCodexTextGeneration,
);

export const CodexTextGenerationLive = Layer.effect(TextGeneration, makeCodexTextGeneration);

export function makeCodexTextGenerationLive(timing: CodexTextGenerationTiming) {
  return Layer.effect(
    TextGeneration,
    makeCodexTextGeneration.pipe(Effect.provideService(CodexTextGenerationTimingConfig, timing)),
  );
}
