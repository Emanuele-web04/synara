import { randomUUID } from "node:crypto";

import { Effect, FileSystem, Layer, Option, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { DEFAULT_GIT_TEXT_GENERATION_MODEL, type ChatAttachment } from "@t3tools/contracts";
import { sanitizeGeneratedThreadTitle } from "@t3tools/shared/chatThreads";
import { resolveCodexHome } from "@t3tools/shared/codexConfig";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { buildCodexProcessEnv } from "../../codexAppServerManager.ts";
import { ServerConfig } from "../../config.ts";
import { TextGenerationError } from "../Errors.ts";
import {
  type BranchNameGenerationInput,
  type BranchNameGenerationResult,
  type CommitMessageGenerationResult,
  type DiffSummaryGenerationResult,
  type PrContentGenerationResult,
  type ThreadTitleGenerationResult,
  type TextGenerationShape,
  TextGeneration,
} from "../Services/TextGeneration.ts";

const CODEX_REASONING_EFFORT = "low";
const CODEX_TIMEOUT_MS = 180_000;

function toCodexOutputJsonSchema(schema: Schema.Top): unknown {
  const document = Schema.toJsonSchemaDocument(schema);
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    return {
      ...document.schema,
      $defs: document.definitions,
    };
  }
  return document.schema;
}

