import { Effect, Fiber, FileSystem, Layer, Option, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { spawnSync } from "node:child_process";
import * as NodePath from "node:path";

import { sanitizeGeneratedThreadTitle } from "@synara/shared/chatThreads";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@synara/shared/git";
import { getModelSelectionStringOptionValue, resolveApiModelId } from "@synara/shared/model";
import { prepareWindowsSafeProcess } from "@synara/shared/windowsProcess";

import { TextGenerationError } from "../Errors.ts";
import {
  ClaudeTextGeneration,
  type CommitMessageGenerationResult,
  type DiffSummaryGenerationResult,
  type PrContentGenerationResult,
  type TextGenerationOperation,
  type TextGenerationShape,
  type ThreadRecapGenerationResult,
} from "../Services/TextGeneration.ts";
import {
  buildAutomationCompletionEvaluationPrompt,
  buildAutomationIntentPrompt,
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildDiffSummaryPrompt,
  buildPrContentPrompt,
  buildThreadRecapPrompt,
  buildThreadTitlePrompt,
  sanitizeCommitSubject,
  sanitizeDiffSummary,
  sanitizePrTitle,
  sanitizeThreadRecap,
  toJsonSchemaObject,
} from "../textGenerationShared.ts";
import { ServerConfig } from "../../config.ts";
import { buildClaudeProcessEnv } from "../../provider/claudeEnvironment.ts";

const CLAUDE_TIMEOUT_MS = 180_000;
const CLAUDE_SAFE_MODE_ENV_KEY = "CLAUDE_CODE_SAFE_MODE";

const ClaudeOutputEnvelope = Schema.Struct({
  structured_output: Schema.Unknown,
});

function normalizeClaudeError(
  binaryPath: string,
  operation: TextGenerationOperation,
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
        detail: `Claude CLI (${binaryPath}) is required but not available.`,
        cause: error,
      });
    }
    return new TextGenerationError({
      operation,
      detail: `${fallback}: ${error.message}`,
      cause: error,
    });
  }
  return new TextGenerationError({ operation, detail: fallback, cause: error });
}

function forceKillClaudeProcessGroup(pid: ChildProcessSpawner.ProcessId): void {
  const numericPid = Number(pid);
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
    try {
      spawnSync(
        NodePath.win32.join(systemRoot, "System32", "taskkill.exe"),
        ["/pid", String(numericPid), "/T", "/F"],
        {
          stdio: "ignore",
          timeout: 2_000,
          windowsHide: true,
        },
      );
    } catch {
      // Continue to the direct-process fallback below.
    }
    try {
      process.kill(numericPid, "SIGKILL");
    } catch {
      // The process tree is already gone or the platform rejected the fallback.
    }
    return;
  }

  try {
    process.kill(-numericPid, "SIGKILL");
    return;
  } catch {
    // The process may not be its own group; still attempt the individual PID.
  }
  try {
    process.kill(numericPid, "SIGKILL");
  } catch {
    // Best-effort cleanup must not replace the original timeout/interruption.
  }
}

function collectClaudeChildWithInterruptKill<A, E>(
  effect: Effect.Effect<A, E>,
  child: ChildProcessSpawner.ChildProcessHandle,
): Effect.Effect<A, E> {
  return Effect.acquireUseRelease(Effect.forkDetach(effect), Fiber.join, (fiber, exit) =>
    Effect.gen(function* () {
      if (exit._tag === "Failure") {
        // The detached collector is not interrupted with its caller. Kill the
        // tree first so pipe-holding descendants cannot block reader teardown.
        yield* Effect.sync(() => forceKillClaudeProcessGroup(child.pid));
      }
      yield* Fiber.interrupt(fiber).pipe(Effect.timeoutOption("2 seconds"), Effect.ignore);
    }).pipe(Effect.ignore),
  );
}

function resolveClaudeBinaryPath(input: {
  readonly providerOptions?: Parameters<
    TextGenerationShape["generateThreadTitle"]
  >[0]["providerOptions"];
}): string {
  return input.providerOptions?.claudeAgent?.binaryPath?.trim() || "claude";
}

