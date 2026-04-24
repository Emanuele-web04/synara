import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { ChatAttachment, ProviderApprovalDecision, RuntimeMode } from "@t3tools/contracts";
import {
  type ConsoleState,
  createOpencodeClient,
  type Agent,
  type FilePartInput,
  type OpencodeClient,
  type PermissionRuleset,
  type ProviderListResponse,
  type QuestionAnswer,
  type QuestionRequest,
} from "@opencode-ai/sdk/v2";
import {
  Cause,
  Data,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Predicate as P,
  Ref,
  Result,
  ServiceMap,
  Scope,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { NetService } from "@t3tools/shared/Net";
import { isWindowsShellCommandMissingResult } from "../shell-command-detection.ts";

const OPENCODE_SERVER_READY_PREFIX = "opencode server listening";
const DEFAULT_OPENCODE_SERVER_TIMEOUT_MS = 5_000;
const DEFAULT_HOSTNAME = "127.0.0.1";

export interface OpenCodeServerProcess {
  readonly url: string;
  readonly exitCode: Effect.Effect<number, never>;
}

export interface OpenCodeServerConnection {
  readonly url: string;
  readonly exitCode: Effect.Effect<number, never> | null;
  readonly external: boolean;
}

const OPENCODE_RUNTIME_ERROR_TAG = "OpenCodeRuntimeError";
export class OpenCodeRuntimeError extends Data.TaggedError(OPENCODE_RUNTIME_ERROR_TAG)<{
  readonly operation: string;
  readonly cause?: unknown;
  readonly detail: string;
}> {
  static readonly is = (u: unknown): u is OpenCodeRuntimeError =>
    P.isTagged(u, OPENCODE_RUNTIME_ERROR_TAG);
}

export function openCodeRuntimeErrorDetail(cause: unknown): string {
  if (OpenCodeRuntimeError.is(cause)) return cause.detail;
  if (cause instanceof Error && cause.message.trim().length > 0) return cause.message.trim();
  if (cause && typeof cause === "object") {
    const anyCause = cause as Record<string, unknown>;
    const status = (anyCause.response as { status?: number } | undefined)?.status;
    const body = anyCause.error ?? anyCause.data ?? anyCause.body;
    try {
      return `status=${status ?? "?"} body=${JSON.stringify(body ?? cause)}`;
    } catch {
      // ignore stringify failure
    }
  }
  return String(cause);
}

export const runOpenCodeSdk = <A>(
  operation: string,
  fn: () => Promise<A>,
): Effect.Effect<A, OpenCodeRuntimeError> =>
  Effect.tryPromise({
    try: fn,
    catch: (cause) =>
      new OpenCodeRuntimeError({ operation, detail: openCodeRuntimeErrorDetail(cause), cause }),
  }).pipe(Effect.withSpan(`opencode.${operation}`));

export interface OpenCodeCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export interface OpenCodeInventory {
  readonly providerList: ProviderListResponse;
  readonly agents: ReadonlyArray<Agent>;
  readonly consoleState: ConsoleState | null;
}

export interface ParsedOpenCodeModelSlug {
  readonly providerID: string;
  readonly modelID: string;
}

export interface OpenCodeCliModelDescriptor {
  readonly slug: string;
  readonly providerID: string;
  readonly modelID: string;
  readonly name: string;
  readonly variants: ReadonlyArray<string>;
  readonly supportedReasoningEfforts: ReadonlyArray<{
    readonly value: string;
    readonly label?: string;
    readonly description?: string;
  }>;
  readonly defaultReasoningEffort?: string;
}

export interface OpenCodePathInfo {
  readonly home: string;
  readonly state: string;
  readonly config: string;
  readonly worktree: string;
  readonly directory: string;
}

export interface OpenCodeRuntimeShape {
  readonly startOpenCodeServerProcess: (input: {
    readonly binaryPath: string;
    readonly port?: number;
    readonly hostname?: string;
    readonly timeoutMs?: number;
  }) => Effect.Effect<OpenCodeServerProcess, OpenCodeRuntimeError, Scope.Scope>;
  readonly connectToOpenCodeServer: (input: {
    readonly binaryPath: string;
    readonly serverUrl?: string | null;
    readonly port?: number;
    readonly hostname?: string;
    readonly timeoutMs?: number;
  }) => Effect.Effect<OpenCodeServerConnection, OpenCodeRuntimeError, Scope.Scope>;
  readonly runOpenCodeCommand: (input: {
    readonly binaryPath: string;
    readonly args: ReadonlyArray<string>;
  }) => Effect.Effect<OpenCodeCommandResult, OpenCodeRuntimeError>;
  readonly createOpenCodeSdkClient: (input: {
    readonly baseUrl: string;
    readonly directory: string;
    readonly serverPassword?: string;
  }) => OpencodeClient;
  readonly loadOpenCodeInventory: (
    client: OpencodeClient,
  ) => Effect.Effect<OpenCodeInventory, OpenCodeRuntimeError>;
  readonly listOpenCodeCliModels: (input: {
    readonly binaryPath: string;
  }) => Effect.Effect<ReadonlyArray<OpenCodeCliModelDescriptor>, OpenCodeRuntimeError>;
  readonly loadOpenCodeCredentialProviderIDs: (
    client: OpencodeClient,
  ) => Effect.Effect<ReadonlyArray<string>, never>;
}

function parseServerUrlFromOutput(output: string): string | null {
  for (const line of output.split("\n")) {
    if (!line.startsWith(OPENCODE_SERVER_READY_PREFIX)) {
      continue;
    }
    const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
    return match?.[1] ?? null;
  }
  return null;
}

export function parseOpenCodeModelSlug(
  slug: string | null | undefined,
): ParsedOpenCodeModelSlug | null {
  if (typeof slug !== "string") {
    return null;
  }

  const trimmed = slug.trim();
  const separator = trimmed.indexOf("/");
  if (separator <= 0 || separator === trimmed.length - 1) {
    return null;
  }

  return {
    providerID: trimmed.slice(0, separator),
    modelID: trimmed.slice(separator + 1),
  };
}

function trimToNull(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function fallbackOpenCodeModelName(slug: string, parsedSlug: ParsedOpenCodeModelSlug): string {
  return trimToNull(parsedSlug.modelID) ?? slug;
}

function resolveOpenCodeDataDirectory(homeDirectory: string): string {
  if (process.platform === "win32") {
    const appDataDirectory =
      trimToNull(process.env.APPDATA) ?? join(homeDirectory, "AppData", "Roaming");
    return join(appDataDirectory, "opencode");
  }

  const xdgDataHome =
    trimToNull(process.env.XDG_DATA_HOME) ?? join(homeDirectory, ".local", "share");
  return join(xdgDataHome, "opencode");
}

export function resolveOpenCodeAuthFilePath(pathInfo: Pick<OpenCodePathInfo, "home">): string {
  return join(resolveOpenCodeDataDirectory(pathInfo.home), "auth.json");
}

export function parseOpenCodeCredentialProviderIDs(content: string): ReadonlyArray<string> {
  const parsed = JSON.parse(content) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [];
  }

  return Object.entries(parsed as Record<string, unknown>)
    .flatMap(([providerID, value]) =>
      value && typeof value === "object" && !Array.isArray(value) ? [providerID.trim()] : [],
    )
    .filter((providerID) => providerID.length > 0)
    .toSorted((left, right) => left.localeCompare(right));
}

function readJsonObjectBlock(
  source: string,
  startIndex: number,
): { readonly json: string; readonly nextIndex: number } | null {
  if (source[startIndex] !== "{") {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = startIndex; index < source.length; index += 1) {
    const char = source[index];
    if (!char) {
      break;
    }

    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === "\\") {
        escaping = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return {
          json: source.slice(startIndex, index + 1),
          nextIndex: index + 1,
        };
      }
    }
  }

  return null;
}

