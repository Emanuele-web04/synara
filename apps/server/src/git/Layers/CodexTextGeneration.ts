// FILE: CodexTextGeneration.ts
// Purpose: Runs schema-constrained Codex CLI text generation against account-owned auth.
// Layer: Git and orchestration text-generation service.

import { readFileSync } from "node:fs";

import { Effect, Fiber, FileSystem, Layer, Path, Ref, Schema, Scope, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { DEFAULT_GIT_TEXT_GENERATION_MODEL } from "@synara/contracts";
import { sanitizeGeneratedThreadTitle } from "@synara/shared/chatThreads";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@synara/shared/git";
import { prepareWindowsSafeProcess } from "@synara/shared/windowsProcess";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { buildCodexProcessLaunchContext } from "../../codexProcessEnv.ts";
import { ServerConfig } from "../../config.ts";
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
  buildCodexTextGenerationConfig,
  CodexTextGenerationAuthError,
  type CodexTextGenerationAuthMirror,
  type CodexTextGenerationConfig,
  CodexTextGenerationConfigError,
  prepareCodexTextGenerationAuthMirror,
  validateCodexTextGenerationAuthAfterRun,
  writePrivateFileString,
} from "./codexTextGenerationIsolation.ts";

const CODEX_REASONING_EFFORT = "low";
const CODEX_TIMEOUT_MS = 180_000;
const CODEX_KILL_GRACE_MS = 1_500;