function resolveClaudeEnvironment(input: {
  readonly providerOptions?: Parameters<
    TextGenerationShape["generateThreadTitle"]
  >[0]["providerOptions"];
  readonly homeDir?: string;
  readonly isolationRootDir?: string;
  readonly providerInstanceId?: string;
}): NodeJS.ProcessEnv {
  const claudeOptions = input.providerOptions?.claudeAgent;
  return buildClaudeProcessEnv({
    homePath: claudeOptions?.homePath,
    environment: claudeOptions?.environment,
    homeDir: input.homeDir,
    isolationRootDir: input.isolationRootDir,
    providerInstanceId: input.providerInstanceId,
  });
}

function resolveClaudeEffort(
  modelSelection: Parameters<TextGenerationShape["generateThreadTitle"]>[0]["modelSelection"],
): string | undefined {
  const effort = getModelSelectionStringOptionValue(modelSelection, "effort")?.trim();
  if (!effort || effort === "ultrathink") {
    return undefined;
  }
  return effort === "ultracode" ? "xhigh" : effort;
}

const makeClaudeTextGeneration = Effect.gen(function* () {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const serverConfig = yield* ServerConfig;

  const readStreamAsString = <E>(
    operation: TextGenerationOperation,
    stream: Stream.Stream<Uint8Array, E>,
  ): Effect.Effect<string, TextGenerationError> =>
    stream.pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => "",
        (acc, chunk) => acc + chunk,
      ),
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail: "Failed to collect Claude CLI process output.",
            cause,
          }),
      ),
    );

  const runClaudeJson = <S extends Schema.Top>({
    operation,
    prompt,
    outputSchemaJson,
    modelSelection,
    providerOptions,
  }: {
    operation: TextGenerationOperation;
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: NonNullable<
      Parameters<TextGenerationShape["generateThreadTitle"]>[0]["modelSelection"]
    >;
    providerOptions?: Parameters<TextGenerationShape["generateThreadTitle"]>[0]["providerOptions"];
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const binaryPath = resolveClaudeBinaryPath({ providerOptions });
      const env = resolveClaudeEnvironment({
        providerOptions,
        homeDir: serverConfig.homeDir,
        isolationRootDir: serverConfig.stateDir,
        providerInstanceId: modelSelection.instanceId,
      });
      // Keep the environment switch as defense in depth alongside the mandatory
      // CLI flag below. Binaries that predate --safe-mode must reject the request
      // rather than silently running auxiliary generation with customizations.
      env[CLAUDE_SAFE_MODE_ENV_KEY] = "1";
      const isolatedCwd = yield* fileSystem
        .makeTempDirectoryScoped({ prefix: "synara-claude-text-" })
        .pipe(
          Effect.tap((directory) =>
            process.platform === "win32" ? Effect.void : fileSystem.chmod(directory, 0o700),
          ),
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation,
                detail: "Failed to create the isolated Claude CLI workspace.",
                cause,
              }),
          ),
        );
      env.PWD = isolatedCwd;
      const jsonSchema = JSON.stringify(toJsonSchemaObject(outputSchemaJson));
      const effort = resolveClaudeEffort(modelSelection);
      const args = [
        "-p",
        "--safe-mode",
        // Do not load user, project, or local settings. Safe mode also blocks
        // customization surfaces outside those settings sources, while strict
        // MCP config ensures no inherited MCP server can be started.
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "--no-session-persistence",
        "--output-format",
        "json",
        "--json-schema",
        jsonSchema,
        "--model",
        resolveApiModelId(modelSelection),
        ...(effort ? ["--effort", effort] : []),
        // Pure JSON generation over prompt text: no tools, so untrusted diff
        // or thread content cannot prompt-inject workspace reads or edits.
        "--tools",
        "",
      ];
      const prepared = prepareWindowsSafeProcess(binaryPath, args, { cwd: isolatedCwd, env });
      const command = ChildProcess.make(prepared.command, prepared.args, {
        cwd: isolatedCwd,
        env,
        // Auxiliary generation has no state to preserve. A hard scoped kill
        // avoids waiting forever when a CLI or descendant ignores SIGTERM.
        killSignal: "SIGKILL",
        shell: prepared.shell,
        stdin: { stream: Stream.make(new TextEncoder().encode(prompt)) },
      });

      const child = yield* commandSpawner
        .spawn(command)
        .pipe(
          Effect.mapError((cause) =>
            normalizeClaudeError(
              binaryPath,
              operation,
              cause,
              "Failed to spawn Claude CLI process",
            ),
          ),
        );
      const [stdout, stderr, exitCode] = yield* collectClaudeChildWithInterruptKill(
        Effect.all(
          [
            readStreamAsString(operation, child.stdout),
            readStreamAsString(operation, child.stderr),
            child.exitCode.pipe(
              Effect.map((value) => Number(value)),
              Effect.mapError((cause) =>
                normalizeClaudeError(
                  binaryPath,
                  operation,
                  cause,
                  "Failed to read Claude CLI exit code",
                ),
              ),
            ),
          ],
          { concurrency: "unbounded" },
        ),
        child,
      );

      if (exitCode !== 0) {
        const stderrDetail = stderr.trim();
        const stdoutDetail = stdout.trim();
        const detail = stderrDetail.length > 0 ? stderrDetail : stdoutDetail;
        return yield* new TextGenerationError({
          operation,
          detail:
            detail.length > 0
              ? `Claude CLI command failed: ${detail}`
              : `Claude CLI command failed with code ${exitCode}.`,
        });
      }

      const envelope = yield* Schema.decodeEffect(Schema.fromJsonString(ClaudeOutputEnvelope))(
        stdout,
      ).pipe(
        Effect.catchTag("SchemaError", (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation,
              detail: "Claude CLI returned unexpected output format.",
              cause,
            }),
          ),
        ),
      );
      return yield* Schema.decodeEffect(outputSchemaJson)(envelope.structured_output).pipe(
        Effect.catchTag("SchemaError", (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation,
              detail: "Claude returned invalid structured output.",
              cause,
            }),
          ),
        ),
      );
    }).pipe(
      Effect.scoped,
      Effect.timeoutOption(CLAUDE_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TextGenerationError({ operation, detail: "Claude CLI request timed out." }),
            ),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
    );

  const requireClaudeModelSelection = (
    operation: TextGenerationOperation,
    modelSelection: Parameters<TextGenerationShape["generateThreadTitle"]>[0]["modelSelection"],
  ) =>
    modelSelection
      ? Effect.succeed(modelSelection)
      : Effect.fail(
          new TextGenerationError({
            operation,
            detail: "Invalid Claude model selection.",
          }),
        );

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
    "ClaudeTextGeneration.generateCommitMessage",
  )(function* (input) {
    const modelSelection = yield* requireClaudeModelSelection(
      "generateCommitMessage",
      input.modelSelection,
    );
    const { prompt, outputSchemaJson } = buildCommitMessagePrompt({
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: input.includeBranch === true,
    });
    const generated = yield* runClaudeJson({
      operation: "generateCommitMessage",
      cwd: input.cwd,
      prompt,
      outputSchemaJson,
      modelSelection,
      ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
    });
    return {
      subject: sanitizeCommitSubject(generated.subject),
      body: generated.body.trim(),
      ...("branch" in generated && typeof generated.branch === "string"
        ? { branch: sanitizeFeatureBranchName(generated.branch) }
        : {}),
    } satisfies CommitMessageGenerationResult;
  });

  const generatePrContent: TextGenerationShape["generatePrContent"] = Effect.fn(
    "ClaudeTextGeneration.generatePrContent",
  )(function* (input) {
    const modelSelection = yield* requireClaudeModelSelection(
      "generatePrContent",
      input.modelSelection,
    );
    const { prompt, outputSchemaJson } = buildPrContentPrompt({
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      commitSummary: input.commitSummary,
      diffSummary: input.diffSummary,
      diffPatch: input.diffPatch,
    });
    const generated = yield* runClaudeJson({
      operation: "generatePrContent",
      cwd: input.cwd,
      prompt,
      outputSchemaJson,
      modelSelection,
      ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
    });
    return {
      title: sanitizePrTitle(generated.title),
      body: generated.body.trim(),
    } satisfies PrContentGenerationResult;
  });

  const generateDiffSummary: TextGenerationShape["generateDiffSummary"] = Effect.fn(
    "ClaudeTextGeneration.generateDiffSummary",
  )(function* (input) {
    const modelSelection = yield* requireClaudeModelSelection(
      "generateDiffSummary",
      input.modelSelection,
    );
    const { prompt, outputSchemaJson } = buildDiffSummaryPrompt({ patch: input.patch });
    const generated = yield* runClaudeJson({
      operation: "generateDiffSummary",
      cwd: input.cwd,
      prompt,
      outputSchemaJson,
      modelSelection,
      ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
    });
    return {
      summary: sanitizeDiffSummary(generated.summary),
    } satisfies DiffSummaryGenerationResult;
  });

  const generateBranchName: TextGenerationShape["generateBranchName"] = Effect.fn(
    "ClaudeTextGeneration.generateBranchName",
  )(function* (input) {
    const modelSelection = yield* requireClaudeModelSelection(
      "generateBranchName",
      input.modelSelection,
    );
    const { prompt, outputSchemaJson } = buildBranchNamePrompt({
      message: input.message,
      ...(input.attachments ? { attachments: input.attachments } : {}),
    });
    const generated = yield* runClaudeJson({
      operation: "generateBranchName",
      cwd: input.cwd,
      prompt,
      outputSchemaJson,
      modelSelection,
      ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
    });
    return { branch: sanitizeBranchFragment(generated.branch) };
  });

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
    "ClaudeTextGeneration.generateThreadTitle",
  )(function* (input) {
    const modelSelection = yield* requireClaudeModelSelection(
      "generateThreadTitle",
      input.modelSelection,
    );
    const { prompt, outputSchemaJson } = buildThreadTitlePrompt({
      message: input.message,
      ...(input.attachments ? { attachments: input.attachments } : {}),
    });
    const generated = yield* runClaudeJson({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      prompt,
      outputSchemaJson,
      modelSelection,
      ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
    });
    return { title: sanitizeGeneratedThreadTitle(generated.title) };
  });

  const generateThreadRecap: TextGenerationShape["generateThreadRecap"] = Effect.fn(
    "ClaudeTextGeneration.generateThreadRecap",
  )(function* (input) {
    const modelSelection = yield* requireClaudeModelSelection(
      "generateThreadRecap",
      input.modelSelection,
    );
    const { prompt, outputSchemaJson } = buildThreadRecapPrompt({
      ...(input.previousRecap ? { previousRecap: input.previousRecap } : {}),
      newMaterial: input.newMaterial,
      ...(input.currentState ? { currentState: input.currentState } : {}),
    });
    const generated = yield* runClaudeJson({
      operation: "generateThreadRecap",
      cwd: input.cwd,
      prompt,
      outputSchemaJson,
      modelSelection,
      ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
    });
    return {
      recap: sanitizeThreadRecap(generated.recap, input.previousRecap),
    } satisfies ThreadRecapGenerationResult;
  });

  const generateAutomationIntent: TextGenerationShape["generateAutomationIntent"] = Effect.fn(
    "ClaudeTextGeneration.generateAutomationIntent",
  )(function* (input) {
    const modelSelection = yield* requireClaudeModelSelection(
      "generateAutomationIntent",
      input.modelSelection,
    );
    const { prompt, outputSchemaJson } = buildAutomationIntentPrompt({
      message: input.message,
      ...(input.defaultMode ? { defaultMode: input.defaultMode } : {}),
      nowIso: input.nowIso,
    });
    return yield* runClaudeJson({
      operation: "generateAutomationIntent",
      cwd: input.cwd,
      prompt,
      outputSchemaJson,
      modelSelection,
      ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
    });
  });

  const evaluateAutomationCompletion: TextGenerationShape["evaluateAutomationCompletion"] =
    Effect.fn("ClaudeTextGeneration.evaluateAutomationCompletion")(function* (input) {
      const modelSelection = yield* requireClaudeModelSelection(
        "evaluateAutomationCompletion",
        input.modelSelection,
      );
      const { prompt, outputSchemaJson } = buildAutomationCompletionEvaluationPrompt(input);
      return yield* runClaudeJson({
        operation: "evaluateAutomationCompletion",
        cwd: input.cwd,
        prompt,
        outputSchemaJson,
        modelSelection,
        ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
      });
    });

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

export const ClaudeTextGenerationServiceLive = Layer.effect(
  ClaudeTextGeneration,
  makeClaudeTextGeneration,
);