function parseOpenCodeCliModelJson(
  value: unknown,
  slug: string,
  parsedSlug: ParsedOpenCodeModelSlug,
): OpenCodeCliModelDescriptor {
  const object = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const providerID = trimToNull(object.providerID) ?? parsedSlug.providerID;
  const modelID = trimToNull(object.id) ?? parsedSlug.modelID;
  const name = trimToNull(object.name) ?? fallbackOpenCodeModelName(slug, parsedSlug);
  const variantsObject =
    object.variants && typeof object.variants === "object" && !Array.isArray(object.variants)
      ? (object.variants as Record<string, unknown>)
      : {};
  const variants = Object.keys(variantsObject)
    .map((variant) => variant.trim())
    .filter((variant) => variant.length > 0)
    .toSorted((left, right) => left.localeCompare(right));
  const supportedReasoningEfforts = Array.from(
    new Map(
      Object.values(variantsObject).flatMap((variant) => {
        const variantObject =
          variant && typeof variant === "object" && !Array.isArray(variant)
            ? (variant as Record<string, unknown>)
            : null;
        if (!variantObject) {
          return [];
        }

        const reasoningValue =
          trimToNull(variantObject.reasoningEffort) ?? trimToNull(variantObject.reasoning_effort);
        if (!reasoningValue) {
          return [];
        }

        const label = trimToNull(variantObject.label) ?? undefined;
        const description = trimToNull(variantObject.description) ?? undefined;
        return [
          [
            reasoningValue,
            {
              value: reasoningValue,
              ...(label ? { label } : {}),
              ...(description ? { description } : {}),
            },
          ] as const,
        ];
      }),
    ).values(),
  );
  const defaultReasoningEffort =
    trimToNull(object.defaultReasoningEffort) ??
    trimToNull(object.default_reasoning_effort) ??
    (object.options && typeof object.options === "object" && !Array.isArray(object.options)
      ? (trimToNull((object.options as Record<string, unknown>).reasoningEffort) ??
        trimToNull((object.options as Record<string, unknown>).reasoning_effort))
      : null) ??
    undefined;

  return {
    slug,
    providerID,
    modelID,
    name,
    variants,
    supportedReasoningEfforts,
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
  };
}