function normalizeCodexError(
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
      error.message.includes("Command not found: codex") ||
      lower.includes("spawn codex") ||
      lower.includes("enoent")
    ) {
      return new TextGenerationError({
        operation,
        detail: "Codex CLI (`codex`) is required but not available on PATH.",
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

function limitSection(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const truncated = value.slice(0, maxChars);
  return `${truncated}\n\n[truncated]`;
}

function formatAttachmentMetadataLine(attachment: ChatAttachment): string {
  if (attachment.type === "image") {
    return `- ${attachment.name} (${attachment.mimeType}, ${attachment.sizeBytes} bytes)`;
  }

  const preview = limitSection(attachment.text.replace(/\s+/g, " ").trim(), 160);
  return `- Assistant selection: ${preview}`;
}

function sanitizeCommitSubject(raw: string): string {
  const singleLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  const withoutTrailingPeriod = singleLine.replace(/[.]+$/g, "").trim();
  if (withoutTrailingPeriod.length === 0) {
    return "Update project files";
  }

  if (withoutTrailingPeriod.length <= 72) {
    return withoutTrailingPeriod;
  }
  return withoutTrailingPeriod.slice(0, 72).trimEnd();
}

function sanitizePrTitle(raw: string): string {
  const singleLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  if (singleLine.length > 0) {
    return singleLine;
  }
  return "Update project changes";
}

function sanitizeDiffSummary(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length > 0) {
    return trimmed;
  }

  return [
    "## Summary",
    "- Update the current diff.",
    "",
    "## Files Changed",
    "- Not available.",
  ].join("\n");
}

function sanitizeCodexConfigForTextGeneration(content: string): string {
  const lines = content.split(/\r?\n/g);
  const sanitized: string[] = [];
  let skippingSkillsConfig = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("[[")) {
      if (trimmed === "[[skills.config]]") {
        skippingSkillsConfig = true;
        continue;
      }

      skippingSkillsConfig = false;
      sanitized.push(line);
      continue;
    }

    if (trimmed.startsWith("[")) {
      skippingSkillsConfig = false;
      sanitized.push(line);
      continue;
    }

    if (!skippingSkillsConfig) {
      sanitized.push(line);
    }
  }

  return sanitized.join("\n").trimEnd();
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
          normalizeCodexError(operation, cause, "Failed to collect process output"),
        ),
      );
      return text;
    });

  const tempDir = process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP ?? "/tmp";

  const writeTempFile = (
    operation: string,
    prefix: string,
    content: string,
  ): Effect.Effect<string, TextGenerationError> => {
    const filePath = path.join(tempDir, `t3code-${prefix}-${process.pid}-${randomUUID()}.tmp`);
    return fileSystem.writeFileString(filePath, content).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail: `Failed to write temp file at ${filePath}.`,
            cause,
          }),
      ),
      Effect.as(filePath),
    );
  };

  const safeUnlink = (filePath: string): Effect.Effect<void, never> =>
    fileSystem.remove(filePath).pipe(Effect.catch(() => Effect.void));

  const safeRemoveDirectory = (directoryPath: string): Effect.Effect<void, never> =>
    fileSystem.remove(directoryPath, { recursive: true }).pipe(Effect.catch(() => Effect.void));

  const prepareIsolatedCodexHome = (
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateDiffSummary"
      | "generateBranchName"
      | "generateThreadTitle",
    sourceHomePath?: string,
  ): Effect.Effect<{ readonly homePath: string }, TextGenerationError> =>
    Effect.gen(function* () {
      const sourceCodexHome = sourceHomePath?.trim() || resolveCodexHome(process.env);
      const isolatedHomePath = path.join(
        tempDir,
        `t3code-codex-home-${process.pid}-${randomUUID()}`,
      );

      yield* fileSystem.makeDirectory(isolatedHomePath, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: `Failed to create isolated Codex home at ${isolatedHomePath}.`,
              cause,
            }),
        ),
      );

      const sourceConfig = yield* fileSystem
        .readFileString(path.join(sourceCodexHome, "config.toml"))
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (sourceConfig !== null) {
        yield* fileSystem
          .writeFileString(
            path.join(isolatedHomePath, "config.toml"),
            sanitizeCodexConfigForTextGeneration(sourceConfig),
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new TextGenerationError({
                  operation,
                  detail: "Failed to copy Codex config for isolated text generation.",
                  cause,
                }),
            ),
          );
      }

      const sourceAuth = yield* fileSystem
        .readFileString(path.join(sourceCodexHome, "auth.json"))
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (sourceAuth !== null) {
        yield* fileSystem
          .writeFileString(path.join(isolatedHomePath, "auth.json"), sourceAuth)
          .pipe(
            Effect.mapError(
              (cause) =>
                new TextGenerationError({
                  operation,
                  detail: "Failed to copy Codex auth for isolated text generation.",
                  cause,
                }),
            ),
          );
      }

      return { homePath: isolatedHomePath };
    });

  const materializeImageAttachments = (
    _operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateDiffSummary"
      | "generateBranchName"
      | "generateThreadTitle",
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
    cwd,
    prompt,
    outputSchemaJson,
    imagePaths = [],
    cleanupPaths = [],
    codexHomePath,
    model,
  }: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateDiffSummary"
      | "generateBranchName"
      | "generateThreadTitle";
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    imagePaths?: ReadonlyArray<string>;
    cleanupPaths?: ReadonlyArray<string>;
    codexHomePath?: string;
    model?: string;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const schemaPath = yield* writeTempFile(
        operation,
        "codex-schema",
        JSON.stringify(toCodexOutputJsonSchema(outputSchemaJson)),
      );
      const outputPath = yield* writeTempFile(operation, "codex-output", "");
      const isolatedCodexHome = yield* prepareIsolatedCodexHome(operation, codexHomePath);

      const runCodexCommand = Effect.gen(function* () {
        const command = ChildProcess.make(
          "codex",
          [
            "exec",
            "--ephemeral",
            "--skip-git-repo-check",
            "--config",
            'approval_policy="never"',
            "-s",
            "read-only",
            "--model",
            model ?? DEFAULT_GIT_TEXT_GENERATION_MODEL,
            "--config",
            `model_reasoning_effort="${CODEX_REASONING_EFFORT}"`,
            "--output-schema",
            schemaPath,
            "--output-last-message",
            outputPath,
            ...imagePaths.flatMap((imagePath) => ["--image", imagePath]),
            "-",
          ],
          {
            cwd,
            env: buildCodexProcessEnv({ homePath: isolatedCodexHome.homePath }),
            shell: process.platform === "win32",
            stdin: {
              stream: Stream.make(new TextEncoder().encode(prompt)),
            },
          },
        );

        const child = yield* commandSpawner
          .spawn(command)
          .pipe(
            Effect.mapError((cause) =>
              normalizeCodexError(operation, cause, "Failed to spawn Codex CLI process"),
            ),
          );

        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            readStreamAsString(operation, child.stdout),
            readStreamAsString(operation, child.stderr),
            child.exitCode.pipe(
              Effect.map((value) => Number(value)),
              Effect.mapError((cause) =>
                normalizeCodexError(operation, cause, "Failed to read Codex CLI exit code"),
              ),
            ),
          ],
          { concurrency: "unbounded" },
        );

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

      const cleanup = Effect.all(
        [
          safeUnlink(schemaPath),
          safeUnlink(outputPath),
          safeRemoveDirectory(isolatedCodexHome.homePath),
          ...cleanupPaths.map((filePath) => safeUnlink(filePath)),
        ],
        {
          concurrency: "unbounded",
        },
      ).pipe(Effect.asVoid);

      return yield* Effect.gen(function* () {
        yield* runCodexCommand.pipe(
          Effect.scoped,
          Effect.timeoutOption(CODEX_TIMEOUT_MS),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new TextGenerationError({ operation, detail: "Codex CLI request timed out." }),
                ),
              onSome: () => Effect.void,
            }),
          ),
        );

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
      }).pipe(Effect.ensuring(cleanup));
    });

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = (input) => {
    const wantsBranch = input.includeBranch === true;

    const prompt = [
      "You write concise git commit messages.",
      wantsBranch
        ? "Return a JSON object with keys: subject, body, branch."
        : "Return a JSON object with keys: subject, body.",
      "Rules:",
      "- subject must be imperative, <= 72 chars, and no trailing period",
      "- body can be empty string or short bullet points",
      ...(wantsBranch
        ? ["- branch must be a short semantic git branch fragment for this change"]
        : []),
      "- capture the primary user-visible or developer-visible change",
      "",
      `Branch: ${input.branch ?? "(detached)"}`,
      "",
      "Staged files:",
      limitSection(input.stagedSummary, 6_000),
      "",
      "Staged patch:",
      limitSection(input.stagedPatch, 40_000),
    ].join("\n");

    const outputSchemaJson = wantsBranch
      ? Schema.Struct({
          subject: Schema.String,
          body: Schema.String,
          branch: Schema.String,
        })
      : Schema.Struct({
          subject: Schema.String,
          body: Schema.String,
        });

    return runCodexJson({
      operation: "generateCommitMessage",
      cwd: input.cwd,
      prompt,
      outputSchemaJson,
      ...(input.codexHomePath ? { codexHomePath: input.codexHomePath } : {}),
      ...(input.model ? { model: input.model } : {}),
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
    const prompt = [
      "You write GitHub pull request content.",
      "Return a JSON object with keys: title, body.",
      "Rules:",
      "- title should be concise and specific",
      "- body must be markdown and include headings '## Summary' and '## Testing'",
      "- under Summary, provide short bullet points",
      "- under Testing, include bullet points with concrete checks or 'Not run' where appropriate",
      "",
      `Base branch: ${input.baseBranch}`,
      `Head branch: ${input.headBranch}`,
      "",
      "Commits:",
      limitSection(input.commitSummary, 12_000),
      "",
      "Diff stat:",
      limitSection(input.diffSummary, 12_000),
      "",
      "Diff patch:",
      limitSection(input.diffPatch, 40_000),
    ].join("\n");

    return runCodexJson({
      operation: "generatePrContent",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: Schema.Struct({
        title: Schema.String,
        body: Schema.String,
      }),
      ...(input.codexHomePath ? { codexHomePath: input.codexHomePath } : {}),
      ...(input.model ? { model: input.model } : {}),
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
    const prompt = [
      "You write GitHub-style engineering summaries for git diffs.",
      "Return a JSON object with key: summary.",
      "Rules:",
      "- summary must be markdown",
      "- include headings '## Summary' and '## Files Changed'",
      "- under each heading, use concise bullet points",
      "- describe only changes directly supported by the diff",
      "- mention risks or follow-ups only when clearly implied by the patch",
      "- do not invent tests, tickets, or product context",
      "",
      "Diff patch:",
      limitSection(input.patch, 50_000),
    ].join("\n");

    return runCodexJson({
      operation: "generateDiffSummary",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: Schema.Struct({
        summary: Schema.String,
      }),
      ...(input.codexHomePath ? { codexHomePath: input.codexHomePath } : {}),
      ...(input.model ? { model: input.model } : {}),
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
      const attachmentLines = (input.attachments ?? []).map(formatAttachmentMetadataLine);

      const promptSections = [
        "You generate concise git branch names.",
        "Return a JSON object with key: branch.",
        "Rules:",
        "- Branch should describe the requested work from the user message.",
        "- Keep it short and specific (2-6 words).",
        "- Use plain words only, no issue prefixes and no punctuation-heavy text.",
        "- If images are attached, use them as primary context for visual/UI issues.",
        "",
        "User message:",
        limitSection(input.message, 8_000),
      ];
      if (attachmentLines.length > 0) {
        promptSections.push(
          "",
          "Attachment metadata:",
          limitSection(attachmentLines.join("\n"), 4_000),
        );
      }
      const prompt = promptSections.join("\n");

      const generated = yield* runCodexJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: Schema.Struct({
          branch: Schema.String,
        }),
        imagePaths,
        ...(input.model ? { model: input.model } : {}),
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
      const attachmentLines = (input.attachments ?? []).map(formatAttachmentMetadataLine);

      const promptSections = [
        "You generate concise chat thread titles.",
        "Return a JSON object with key: title.",
        "Rules:",
        "- Summarize the user's request in 2-4 words.",
        "- Never exceed 4 words.",
        "- Use a short noun or verb phrase, not a full sentence.",
        "- Avoid quotes, markdown, emoji, and trailing punctuation.",
        "- If images are attached, use them as primary context for the title.",
        "",
        "User message:",
        limitSection(input.message, 8_000),
      ];
      if (attachmentLines.length > 0) {
        promptSections.push(
          "",
          "Attachment metadata:",
          limitSection(attachmentLines.join("\n"), 4_000),
        );
      }

      const generated = yield* runCodexJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt: promptSections.join("\n"),
        outputSchemaJson: Schema.Struct({
          title: Schema.String,
        }),
        imagePaths,
        ...(input.model ? { model: input.model } : {}),
      });

      return {
        title: sanitizeGeneratedThreadTitle(generated.title),
      } satisfies ThreadTitleGenerationResult;
    });
  };

  return {
    generateCommitMessage,
    generatePrContent,
    generateDiffSummary,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGenerationShape;
});

export const CodexTextGenerationLive = Layer.effect(TextGeneration, makeCodexTextGeneration);
