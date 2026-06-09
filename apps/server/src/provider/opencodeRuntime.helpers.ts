/**
 * Purpose: Pure parsers, types, constants, and error helpers for the OpenCode/Kilo runtime.
 * Layer: provider — no Effect service wiring; consumed by opencodeRuntime.ts and OpenCode adapters.
 * Exports: CLI specs, model-slug/CLI-output/credential parsers, permission + attachment mappers,
 *   OpenCodeRuntimeError, runOpenCodeSdk, and shared runtime type/interface shapes.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { ChatAttachment, ProviderApprovalDecision, RuntimeMode } from "@t3tools/contracts";
import type {
  ConsoleState,
  Agent,
  FilePartInput,
  OpencodeClient,
  PermissionRuleset,
  ProviderListResponse,
  QuestionAnswer,
  QuestionRequest,
} from "@opencode-ai/sdk/v2";
import { Data, Effect, Predicate as P, Stream } from "effect";

export const DEFAULT_OPENCODE_SERVER_TIMEOUT_MS = 5_000;
export const DEFAULT_HOSTNAME = "127.0.0.1";

export interface OpenCodeCompatibleCliSpec {
  readonly defaultBinaryPath: string;
  readonly displayName: string;
  readonly serverReadyPrefix: string;
  readonly configContentEnvVar: string;
  readonly dataDirectoryName: string;
  readonly serverAuthUsername: string;
}

export const OPENCODE_CLI_SPEC: OpenCodeCompatibleCliSpec = {
  defaultBinaryPath: "opencode",
  displayName: "OpenCode",
  serverReadyPrefix: "opencode server listening",
  configContentEnvVar: "OPENCODE_CONFIG_CONTENT",
  dataDirectoryName: "opencode",
  serverAuthUsername: "opencode",
};

export const KILO_CLI_SPEC: OpenCodeCompatibleCliSpec = {
  defaultBinaryPath: "kilo",
  displayName: "Kilo",
  serverReadyPrefix: "kilo server listening",
  configContentEnvVar: "KILO_CONFIG_CONTENT",
  dataDirectoryName: "kilo",
  serverAuthUsername: "kilo",
};

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
    } catch {}
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
  readonly contextWindowOptions?: ReadonlyArray<{
    readonly value: string;
    readonly label: string;
    readonly isDefault?: true;
  }>;
  readonly defaultContextWindow?: string;
  readonly isFree?: boolean;
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
    readonly cliSpec?: OpenCodeCompatibleCliSpec;
    readonly port?: number;
    readonly hostname?: string;
    readonly timeoutMs?: number;
  }) => Effect.Effect<OpenCodeServerProcess, OpenCodeRuntimeError, Scope.Scope>;
  readonly connectToOpenCodeServer: (input: {
    readonly binaryPath: string;
    readonly cliSpec?: OpenCodeCompatibleCliSpec;
    readonly serverUrl?: string | null;
    readonly port?: number;
    readonly hostname?: string;
    readonly timeoutMs?: number;
  }) => Effect.Effect<OpenCodeServerConnection, OpenCodeRuntimeError, Scope.Scope>;
  readonly runOpenCodeCommand: (input: {
    readonly binaryPath: string;
    readonly cliSpec?: OpenCodeCompatibleCliSpec;
    readonly args: ReadonlyArray<string>;
  }) => Effect.Effect<OpenCodeCommandResult, OpenCodeRuntimeError>;
  readonly createOpenCodeSdkClient: (input: {
    readonly baseUrl: string;
    readonly directory: string;
    readonly cliSpec?: OpenCodeCompatibleCliSpec;
    readonly serverPassword?: string;
  }) => OpencodeClient;
  readonly loadOpenCodeInventory: (
    client: OpencodeClient,
  ) => Effect.Effect<OpenCodeInventory, OpenCodeRuntimeError>;
  readonly listOpenCodeCliModels: (input: {
    readonly binaryPath: string;
    readonly cliSpec?: OpenCodeCompatibleCliSpec;
  }) => Effect.Effect<ReadonlyArray<OpenCodeCliModelDescriptor>, OpenCodeRuntimeError>;
  readonly loadOpenCodeCredentialProviderIDs: (
    client: OpencodeClient,
    cliSpec?: OpenCodeCompatibleCliSpec,
  ) => Effect.Effect<ReadonlyArray<string>, never>;
}

export function parseServerUrlFromOutput(output: string, readyPrefix: string): string | null {
  for (const line of output.split("\n")) {
    if (!line.startsWith(readyPrefix)) {
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

function numberToContextWindowValue(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value >= 1_000_000 && value % 1_000_000 === 0) return `${value / 1_000_000}m`;
  if (value >= 1_000 && value % 1_000 === 0) return `${value / 1_000}k`;
  return String(value);
}

function contextWindowLabel(value: string): string {
  return value.toUpperCase();
}

function parseOpenCodeContextWindowOptions(object: Record<string, unknown>):
  | {
      readonly contextWindowOptions: ReadonlyArray<{
        readonly value: string;
        readonly label: string;
        readonly isDefault?: true;
      }>;
      readonly defaultContextWindow: string;
    }
  | undefined {
  const limit =
    object.limit && typeof object.limit === "object"
      ? (object.limit as Record<string, unknown>)
      : null;
  const context =
    typeof limit?.context === "number"
      ? numberToContextWindowValue(limit.context)
      : trimToNull(limit?.context);
  if (!context) return undefined;
  return {
    contextWindowOptions: [{ value: context, label: contextWindowLabel(context), isDefault: true }],
    defaultContextWindow: context,
  };
}

function readOpenCodeVariantEffort(
  variantKey: string,
  variantObject: Record<string, unknown>,
): string | null {
  const directEffort =
    trimToNull(variantObject.reasoningEffort) ??
    trimToNull(variantObject.reasoning_effort) ??
    trimToNull(variantObject.effort);
  if (directEffort) {
    return directEffort;
  }

  const thinkingConfig =
    variantObject.thinkingConfig &&
    typeof variantObject.thinkingConfig === "object" &&
    !Array.isArray(variantObject.thinkingConfig)
      ? (variantObject.thinkingConfig as Record<string, unknown>)
      : variantObject.thinking_config &&
          typeof variantObject.thinking_config === "object" &&
          !Array.isArray(variantObject.thinking_config)
        ? (variantObject.thinking_config as Record<string, unknown>)
        : null;
  const thinkingLevel =
    trimToNull(thinkingConfig?.thinkingLevel) ?? trimToNull(thinkingConfig?.thinking_level);
  if (thinkingLevel) {
    return thinkingLevel;
  }

  const reasoning =
    variantObject.reasoning &&
    typeof variantObject.reasoning === "object" &&
    !Array.isArray(variantObject.reasoning)
      ? (variantObject.reasoning as Record<string, unknown>)
      : null;
  const reasoningConfig =
    variantObject.reasoningConfig &&
    typeof variantObject.reasoningConfig === "object" &&
    !Array.isArray(variantObject.reasoningConfig)
      ? (variantObject.reasoningConfig as Record<string, unknown>)
      : variantObject.reasoning_config &&
          typeof variantObject.reasoning_config === "object" &&
          !Array.isArray(variantObject.reasoning_config)
        ? (variantObject.reasoning_config as Record<string, unknown>)
        : null;
  const nestedReasoningEffort =
    trimToNull(reasoning?.effort) ??
    trimToNull(reasoningConfig?.maxReasoningEffort) ??
    trimToNull(reasoningConfig?.max_reasoning_effort);
  if (nestedReasoningEffort) {
    return nestedReasoningEffort;
  }

  if (
    "thinking" in variantObject ||
    "thinkingConfig" in variantObject ||
    "thinking_config" in variantObject ||
    "reasoning" in variantObject ||
    "reasoningConfig" in variantObject ||
    "reasoning_config" in variantObject ||
    Object.keys(variantObject).length === 0
  ) {
    return trimToNull(variantKey);
  }
  return null;
}

function resolveOpenCodeDataDirectory(
  homeDirectory: string,
  dataDirectoryName = "opencode",
): string {
  if (process.platform === "win32") {
    const appDataDirectory =
      trimToNull(process.env.APPDATA) ?? join(homeDirectory, "AppData", "Roaming");
    return join(appDataDirectory, dataDirectoryName);
  }

  const xdgDataHome =
    trimToNull(process.env.XDG_DATA_HOME) ?? join(homeDirectory, ".local", "share");
  return join(xdgDataHome, dataDirectoryName);
}

export function resolveOpenCodeAuthFilePath(
  pathInfo: Pick<OpenCodePathInfo, "home">,
  cliSpec: OpenCodeCompatibleCliSpec = OPENCODE_CLI_SPEC,
): string {
  return join(resolveOpenCodeDataDirectory(pathInfo.home, cliSpec.dataDirectoryName), "auth.json");
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
      Object.entries(variantsObject).flatMap(([variantKey, variant]) => {
        const variantObject =
          variant && typeof variant === "object" && !Array.isArray(variant)
            ? (variant as Record<string, unknown>)
            : null;
        if (!variantObject) {
          return [];
        }

        const reasoningValue = readOpenCodeVariantEffort(variantKey, variantObject);
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
        trimToNull((object.options as Record<string, unknown>).reasoning_effort) ??
        trimToNull((object.options as Record<string, unknown>).effort))
      : null) ??
    undefined;
  const contextWindowOptions = parseOpenCodeContextWindowOptions(object);
  const isFree = object.isFree;

  return {
    slug,
    providerID,
    modelID,
    name,
    variants,
    supportedReasoningEfforts,
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    ...(contextWindowOptions ?? {}),
    ...(typeof isFree === "boolean" ? { isFree } : {}),
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
        } catch {}
        index = block.nextIndex;
      }
    }

    models.set(descriptor.slug, descriptor);
  }

  return [...models.values()].toSorted(
    (left, right) => left.name.localeCompare(right.name) || left.slug.localeCompare(right.slug),
  );
}

export function toListModelsCommandError(input: {
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

export function supportsVerboseModelsCommandFailure(stdout: string, stderr: string): boolean {
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

export function ensureRuntimeError(
  operation: OpenCodeRuntimeError["operation"],
  detail: string,
  cause: unknown,
): OpenCodeRuntimeError {
  return OpenCodeRuntimeError.is(cause)
    ? cause
    : new OpenCodeRuntimeError({ operation, detail, cause });
}

export const collectStreamAsString = <E>(
  stream: Stream.Stream<Uint8Array, E>,
): Effect.Effect<string, E> =>
  Stream.runFold(
    stream,
    () => "",
    (acc, chunk) => acc + new TextDecoder().decode(chunk),
  );