export function parseOpenCodeCliModelsOutput(
  output: string,
): ReadonlyArray<OpenCodeCliModelDescriptor> {
  const models = new Map<string, OpenCodeCliModelDescriptor>();
  let index = 0;

  while (index < output.length) {
    while (index < output.length && /\s/u.test(output[index]!)) {
      index += 1;
    }
    if (index >= output.length) {
      break;
    }

    const lineEnd = output.indexOf("\n", index);
    const nextLineIndex = lineEnd === -1 ? output.length : lineEnd + 1;
    const candidate = output.slice(index, lineEnd === -1 ? output.length : lineEnd).trim();
    index = nextLineIndex;

    const parsedSlug = parseOpenCodeModelSlug(candidate);
    if (!parsedSlug) {
      continue;
    }

    let descriptor: OpenCodeCliModelDescriptor = {
      slug: candidate,
      providerID: parsedSlug.providerID,
      modelID: parsedSlug.modelID,
      name: fallbackOpenCodeModelName(candidate, parsedSlug),
      variants: [],
      supportedReasoningEfforts: [],
    };

    while (index < output.length && /\s/u.test(output[index]!)) {
      index += 1;
    }

    if (output[index] === "{") {
      const block = readJsonObjectBlock(output, index);
      if (block) {
        try {
          descriptor = parseOpenCodeCliModelJson(JSON.parse(block.json), candidate, parsedSlug);
        } catch {
          // Keep the slug-derived fallback descriptor when the JSON block cannot be parsed.
        }
        index = block.nextIndex;
      }
    }

    models.set(descriptor.slug, descriptor);
  }

  return [...models.values()].toSorted(
    (left, right) => left.name.localeCompare(right.name) || left.slug.localeCompare(right.slug),
  );
}

