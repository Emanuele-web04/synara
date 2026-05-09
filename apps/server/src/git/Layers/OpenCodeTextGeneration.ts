import { Effect, Exit, Fiber, Layer, Schema, Scope } from "effect";
import * as Semaphore from "effect/Semaphore";

import type {
  ChatAttachment,
  OpenCodeModelSelection,
  ProviderStartOptions,
} from "@t3tools/contracts";
import { sanitizeGeneratedThreadTitle } from "@t3tools/shared/chatThreads";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  OpenCodeRuntime,
  type OpenCodeServerConnection,
  type OpenCodeServerProcess,
  openCodeRuntimeErrorDetail,
  parseOpenCodeModelSlug,
  toOpenCodeFileParts,
} from "../../provider/opencodeRuntime.ts";
import { TextGenerationError } from "../Errors.ts";
import { type TextGenerationShape, OpenCodeTextGeneration } from "../Services/TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildDiffSummaryPrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
  extractJsonObject,
  sanitizeCommitSubject,
  sanitizeDiffSummary,
  sanitizePrTitle,
} from "../textGenerationShared.ts";

const OPENCODE_TEXT_GENERATION_IDLE_TTL = "30 seconds";

function getOpenCodePromptErrorMessage(error: unknown): string | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const message =
    "data" in error &&
    error.data &&
    typeof error.data === "object" &&
    "message" in error.data &&
    typeof error.data.message === "string"
      ? error.data.message.trim()
      : "";
  if (message.length > 0) {
    return message;
  }

  if ("name" in error && typeof error.name === "string") {
    const name = error.name.trim();
    return name.length > 0 ? name : null;
  }

  return null;
}

function getOpenCodeTextResponse(parts: ReadonlyArray<unknown> | undefined): string {
  return (parts ?? [])
    .flatMap((part) => {
      if (!part || typeof part !== "object") {
        return [];
      }
      if (!("type" in part) || part.type !== "text") {
        return [];
      }
      if (!("text" in part) || typeof part.text !== "string") {
        return [];
      }
      return [part.text];
    })
    .join("")
    .trim();
}

interface SharedOpenCodeTextGenerationServerState {
  server: OpenCodeServerProcess | null;
  serverScope: Scope.Closeable | null;
  binaryPath: string | null;
  activeRequests: number;
  idleCloseFiber: Fiber.Fiber<void, never> | null;
}

function resolveOpenCodeModelSelection(input: {
  readonly model?: string;
  readonly modelSelection?: { provider: string; model: string; options?: unknown };
}): OpenCodeModelSelection | null {
  if (input.modelSelection?.provider === "opencode") {
    return input.modelSelection as OpenCodeModelSelection;
  }

  const model = input.model?.trim();
  if (!model || parseOpenCodeModelSlug(model) === null) {
    return null;
  }

  return {
    provider: "opencode",
    model,
  };
}