function terminateCodexChild(child: ChildProcessSpawner.ChildProcessHandle, killGraceMs: number) {
  // Both effects run concurrently: TERM gets a grace window while the second
  // branch always follows with KILL. This also cleans descendants that keep a
  // detached process group's pipes open after the root process exits.
  return Effect.all(
    [
      child.kill({ killSignal: "SIGTERM" }).pipe(Effect.ignore),
      Effect.sleep(killGraceMs).pipe(
        Effect.andThen(child.kill({ killSignal: "SIGKILL" })),
        Effect.ignore,
      ),
    ],
    { concurrency: "unbounded" },
  ).pipe(Effect.asVoid);
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
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serverConfig = yield* Effect.service(ServerConfig);

  type MaterializedImageAttachments = {
    readonly imagePaths: ReadonlyArray<string>;
  };

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

  const tempDir = () => process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP ?? "/tmp";

  const readSourceCodexConfig = (
    operation: TextGenerationOperation,
    sourceConfigPath: string,
  ): Effect.Effect<CodexTextGenerationConfig, TextGenerationError> =>
    Effect.try({
      try: () => {
        let source = "";
        try {
          source = readFileSync(sourceConfigPath, "utf8");
        } catch (cause) {
          const code =
            typeof cause === "object" && cause !== null && "code" in cause
              ? String((cause as { readonly code?: unknown }).code ?? "")
              : "";
          if (code !== "ENOENT") throw cause;
        }
        return buildCodexTextGenerationConfig(source);
      },
      catch: (cause) =>
        new TextGenerationError({
          operation,
          detail:
            cause instanceof CodexTextGenerationConfigError
              ? cause.message
              : "Codex config.toml could not be read safely.",
          cause,
        }),
    });

  const prepareIsolatedCodexHome = (
    operation: TextGenerationOperation,
    config: CodexTextGenerationConfig,
    authoritativeAuthFilePath: string,
  ): Effect.Effect<
    {
      readonly homePath: string;
      readonly workDirectoryPath: string;
      readonly authMirror: CodexTextGenerationAuthMirror | undefined;
    },
    TextGenerationError,
    FileSystem.FileSystem | Scope.Scope
  > => {
    return Effect.gen(function* () {
      // Keeping the temporary home beside the authoritative credential makes
      // the hard-link fallback same-volume and recovery account-owned.
      const homeBasePath = path.dirname(authoritativeAuthFilePath);
      const homePath = yield* acquireSecureTempDirectory({
        directory: homeBasePath,
        prefix: ".synara-codex-text-home-",
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

      yield* writePrivateFileString(path.join(homePath, "config.toml"), config.content).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Failed to write private isolated Codex provider routing.",
              cause,
            }),
        ),
      );

      const authMirror = yield* Effect.try({
        try: () => prepareCodexTextGenerationAuthMirror(authoritativeAuthFilePath, homePath),
        catch: (cause) =>
          new TextGenerationError({
            operation,
            detail: "Failed to prepare account-owned Codex auth for text generation.",
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
      return { homePath, workDirectoryPath, authMirror };
    });
  };

  const materializeImageAttachments = (
    _operation: TextGenerationOperation,
    attachments: BranchNameGenerationInput["attachments"],
  ): Effect.Effect<MaterializedImageAttachments, TextGenerationError> =>
    Effect.gen(function* () {
      if (!attachments || attachments.length === 0) {
        return { imagePaths: [] };
      }

      const imagePaths: string[] = [];
      for (const attachment of attachments) {
        if (attachment.type !== "image") {
          continue;
        }

        const resolvedPath = resolveAttachmentPath({
          attachmentsDir: serverConfig.attachmentsDir,
          attachment,
        });
        if (!resolvedPath || !path.isAbsolute(resolvedPath)) {
          continue;
        }
        const fileInfo = yield* fileSystem
          .stat(resolvedPath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (!fileInfo || fileInfo.type !== "File") {
          continue;
        }
        imagePaths.push(resolvedPath);
      }
      return { imagePaths };
    });

  const runCodexJson = <S extends Schema.Top>({
    operation,
    cwd: _requestedCwd,
    prompt,
    outputSchemaJson,
    imagePaths = [],
    codexHomePath,
    model,
    modelSelection,
    providerOptions,
  }: {
    operation: TextGenerationOperation;
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    imagePaths?: ReadonlyArray<string>;
    codexHomePath?: string;
    model?: string;
    modelSelection?: BranchNameGenerationInput["modelSelection"];
    providerOptions?: BranchNameGenerationInput["providerOptions"];
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.scoped(
      Effect.gen(function* () {
        const codexBinaryPath = resolveCodexBinaryPath(providerOptions);
        const resolvedCodexHomePath = resolveCodexHomePath(codexHomePath, providerOptions);
        const resolvedCodexAuthHomePath = resolveCodexAuthHomePath(providerOptions);
        const resolvedCodexAccountId = resolveCodexAccountId(providerOptions);
        const instanceLaunchEnv = providerOptions?.codex?.environment
          ? { ...process.env, ...providerOptions.codex.environment }
          : process.env;
        const processLaunch = yield* Effect.try({
          try: () =>
            buildCodexProcessLaunchContext({
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
        const isolatedConfig = yield* readSourceCodexConfig(
          operation,
          processLaunch.authTracking.sourceConfigPath,
        );
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
        const isolatedCodexHome = yield* prepareIsolatedCodexHome(
          operation,
          isolatedConfig,
          processLaunch.authTracking.authoritativeAuthFilePath,
        );
        const childExitSucceeded = yield* Ref.make(false);

        const runCodexCommand = Effect.gen(function* () {
          // The CLI starts in an empty directory with only parsed provider/auth
          // routing in CODEX_HOME, so user and repository execution surfaces are
          // absent even on older CLIs without `--ignore-user-config`.
          const env = {
            ...processLaunch.env,
            CODEX_HOME: isolatedCodexHome.homePath,
            CODEX_SQLITE_HOME: isolatedCodexHome.homePath,
          };
          const args = [
            "exec",
            "--ephemeral",
            "--skip-git-repo-check",
            "--config",
            'approval_policy="never"',
            "-s",
            "read-only",
            "--model",
            resolveCodexModel(model, modelSelection) ?? DEFAULT_GIT_TEXT_GENERATION_MODEL,
            "--config",
            `model_reasoning_effort="${CODEX_REASONING_EFFORT}"`,
            "--output-schema",
            schemaPath,
            "--output-last-message",
            outputPath,
            ...imagePaths.flatMap((imagePath) => ["--image", imagePath]),
            "-",
          ];
          const prepared = prepareWindowsSafeProcess(codexBinaryPath, args, {
            cwd: isolatedCodexHome.workDirectoryPath,
            env,
          });
          const command = ChildProcess.make(prepared.command, prepared.args, {
            cwd: isolatedCodexHome.workDirectoryPath,
            env,
            killSignal: "SIGKILL",
            shell: prepared.shell,
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
          const cleanupHandled = yield* Ref.make(false);
          yield* Effect.addFinalizer(() =>
            Ref.get(cleanupHandled).pipe(
              Effect.flatMap((handled) =>
                handled ? Effect.void : terminateCodexChild(child, CODEX_KILL_GRACE_MS),
              ),
            ),
          );

          // Drain output in daemon fibers so interrupting the waiter cannot
          // deadlock before the child-process finalizer gets a chance to kill
          // the process group. The fibers finish when KILL closes the pipes.
          const stdoutFiber = yield* readStreamAsString(operation, child.stdout).pipe(
            Effect.forkDetach,
          );
          const stderrFiber = yield* readStreamAsString(operation, child.stderr).pipe(
            Effect.forkDetach,
          );
          const [stdoutExit, stderrExit, exitCodeExit] = yield* Effect.all(
            [
              Fiber.join(stdoutFiber).pipe(Effect.exit),
              Fiber.join(stderrFiber).pipe(Effect.exit),
              child.exitCode.pipe(
                Effect.map((value) => Number(value)),
                Effect.mapError((cause) =>
                  normalizeCodexError(
                    codexBinaryPath,
                    operation,
                    cause,
                    "Failed to read Codex CLI exit code",
                  ),
                ),
                Effect.exit,
              ),
            ],
            { concurrency: "unbounded" },
          ).pipe(
            Effect.timeoutOrElse({
              duration: CODEX_TIMEOUT_MS,
              onTimeout: () =>
                terminateCodexChild(child, CODEX_KILL_GRACE_MS).pipe(
                  Effect.andThen(Ref.set(cleanupHandled, true)),
                  Effect.andThen(
                    Effect.fail(
                      new TextGenerationError({
                        operation,
                        detail: "Codex CLI request timed out.",
                      }),
                    ),
                  ),
                ),
            }),
          );
          yield* Ref.set(cleanupHandled, true);

          if (exitCodeExit._tag === "Failure") {
            return yield* Effect.failCause(exitCodeExit.cause);
          }
          const exitCode = exitCodeExit.value;
          if (exitCode === 0) yield* Ref.set(childExitSucceeded, true);
          if (stdoutExit._tag === "Failure") return yield* Effect.failCause(stdoutExit.cause);
          if (stderrExit._tag === "Failure") return yield* Effect.failCause(stderrExit.cause);
          const stdout = stdoutExit.value;
          const stderr = stderrExit.value;

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

        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const requestExit = yield* Effect.exit(restore(request));
            const childExecutionSucceeded = yield* Ref.get(childExitSucceeded);
            const authValidationExit = yield* Effect.exit(
              Effect.try({
                try: () =>
                  validateCodexTextGenerationAuthAfterRun(
                    isolatedCodexHome.authMirror,
                    childExecutionSucceeded,
                  ),
                catch: (cause) =>
                  new TextGenerationError({
                    operation,
                    detail:
                      cause instanceof CodexTextGenerationAuthError
                        ? cause.message
                        : "Codex auth could not be validated after isolated text generation.",
                    cause,
                  }),
              }),
            );
            if (authValidationExit._tag === "Failure") {
              return yield* Effect.failCause(authValidationExit.cause);
            }
            if (requestExit._tag === "Failure") {
              return yield* Effect.failCause(requestExit.cause);
            }
            return requestExit.value;
          }),
        );
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
      const { imagePaths } = yield* materializeImageAttachments(
        "generateBranchName",
        input.attachments,
      );
      const { prompt, outputSchemaJson } = buildBranchNamePrompt({
        message: input.message,
        ...(input.attachments ? { attachments: input.attachments } : {}),
      });

      const generated = yield* runCodexJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson,
        imagePaths,
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
      const { imagePaths } = yield* materializeImageAttachments(
        "generateThreadTitle",
        input.attachments,
      );
      const { prompt, outputSchemaJson } = buildThreadTitlePrompt({
        message: input.message,
        ...(input.attachments ? { attachments: input.attachments } : {}),
      });

      const generated = yield* runCodexJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson,
        imagePaths,
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