function toListModelsCommandError(input: {
  readonly binaryPath: string;
  readonly args: ReadonlyArray<string>;
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}): OpenCodeRuntimeError {
  return new OpenCodeRuntimeError({
    operation: "listOpenCodeCliModels",
    detail: [
      `Failed to execute '${input.binaryPath} ${input.args.join(" ")}' (exit code ${String(input.code)}).`,
      input.stdout.trim().length > 0 ? `stdout:\n${input.stdout.trim()}` : null,
      input.stderr.trim().length > 0 ? `stderr:\n${input.stderr.trim()}` : null,
    ]
      .filter(Boolean)
      .join("\n\n"),
    cause: {
      code: input.code,
      stdout: input.stdout,
      stderr: input.stderr,
    },
  });
}

function supportsVerboseModelsCommandFailure(stdout: string, stderr: string): boolean {
  const combined = `${stdout}\n${stderr}`.toLowerCase();
  return (
    combined.includes("unknown argument: verbose") || combined.includes("unknown option: verbose")
  );
}

export function openCodeQuestionId(
  index: number,
  question: QuestionRequest["questions"][number],
): string {
  const header = question.header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-");
  return header.length > 0 ? `question-${index}-${header}` : `question-${index}`;
}

export function toOpenCodeFileParts(input: {
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined;
  readonly resolveAttachmentPath: (attachment: ChatAttachment) => string | null;
}): Array<FilePartInput> {
  const parts: Array<FilePartInput> = [];

  for (const attachment of input.attachments ?? []) {
    if (attachment.type !== "image") {
      continue;
    }

    const attachmentPath = input.resolveAttachmentPath(attachment);
    if (!attachmentPath) {
      continue;
    }

    parts.push({
      type: "file",
      mime: attachment.mimeType,
      filename: attachment.name,
      url: pathToFileURL(attachmentPath).href,
    });
  }

  return parts;
}

export function buildOpenCodePermissionRules(runtimeMode: RuntimeMode): PermissionRuleset {
  if (runtimeMode === "full-access") {
    return [{ permission: "*", pattern: "*", action: "allow" }];
  }

  return [
    { permission: "*", pattern: "*", action: "ask" },
    { permission: "bash", pattern: "*", action: "ask" },
    { permission: "edit", pattern: "*", action: "ask" },
    { permission: "webfetch", pattern: "*", action: "ask" },
    { permission: "websearch", pattern: "*", action: "ask" },
    { permission: "codesearch", pattern: "*", action: "ask" },
    { permission: "external_directory", pattern: "*", action: "ask" },
    { permission: "doom_loop", pattern: "*", action: "ask" },
    { permission: "question", pattern: "*", action: "allow" },
  ];
}

export function toOpenCodePermissionReply(
  decision: ProviderApprovalDecision,
): "once" | "always" | "reject" {
  switch (decision) {
    case "accept":
      return "once";
    case "acceptForSession":
      return "always";
    case "decline":
    case "cancel":
    default:
      return "reject";
  }
}

export function toOpenCodeQuestionAnswers(
  request: QuestionRequest,
  answers: Record<string, unknown>,
): Array<QuestionAnswer> {
  return request.questions.map((question, index) => {
    const raw =
      answers[openCodeQuestionId(index, question)] ??
      answers[question.header] ??
      answers[question.question];
    if (Array.isArray(raw)) {
      return raw.filter((value): value is string => typeof value === "string");
    }
    if (typeof raw === "string") {
      return raw.trim().length > 0 ? [raw] : [];
    }
    return [];
  });
}

function ensureRuntimeError(
  operation: OpenCodeRuntimeError["operation"],
  detail: string,
  cause: unknown,
): OpenCodeRuntimeError {
  return OpenCodeRuntimeError.is(cause)
    ? cause
    : new OpenCodeRuntimeError({ operation, detail, cause });
}

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  Stream.runFold(
    stream,
    () => "",
    (acc, chunk) => acc + new TextDecoder().decode(chunk),
  );