const makeOpenCodeTextGeneration = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig;
  const openCodeRuntime = yield* OpenCodeRuntime;
  const idleFiberScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );
  const sharedServerMutex = yield* Semaphore.make(1);
  const sharedServerState: SharedOpenCodeTextGenerationServerState = {
    server: null,
    serverScope: null,
    binaryPath: null,
    activeRequests: 0,
    idleCloseFiber: null,
  };

  const closeSharedServer = Effect.fn("closeSharedServer")(function* () {
    const scope = sharedServerState.serverScope;
    sharedServerState.server = null;
    sharedServerState.serverScope = null;
    sharedServerState.binaryPath = null;
    if (scope !== null) {
      yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
    }
  });

  const cancelIdleCloseFiber = Effect.fn("cancelIdleCloseFiber")(function* () {
    const idleCloseFiber = sharedServerState.idleCloseFiber;
    sharedServerState.idleCloseFiber = null;
    if (idleCloseFiber !== null) {
      yield* Fiber.interrupt(idleCloseFiber).pipe(Effect.ignore);
    }
  });

  const scheduleIdleClose = Effect.fn("scheduleIdleClose")(function* (
    server: OpenCodeServerProcess,
  ) {
    yield* cancelIdleCloseFiber();
    const fiber = yield* Effect.sleep(OPENCODE_TEXT_GENERATION_IDLE_TTL).pipe(
      Effect.andThen(
        sharedServerMutex.withPermit(
          Effect.gen(function* () {
            if (sharedServerState.server !== server || sharedServerState.activeRequests > 0) {
              return;
            }
            sharedServerState.idleCloseFiber = null;
            yield* closeSharedServer();
          }),
        ),
      ),
      Effect.forkIn(idleFiberScope),
    );
    sharedServerState.idleCloseFiber = fiber;
  });

  const acquireSharedServer = (input: {
    readonly binaryPath: string;
    readonly operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateDiffSummary"
      | "generateBranchName"
      | "generateThreadTitle";
  }) =>
    sharedServerMutex.withPermit(
      Effect.gen(function* () {
        yield* cancelIdleCloseFiber();

        const existingServer = sharedServerState.server;
        if (existingServer !== null) {
          if (
            sharedServerState.binaryPath !== input.binaryPath &&
            sharedServerState.activeRequests === 0
          ) {
            yield* closeSharedServer();
          } else {
            if (sharedServerState.binaryPath !== input.binaryPath) {
              yield* Effect.logWarning(
                "OpenCode shared server binary path mismatch: requested " +
                  input.binaryPath +
                  " but active server uses " +
                  sharedServerState.binaryPath +
                  "; reusing existing server because there are active requests",
              );
            }
            sharedServerState.activeRequests += 1;
            return existingServer;
          }
        }

        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const serverScope = yield* Scope.make();
            const startedExit = yield* Effect.exit(
              restore(
                openCodeRuntime
                  .startOpenCodeServerProcess({
                    binaryPath: input.binaryPath,
                  })
                  .pipe(
                    Effect.provideService(Scope.Scope, serverScope),
                    Effect.mapError(
                      (cause) =>
                        new TextGenerationError({
                          operation: input.operation,
                          detail: openCodeRuntimeErrorDetail(cause),
                          cause,
                        }),
                    ),
                  ),
              ),
            );

            if (startedExit._tag === "Failure") {
              yield* Scope.close(serverScope, Exit.void).pipe(Effect.ignore);
              return yield* Effect.failCause(startedExit.cause);
            }

            const server = startedExit.value;
            sharedServerState.server = server;
            sharedServerState.serverScope = serverScope;
            sharedServerState.binaryPath = input.binaryPath;
            sharedServerState.activeRequests = 1;
            return server;
          }),
        );
      }),
    );

  const releaseSharedServer = (server: OpenCodeServerProcess) =>
    sharedServerMutex.withPermit(
      Effect.gen(function* () {
        if (sharedServerState.server !== server) {
          return;
        }
        sharedServerState.activeRequests = Math.max(0, sharedServerState.activeRequests - 1);
        if (sharedServerState.activeRequests === 0) {
          yield* scheduleIdleClose(server);
        }
      }),
    );

  yield* Effect.addFinalizer(() =>
    sharedServerMutex.withPermit(
      Effect.gen(function* () {
        yield* cancelIdleCloseFiber();
        sharedServerState.activeRequests = 0;
        yield* closeSharedServer();
      }),
    ),
  );

  const runOpenCodeJson = Effect.fn("runOpenCodeJson")(function* <S extends Schema.Top>(input: {
    readonly operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateDiffSummary"
      | "generateBranchName"
      | "generateThreadTitle";
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchemaJson: S;
    readonly modelSelection: OpenCodeModelSelection;
    readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
    readonly providerOptions?: ProviderStartOptions;
  }) {
    const parsedModel = parseOpenCodeModelSlug(input.modelSelection.model);
    if (!parsedModel) {
      return yield* new TextGenerationError({
        operation: input.operation,
        detail: "OpenCode model selection must use the 'provider/model' format.",
      });
    }

    const binaryPath = input.providerOptions?.opencode?.binaryPath?.trim() || "opencode";
    const serverUrl = input.providerOptions?.opencode?.serverUrl?.trim() || "";
    const serverPassword = input.providerOptions?.opencode?.serverPassword?.trim() || "";
    const providerId = parsedModel.providerID;
    const modelId = parsedModel.modelID;
    const agent = input.modelSelection.options?.agent ?? null;
    const variant = input.modelSelection.options?.variant ?? null;

    const fileParts = toOpenCodeFileParts({
      attachments: input.attachments,
      resolveAttachmentPath: (attachment) =>
        resolveAttachmentPath({ attachmentsDir: serverConfig.attachmentsDir, attachment }),
    });

    const runAgainstServer = (server: Pick<OpenCodeServerConnection, "url">) =>
      Effect.tryPromise({
        try: async () => {
          const client = openCodeRuntime.createOpenCodeSdkClient({
            baseUrl: server.url,
            directory: input.cwd,
            ...(serverPassword.length > 0 ? { serverPassword } : {}),
          });
          const sessionCreateInput = {
            title: `T3 Code ${input.operation}`,
            model: {
              providerID: providerId,
              id: modelId,
              ...(variant ? { variant } : {}),
            },
            ...(agent ? { agent } : {}),
            permission: [{ permission: "*", pattern: "*", action: "deny" }],
          };
          const session = await client.session.create(
            sessionCreateInput as unknown as Parameters<typeof client.session.create>[0],
          );
          if (!session.data) {
            throw new Error("OpenCode session.create returned no session payload.");
          }

          const result = await client.session.prompt({
            sessionID: session.data.id,
            model: parsedModel,
            ...(input.modelSelection.options?.agent
              ? { agent: input.modelSelection.options.agent }
              : {}),
            ...(input.modelSelection.options?.variant
              ? { variant: input.modelSelection.options.variant }
              : {}),
            parts: [{ type: "text", text: input.prompt }, ...fileParts],
          });
          const info = result.data?.info;
          const errorMessage = getOpenCodePromptErrorMessage(info?.error);
          if (errorMessage) {
            throw new Error(errorMessage);
          }
          const rawText = getOpenCodeTextResponse(result.data?.parts);
          if (rawText.length === 0) {
            throw new Error("OpenCode returned empty output.");
          }
          return rawText;
        },
        catch: (cause) =>
          new TextGenerationError({
            operation: input.operation,
            detail: [
              openCodeRuntimeErrorDetail(cause),
              `model=${providerId}/${modelId}`,
              variant ? `variant=${variant}` : null,
              agent ? `agent=${agent}` : null,
              serverUrl.length > 0 ? "server=external" : "server=managed",
            ]
              .filter(Boolean)
              .join(" "),
            cause,
          }),
      });

    yield* Effect.logDebug("OpenCode text generation request", {
      operation: input.operation,
      cwd: input.cwd,
      providerId,
      modelId,
      variant,
      agent,
      attachmentCount: input.attachments?.length ?? 0,
      filePartCount: fileParts.length,
      binaryPath,
      usingExternalServer: serverUrl.length > 0,
    });

    const rawOutput =
      serverUrl.length > 0
        ? yield* runAgainstServer({ url: serverUrl })
        : yield* Effect.acquireUseRelease(
            acquireSharedServer({
              binaryPath,
              operation: input.operation,
            }),
            runAgainstServer,
            releaseSharedServer,
          );

    return yield* Schema.decodeEffect(Schema.fromJsonString(input.outputSchemaJson))(
      extractJsonObject(rawOutput),
    ).pipe(
      Effect.catchTag("SchemaError", (cause) =>
        Effect.fail(
          new TextGenerationError({
            operation: input.operation,
            detail: "OpenCode returned invalid structured output.",
            cause,
          }),
        ),
      ),
    );
  });

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
    "OpenCodeTextGeneration.generateCommitMessage",
  )(function* (input) {
    const modelSelection = resolveOpenCodeModelSelection(input);
    if (!modelSelection) {
      return yield* new TextGenerationError({
        operation: "generateCommitMessage",
        detail: "Invalid OpenCode model selection.",
      });
    }

    const { prompt, outputSchemaJson } = buildCommitMessagePrompt({
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: input.includeBranch === true,
    });
    const generated = yield* runOpenCodeJson({
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
    };
  });

  const generatePrContent: TextGenerationShape["generatePrContent"] = Effect.fn(
    "OpenCodeTextGeneration.generatePrContent",
  )(function* (input) {
    const modelSelection = resolveOpenCodeModelSelection(input);
    if (!modelSelection) {
      return yield* new TextGenerationError({
        operation: "generatePrContent",
        detail: "Invalid OpenCode model selection.",
      });
    }

    const { prompt, outputSchemaJson } = buildPrContentPrompt({
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      commitSummary: input.commitSummary,
      diffSummary: input.diffSummary,
      diffPatch: input.diffPatch,
    });
    const generated = yield* runOpenCodeJson({
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
    };
  });

  const generateDiffSummary: TextGenerationShape["generateDiffSummary"] = Effect.fn(
    "OpenCodeTextGeneration.generateDiffSummary",
  )(function* (input) {
    const modelSelection = resolveOpenCodeModelSelection(input);
    if (!modelSelection) {
      return yield* new TextGenerationError({
        operation: "generateDiffSummary",
        detail: "Invalid OpenCode model selection.",
      });
    }

    const { prompt, outputSchemaJson } = buildDiffSummaryPrompt({
      patch: input.patch,
    });
    const generated = yield* runOpenCodeJson({
      operation: "generateDiffSummary",
      cwd: input.cwd,
      prompt,
      outputSchemaJson,
      modelSelection,
      ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
    });

    return {
      summary: sanitizeDiffSummary(generated.summary),
    };
  });

  const generateBranchName: TextGenerationShape["generateBranchName"] = Effect.fn(
    "OpenCodeTextGeneration.generateBranchName",
  )(function* (input) {
    const modelSelection = resolveOpenCodeModelSelection(input);
    if (!modelSelection) {
      return yield* new TextGenerationError({
        operation: "generateBranchName",
        detail: "Invalid OpenCode model selection.",
      });
    }

    const { prompt, outputSchemaJson } = buildBranchNamePrompt({
      message: input.message,
      ...(input.attachments ? { attachments: input.attachments } : {}),
    });
    const generated = yield* runOpenCodeJson({
      operation: "generateBranchName",
      cwd: input.cwd,
      prompt,
      outputSchemaJson,
      modelSelection,
      ...(input.attachments ? { attachments: input.attachments } : {}),
      ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
    });

    return {
      branch: sanitizeBranchFragment(generated.branch),
    };
  });

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
    "OpenCodeTextGeneration.generateThreadTitle",
  )(function* (input) {
    const modelSelection = resolveOpenCodeModelSelection(input);
    if (!modelSelection) {
      return yield* new TextGenerationError({
        operation: "generateThreadTitle",
        detail: "Invalid OpenCode model selection.",
      });
    }

    const { prompt, outputSchemaJson } = buildThreadTitlePrompt({
      message: input.message,
      ...(input.attachments ? { attachments: input.attachments } : {}),
    });
    const generated = yield* runOpenCodeJson({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      prompt,
      outputSchemaJson,
      modelSelection,
      ...(input.attachments ? { attachments: input.attachments } : {}),
      ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
    });

    return {
      title: sanitizeGeneratedThreadTitle(generated.title),
    };
  });

  return {
    generateCommitMessage,
    generatePrContent,
    generateDiffSummary,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGenerationShape;
});

export const OpenCodeTextGenerationServiceLive = Layer.effect(
  OpenCodeTextGeneration,
  makeOpenCodeTextGeneration,
);