const makeOpenCodeRuntime = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const netService = yield* NetService;

  const runOpenCodeCommand: OpenCodeRuntimeShape["runOpenCodeCommand"] = (input) =>
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(input.binaryPath, [...input.args], {
          shell: process.platform === "win32",
          env: process.env,
        }),
      );
      const [stdout, stderr, code] = yield* Effect.all(
        [collectStreamAsString(child.stdout), collectStreamAsString(child.stderr), child.exitCode],
        { concurrency: "unbounded" },
      );
      const exitCode = Number(code);
      if (isWindowsShellCommandMissingResult({ code: exitCode, stderr })) {
        return yield* new OpenCodeRuntimeError({
          operation: "runOpenCodeCommand",
          detail: `spawn ${input.binaryPath} ENOENT`,
        });
      }
      return {
        stdout,
        stderr,
        code: exitCode,
      } satisfies OpenCodeCommandResult;
    }).pipe(
      Effect.scoped,
      Effect.mapError((cause) =>
        ensureRuntimeError(
          "runOpenCodeCommand",
          `Failed to execute '${input.binaryPath} ${input.args.join(" ")}': ${openCodeRuntimeErrorDetail(cause)}`,
          cause,
        ),
      ),
    );

  const startOpenCodeServerProcess: OpenCodeRuntimeShape["startOpenCodeServerProcess"] = (input) =>
    Effect.gen(function* () {
      const runtimeScope = yield* Scope.Scope;

      const hostname = input.hostname ?? DEFAULT_HOSTNAME;
      const port =
        input.port ??
        (yield* netService.findAvailablePort(0).pipe(
          Effect.mapError(
            (cause) =>
              new OpenCodeRuntimeError({
                operation: "startOpenCodeServerProcess",
                detail: `Failed to find available port: ${openCodeRuntimeErrorDetail(cause)}`,
                cause,
              }),
          ),
        ));
      const timeoutMs = input.timeoutMs ?? DEFAULT_OPENCODE_SERVER_TIMEOUT_MS;
      const args = ["serve", `--hostname=${hostname}`, `--port=${port}`];

      const child = yield* spawner
        .spawn(
          ChildProcess.make(input.binaryPath, args, {
            env: {
              ...process.env,
              OPENCODE_CONFIG_CONTENT: JSON.stringify({}),
            },
          }),
        )
        .pipe(
          Effect.provideService(Scope.Scope, runtimeScope),
          Effect.mapError(
            (cause) =>
              new OpenCodeRuntimeError({
                operation: "startOpenCodeServerProcess",
                detail: `Failed to spawn OpenCode server process: ${openCodeRuntimeErrorDetail(cause)}`,
                cause,
              }),
          ),
        );

      const stdoutRef = yield* Ref.make("");
      const stderrRef = yield* Ref.make("");
      const readyDeferred = yield* Deferred.make<string, OpenCodeRuntimeError>();

      const setReadyFromStdoutChunk = (chunk: string) =>
        Ref.updateAndGet(stdoutRef, (stdout) => `${stdout}${chunk}`).pipe(
          Effect.flatMap((nextStdout) => {
            const parsed = parseServerUrlFromOutput(nextStdout);
            return parsed
              ? Deferred.succeed(readyDeferred, parsed).pipe(Effect.ignore)
              : Effect.void;
          }),
        );

      const stdoutFiber = yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.runForEach(setReadyFromStdoutChunk),
        Effect.ignore,
        Effect.forkIn(runtimeScope),
      );
      const stderrFiber = yield* child.stderr.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) => Ref.update(stderrRef, (stderr) => `${stderr}${chunk}`)),
        Effect.ignore,
        Effect.forkIn(runtimeScope),
      );

      const exitFiber = yield* child.exitCode.pipe(
        Effect.flatMap((code) =>
          Effect.gen(function* () {
            const stdout = yield* Ref.get(stdoutRef);
            const stderr = yield* Ref.get(stderrRef);
            const exitCode = Number(code);
            yield* Deferred.fail(
              readyDeferred,
              new OpenCodeRuntimeError({
                operation: "startOpenCodeServerProcess",
                detail: [
                  `OpenCode server exited before startup completed (code: ${String(exitCode)}).`,
                  stdout.trim() ? `stdout:\n${stdout.trim()}` : null,
                  stderr.trim() ? `stderr:\n${stderr.trim()}` : null,
                ]
                  .filter(Boolean)
                  .join("\n\n"),
                cause: { exitCode, stdout, stderr },
              }),
            ).pipe(Effect.ignore);
          }),
        ),
        Effect.ignore,
        Effect.forkIn(runtimeScope),
      );

      const readyExit = yield* Effect.exit(
        Deferred.await(readyDeferred).pipe(Effect.timeoutOption(timeoutMs)),
      );

      yield* Fiber.interrupt(stdoutFiber).pipe(Effect.ignore);
      yield* Fiber.interrupt(stderrFiber).pipe(Effect.ignore);

      if (Exit.isFailure(readyExit)) {
        yield* Fiber.interrupt(exitFiber).pipe(Effect.ignore);
        const squashed = Cause.squash(readyExit.cause);
        return yield* ensureRuntimeError(
          "startOpenCodeServerProcess",
          `Failed while waiting for OpenCode server startup: ${openCodeRuntimeErrorDetail(squashed)}`,
          squashed,
        );
      }

      const readyOption = readyExit.value;
      if (Option.isNone(readyOption)) {
        yield* Fiber.interrupt(exitFiber).pipe(Effect.ignore);
        return yield* new OpenCodeRuntimeError({
          operation: "startOpenCodeServerProcess",
          detail: `Timed out waiting for OpenCode server start after ${timeoutMs}ms.`,
        });
      }

      return {
        url: readyOption.value,
        exitCode: child.exitCode.pipe(
          Effect.map(Number),
          Effect.orElseSucceed(() => 0),
        ),
      } satisfies OpenCodeServerProcess;
    });

  const connectToOpenCodeServer: OpenCodeRuntimeShape["connectToOpenCodeServer"] = (input) => {
    const serverUrl = input.serverUrl?.trim();
    if (serverUrl) {
      return Effect.succeed({
        url: serverUrl,
        exitCode: null,
        external: true,
      });
    }

    return startOpenCodeServerProcess({
      binaryPath: input.binaryPath,
      ...(input.port !== undefined ? { port: input.port } : {}),
      ...(input.hostname !== undefined ? { hostname: input.hostname } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    }).pipe(
      Effect.map((server) => ({
        url: server.url,
        exitCode: server.exitCode,
        external: false,
      })),
    );
  };

  const createOpenCodeSdkClient: OpenCodeRuntimeShape["createOpenCodeSdkClient"] = (input) =>
    createOpencodeClient({
      baseUrl: input.baseUrl,
      directory: input.directory,
      ...(input.serverPassword
        ? {
            headers: {
              Authorization: `Basic ${Buffer.from(`opencode:${input.serverPassword}`, "utf8").toString("base64")}`,
            },
          }
        : {}),
      throwOnError: true,
    });

  const loadProviders = (client: OpencodeClient) =>
    runOpenCodeSdk("provider.list", () => client.provider.list()).pipe(
      Effect.filterMapOrFail(
        (list) =>
          list.data
            ? Result.succeed(list.data)
            : Result.fail(
                new OpenCodeRuntimeError({
                  operation: "provider.list",
                  detail: "OpenCode provider list was empty.",
                }),
              ),
        (result) => result,
      ),
    );

  const loadAgents = (client: OpencodeClient) =>
    runOpenCodeSdk("app.agents", () => client.app.agents()).pipe(
      Effect.map((result) => result.data ?? []),
    );

  const loadConsoleState = (client: OpencodeClient) =>
    runOpenCodeSdk("experimental.console.get", () => client.experimental.console.get()).pipe(
      Effect.map((result) => result.data ?? null),
      // Console metadata is optional and should not block model discovery.
      Effect.catch(() => Effect.succeed(null)),
    );

  const loadOpenCodeInventory: OpenCodeRuntimeShape["loadOpenCodeInventory"] = (client) =>
    Effect.all([loadProviders(client), loadAgents(client), loadConsoleState(client)], {
      concurrency: "unbounded",
    }).pipe(
      Effect.map(([providerList, agents, consoleState]) => ({
        providerList,
        agents,
        consoleState,
      })),
    );

  const loadOpenCodePaths = (client: OpencodeClient) =>
    runOpenCodeSdk("path.get", () => client.path.get()).pipe(
      Effect.filterMapOrFail(
        (response) =>
          response.data
            ? Result.succeed(response.data as OpenCodePathInfo)
            : Result.fail(
                new OpenCodeRuntimeError({
                  operation: "path.get",
                  detail: "OpenCode path.get returned no path payload.",
                }),
              ),
        (result) => result,
      ),
    );

  const listOpenCodeCliModelsFromArgs = (input: {
    readonly binaryPath: string;
    readonly args: ReadonlyArray<string>;
  }) =>
    runOpenCodeCommand({
      binaryPath: input.binaryPath,
      args: input.args,
    }).pipe(
      Effect.flatMap((result) =>
        result.code === 0
          ? Effect.succeed(parseOpenCodeCliModelsOutput(result.stdout))
          : Effect.fail(
              toListModelsCommandError({
                binaryPath: input.binaryPath,
                args: input.args,
                stdout: result.stdout,
                stderr: result.stderr,
                code: result.code,
              }),
            ),
      ),
    );

  const listOpenCodeCliModels: OpenCodeRuntimeShape["listOpenCodeCliModels"] = (input) =>
    listOpenCodeCliModelsFromArgs({
      binaryPath: input.binaryPath,
      args: ["models", "--verbose"],
    }).pipe(
      Effect.catch((error) => {
        if (!OpenCodeRuntimeError.is(error)) {
          return Effect.fail(error);
        }

        const cause = error.cause as
          | {
              readonly stdout?: string;
              readonly stderr?: string;
            }
          | undefined;
        if (
          !supportsVerboseModelsCommandFailure(cause?.stdout ?? "", cause?.stderr ?? "") &&
          !supportsVerboseModelsCommandFailure("", error.detail)
        ) {
          return Effect.fail(error);
        }

        return listOpenCodeCliModelsFromArgs({
          binaryPath: input.binaryPath,
          args: ["models"],
        });
      }),
    );

  const loadOpenCodeCredentialProviderIDs: OpenCodeRuntimeShape["loadOpenCodeCredentialProviderIDs"] =
    (client) =>
      loadOpenCodePaths(client).pipe(
        Effect.flatMap((pathInfo) =>
          Effect.tryPromise({
            try: () => readFile(resolveOpenCodeAuthFilePath(pathInfo), "utf8"),
            catch: (cause) =>
              new OpenCodeRuntimeError({
                operation: "readOpenCodeCredentialProviderIDs",
                detail: openCodeRuntimeErrorDetail(cause),
                cause,
              }),
          }),
        ),
        Effect.flatMap((content) =>
          Effect.try({
            try: () => parseOpenCodeCredentialProviderIDs(content),
            catch: (cause) =>
              new OpenCodeRuntimeError({
                operation: "parseOpenCodeCredentialProviderIDs",
                detail: openCodeRuntimeErrorDetail(cause),
                cause,
              }),
          }),
        ),
        // Explicit credential metadata is optional. Discovery should still work when
        // the auth file does not exist, is unreadable, or belongs to another machine.
        Effect.catch(() => Effect.succeed([])),
      );

  return {
    startOpenCodeServerProcess,
    connectToOpenCodeServer,
    runOpenCodeCommand,
    createOpenCodeSdkClient,
    loadOpenCodeInventory,
    listOpenCodeCliModels,
    loadOpenCodeCredentialProviderIDs,
  } satisfies OpenCodeRuntimeShape;
});

export class OpenCodeRuntime extends ServiceMap.Service<OpenCodeRuntime, OpenCodeRuntimeShape>()(
  "t3/provider/opencodeRuntime",
) {}

export const OpenCodeRuntimeLive = Layer.effect(OpenCodeRuntime, makeOpenCodeRuntime).pipe(
  Layer.provide(NetService.layer),
);
