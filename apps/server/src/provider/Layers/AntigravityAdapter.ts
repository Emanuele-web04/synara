import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  type AntigravityModelOptions,
  EventId,
  type ProviderComposerCapabilities,
  type ProviderListModelsResult,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeItemId,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import { Effect, Layer, Queue, Stream } from "effect";

import { ServerConfig } from "../../config.ts";
import { buildProviderChildEnvironment } from "../../providerChildEnvironment.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import {
  AntigravityAdapter,
  type AntigravityAdapterShape,
} from "../Services/AntigravityAdapter.ts";
import type { ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import { appendFileAttachmentsPromptBlock } from "../attachmentProjection.ts";
import { teardownChildProcessTree } from "../supervisedProcessTeardown.ts";

const PROVIDER = "antigravity" as const;
const DEFAULT_MODEL = "Gemini 3.5 Flash";
const PRINT_TIMEOUT = "30m";
const POLL_INTERVAL_MS = 75;
const MODEL_DISCOVERY_TIMEOUT_MS = 15_000;
const PLUGIN_INSTALL_TIMEOUT_MS = 30_000;
const HELPER_OUTPUT_MAX_CHARS = 128 * 1024;
const WINDOWS_PROMPT_MAX_CHARS = 24_000;

type TranscriptStep = {
  readonly step_index?: number;
  readonly source?: string;
  readonly type?: string;
  readonly status?: string;
  readonly content?: string;
  readonly tool_calls?: ReadonlyArray<{
    readonly name?: string;
    readonly args?: Record<string, unknown>;
  }> | null;
  readonly [key: string]: unknown;
};

type PendingTool = {
  readonly itemId: RuntimeItemId;
  readonly itemType: "command_execution" | "file_change" | "dynamic_tool_call" | "web_search";
  readonly name: string;
  readonly args: unknown;
};

type StoredTurn = {
  readonly id: TurnId;
  readonly items: unknown[];
};

type AntigravitySessionContext = {
  session: ProviderSession;
  readonly lifecycleGeneration?: string;
  readonly binaryPath: string;
  readonly turns: StoredTurn[];
  activeTurnId?: TurnId | undefined;
  activeProcess?: ChildProcess | undefined;
  activePrompt?: string | undefined;
  eventFile?: string | undefined;
  transcriptPath?: string | undefined;
  conversationId?: string | undefined;
  modelName?: string | undefined;
  modelOptions?: AntigravityModelOptions | undefined;
  processedHookBytes: number;
  processedTranscriptBytes: number;
  processedTranscriptPath?: string | undefined;
  processedSteps: Set<number>;
  pendingTools: PendingTool[];
  sawAssistant: boolean;
  interrupted: boolean;
  stopped: boolean;
};

function messageFromCause(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim() ? cause.message : fallback;
}

function trim(value: string | null | undefined): string | undefined {
  const result = value?.trim();
  return result ? result : undefined;
}

function resumeConversationId(value: unknown): string | undefined {
  if (typeof value === "string") return trim(value);
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["conversationId", "providerThreadId", "id"]) {
    if (typeof record[key] === "string" && record[key].trim()) return record[key].trim();
  }
  return undefined;
}

function transcriptPathForConversation(conversationId: string): string {
  return path.join(
    os.homedir(),
    ".gemini",
    "antigravity-cli",
    "brain",
    conversationId,
    ".system_generated",
    "logs",
    "transcript.jsonl",
  );
}

function shellQuote(value: string): string {
  if (process.platform === "win32") return `"${value.replaceAll('"', '\\"')}"`;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function hookScriptSource(): string {
  return `const fs = require("node:fs");
const event = process.argv[2] || "unknown";
let payload = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { payload += chunk; });
process.stdin.on("end", () => {
  const target = process.env.SYNARA_ANTIGRAVITY_EVENTS;
  if (!target) {
    process.stdout.write("{}\\n");
    return;
  }
  fs.appendFileSync(target, event + "\\t" + payload.trim() + "\\n");
  if (event === "pre-tool") {
    const decision = process.env.SYNARA_ANTIGRAVITY_HOOK_DECISION === "allow" ? "allow" : "ask";
    process.stdout.write(JSON.stringify({ decision }) + "\\n");
  } else if (event === "stop") {
    process.stdout.write('{"decision":"stop"}\\n');
  } else {
    process.stdout.write("{}\\n");
  }
});
`;
}

export function buildAntigravityHookConfig(
  command: (event: string) => string,
): Record<string, unknown> {
  const hook = (event: string) => ({ type: "command", command: command(event) });
  return {
    "synara-capture": {
      PreToolUse: [{ matcher: "*", hooks: [hook("pre-tool")] }],
      PostToolUse: [{ matcher: "*", hooks: [hook("post-tool")] }],
      PreInvocation: [hook("pre-invocation")],
      PostInvocation: [hook("post-invocation")],
      Stop: [hook("stop")],
    },
  };
}

function appendBoundedOutput(current: string, chunk: unknown): string {
  const next = current + String(chunk);
  return next.length > HELPER_OUTPUT_MAX_CHARS ? next.slice(-HELPER_OUTPUT_MAX_CHARS) : next;
}

export async function runAntigravityHelperProcess(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<{
  stdout: string;
  stderr: string;
  code: number;
}> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: buildProviderChildEnvironment({ provider: PROVIDER }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeoutMs = options.timeoutMs ?? MODEL_DISCOVERY_TIMEOUT_MS;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() =>
        reject(
          new Error(
            `Antigravity helper timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}`,
          ),
        ),
      );
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout = appendBoundedOutput(stdout, chunk)));
    child.stderr.on("data", (chunk) => (stderr = appendBoundedOutput(stderr, chunk)));
    child.once("error", (cause) => finish(() => reject(cause)));
    child.once("close", (code) => finish(() => resolve({ stdout, stderr, code: code ?? 1 })));
  });
}

export async function readCompleteAntigravityLines(
  filePath: string,
  offset: number,
): Promise<{ lines: string[]; nextOffset: number }> {
  const file = await fs.open(filePath, "r");
  try {
    const stats = await file.stat();
    const start = offset <= stats.size ? offset : 0;
    const remaining = stats.size - start;
    if (remaining === 0) return { lines: [], nextOffset: start };
    const buffer = Buffer.allocUnsafe(remaining);
    const { bytesRead } = await file.read(buffer, 0, remaining, start);
    const contents = buffer.subarray(0, bytesRead);
    const lastNewline = contents.lastIndexOf(0x0a);
    if (lastNewline < 0) return { lines: [], nextOffset: start };
    return {
      lines: contents
        .subarray(0, lastNewline + 1)
        .toString("utf8")
        .split(/\r?\n/g)
        .filter(Boolean),
      nextOffset: start + lastNewline + 1,
    };
  } finally {
    await file.close();
  }
}

async function ensureCapturePlugin(binaryPath: string): Promise<void> {
  const pluginDir = path.join(
    os.homedir(),
    ".gemini",
    "antigravity-cli",
    "plugins",
    "synara-capture",
  );
  const scriptPath = path.join(pluginDir, "capture.cjs");
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "plugin.json"),
    `${JSON.stringify(
      {
        $schema: "https://antigravity.google/schemas/v1/plugin.json",
        name: "synara-capture",
        description: "Streams Antigravity CLI lifecycle events to Synara when requested.",
      },
      null,
      2,
    )}\n`,
  );
  await fs.writeFile(scriptPath, hookScriptSource(), { mode: 0o700 });
  const command = (event: string) =>
    `${shellQuote(process.execPath)} ${shellQuote(scriptPath)} ${shellQuote(event)}`;
  await fs.writeFile(
    path.join(pluginDir, "hooks.json"),
    `${JSON.stringify(buildAntigravityHookConfig(command), null, 2)}\n`,
  );
  const installed = await runAntigravityHelperProcess(
    binaryPath,
    ["plugin", "install", pluginDir],
    { timeoutMs: PLUGIN_INSTALL_TIMEOUT_MS },
  );
  if (installed.code !== 0) {
    throw new Error(installed.stderr.trim() || installed.stdout.trim() || "Plugin install failed.");
  }
}

const DEFAULT_EFFORT_BY_MODEL: Readonly<Record<string, string>> = {
  "Gemini 3.5 Flash": "medium",
  "Gemini 3.1 Pro": "low",
  "Claude Sonnet 4.6": "thinking",
  "Claude Opus 4.6": "thinking",
  "GPT-OSS 120B": "medium",
};

const EFFORT_ORDER = ["low", "medium", "high", "thinking"] as const;

function effortLabel(value: string): string {
  return value
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

export function parseAntigravityCliModelLabel(
  value: string,
): { model: string; effort?: string } | null {
  const trimmed = value
    .replace(/\x1b\[[0-9;]*m/g, "")
    .trim()
    .replace(/^(?:[*•-]\s+)+/u, "");
  if (!trimmed) return null;
  const match = trimmed.match(/^(.*?)\s+\(([^()]+)\)$/u);
  if (!match?.[1] || !match[2]) return { model: trimmed };
  return {
    model: match[1].trim(),
    effort: match[2].trim().toLowerCase(),
  };
}

export function antigravityPromptCommandLineIssue(
  prompt: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform !== "win32" || prompt.length <= WINDOWS_PROMPT_MAX_CHARS) {
    return null;
  }
  return `Antigravity prompts on Windows are limited to ${WINDOWS_PROMPT_MAX_CHARS.toLocaleString("en-US")} characters because the CLI accepts print-mode prompts as command-line arguments. Shorten the prompt or attach the content as files.`;
}

export function parseAntigravityModelLines(output: string): ProviderListModelsResult["models"] {
  const groups = new Map<string, string[]>();
  for (const line of output.split(/\r?\n/g)) {
    const parsed = parseAntigravityCliModelLabel(line);
    if (!parsed) continue;
    const efforts = groups.get(parsed.model) ?? [];
    if (parsed.effort && !efforts.includes(parsed.effort)) efforts.push(parsed.effort);
    groups.set(parsed.model, efforts);
  }
  return [...groups.entries()].map(([model, discoveredEfforts]) => {
    const efforts = discoveredEfforts.toSorted((left, right) => {
      const leftIndex = EFFORT_ORDER.indexOf(left as (typeof EFFORT_ORDER)[number]);
      const rightIndex = EFFORT_ORDER.indexOf(right as (typeof EFFORT_ORDER)[number]);
      return (
        (leftIndex < 0 ? EFFORT_ORDER.length : leftIndex) -
        (rightIndex < 0 ? EFFORT_ORDER.length : rightIndex)
      );
    });
    const defaultEffort = DEFAULT_EFFORT_BY_MODEL[model] ?? efforts[0];
    return {
      slug: model,
      name: model,
      ...(efforts.length > 0
        ? {
            supportedReasoningEfforts: efforts.map((effort) => ({
              value: effort,
              label: effortLabel(effort),
            })),
            ...(defaultEffort ? { defaultReasoningEffort: defaultEffort } : {}),
          }
        : {}),
    };
  });
}

export function resolveAntigravityCliModelLabel(
  model: string,
  options?: AntigravityModelOptions,
  discoveredDefaultEffort?: string,
): string {
  const parsed = parseAntigravityCliModelLabel(model);
  if (!parsed) return model;
  if (parsed.effort) return model.trim();
  const effort =
    options?.reasoningEffort?.trim().toLowerCase() ??
    discoveredDefaultEffort?.trim().toLowerCase() ??
    DEFAULT_EFFORT_BY_MODEL[parsed.model];
  return effort ? `${parsed.model} (${effortLabel(effort)})` : parsed.model;
}

function parseModelLines(output: string): ProviderListModelsResult["models"] {
  return parseAntigravityModelLines(output);
}

function toolItemType(name: string): PendingTool["itemType"] {
  if (name === "run_command") return "command_execution";
  if (
    name === "write_to_file" ||
    name === "replace_file_content" ||
    name === "multi_replace_file_content"
  ) {
    return "file_change";
  }
  if (name === "search_web" || name.startsWith("browser_")) return "web_search";
  return "dynamic_tool_call";
}

function resultStreamKind(itemType: PendingTool["itemType"]) {
  if (itemType === "command_execution") return "command_output" as const;
  if (itemType === "file_change") return "file_change_output" as const;
  return "unknown" as const;
}

function isToolResultStep(step: TranscriptStep): boolean {
  return (
    step.source === "MODEL" &&
    step.type !== "PLANNER_RESPONSE" &&
    step.type !== "CONVERSATION_HISTORY" &&
    step.type !== "CHECKPOINT"
  );
}

export function makeAntigravityRuntimeEventBase(input: {
  readonly threadId: ThreadId;
  readonly lifecycleGeneration?: string;
  readonly eventId?: EventId;
  readonly createdAt?: string;
}) {
  return {
    eventId: input.eventId ?? EventId.makeUnsafe(crypto.randomUUID()),
    provider: PROVIDER,
    threadId: input.threadId,
    createdAt: input.createdAt ?? new Date().toISOString(),
    ...(input.lifecycleGeneration !== undefined
      ? { lifecycleGeneration: input.lifecycleGeneration }
      : {}),
  };
}

const makeAntigravityAdapter = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig;
  const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, AntigravitySessionContext>();
  const defaultEffortByModel = new Map(Object.entries(DEFAULT_EFFORT_BY_MODEL));

  const offer = (event: ProviderRuntimeEvent) => {
    Effect.runPromise(Queue.offer(events, event)).catch(() => undefined);
  };

  const base = (
    context: AntigravitySessionContext,
    options?: { includeTurn?: boolean; itemId?: RuntimeItemId },
  ) => ({
    ...makeAntigravityRuntimeEventBase({
      threadId: context.session.threadId,
      ...(context.lifecycleGeneration !== undefined
        ? { lifecycleGeneration: context.lifecycleGeneration }
        : {}),
    }),
    ...(options?.includeTurn !== false && context.activeTurnId
      ? { turnId: context.activeTurnId }
      : {}),
    ...(options?.itemId ? { itemId: options.itemId } : {}),
    ...(context.conversationId
      ? { providerRefs: { providerThreadId: context.conversationId } }
      : {}),
  });

  const raw = (messageType: string, payload: unknown) => ({
    source: "antigravity.cli.event" as const,
    messageType,
    payload,
  });

  const requireSession = (
    threadId: ThreadId,
  ): Effect.Effect<AntigravitySessionContext, ProviderAdapterSessionNotFoundError> => {
    const context = sessions.get(threadId);
    return context
      ? Effect.succeed(context)
      : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
  };

  const teardownActiveProcess = (
    context: AntigravitySessionContext,
    method: string,
  ): Effect.Effect<void, ProviderAdapterRequestError> => {
    const child = context.activeProcess;
    if (!child) return Effect.void;
    return Effect.tryPromise({
      try: () => teardownChildProcessTree(child),
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method,
          detail: messageFromCause(cause, "Failed to stop the Antigravity process tree."),
          cause,
        }),
    }).pipe(Effect.asVoid);
  };

  const currentTurn = (context: AntigravitySessionContext): StoredTurn | undefined =>
    context.activeTurnId
      ? context.turns.find((turn) => turn.id === context.activeTurnId)
      : undefined;

  const emitTextItem = (
    context: AntigravitySessionContext,
    step: TranscriptStep,
    itemType: "assistant_message" | "reasoning",
    streamKind: "assistant_text" | "reasoning_text",
  ) => {
    const content = trim(step.content);
    if (!content) return;
    const itemId = RuntimeItemId.makeUnsafe(
      `antigravity-${context.activeTurnId ?? "turn"}-${step.step_index ?? crypto.randomUUID()}-${itemType}`,
    );
    offer({
      ...base(context, { itemId }),
      type: "item.started",
      payload: {
        itemType,
        status: "inProgress",
        title: itemType === "reasoning" ? "Reasoning" : "Assistant",
      },
      raw: raw(step.type ?? "transcript", step),
    } satisfies ProviderRuntimeEvent);
    offer({
      ...base(context, { itemId }),
      type: "content.delta",
      payload: { streamKind, delta: content },
      raw: raw(step.type ?? "transcript", step),
    } satisfies ProviderRuntimeEvent);
    offer({
      ...base(context, { itemId }),
      type: "item.completed",
      payload: {
        itemType,
        status: "completed",
        title: itemType === "reasoning" ? "Reasoning" : "Assistant",
        ...(itemType === "reasoning" ? { detail: content } : {}),
        data: step,
      },
      raw: raw(step.type ?? "transcript", step),
    } satisfies ProviderRuntimeEvent);
    if (itemType === "assistant_message") context.sawAssistant = true;
  };

  const processTranscriptStep = (context: AntigravitySessionContext, step: TranscriptStep) => {
    const stepIndex = step.step_index;
    if (typeof stepIndex !== "number" || context.processedSteps.has(stepIndex)) return;
    context.processedSteps.add(stepIndex);
    currentTurn(context)?.items.push(step);

    if (step.type === "PLANNER_RESPONSE") {
      const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
      if (calls.length > 0) {
        emitTextItem(context, step, "reasoning", "reasoning_text");
        for (const [index, call] of calls.entries()) {
          const name = trim(call.name) ?? "tool";
          const itemId = RuntimeItemId.makeUnsafe(
            `antigravity-${context.activeTurnId ?? "turn"}-${stepIndex}-tool-${index}`,
          );
          const itemType = toolItemType(name);
          const pending = { itemId, itemType, name, args: call.args ?? {} } satisfies PendingTool;
          context.pendingTools.push(pending);
          offer({
            ...base(context, { itemId }),
            type: "item.started",
            payload: {
              itemType,
              status: "inProgress",
              title: name,
              data: { name, args: pending.args },
            },
            raw: raw("tool-call", call),
          } satisfies ProviderRuntimeEvent);
        }
      } else {
        emitTextItem(context, step, "assistant_message", "assistant_text");
      }
      return;
    }

    if (isToolResultStep(step)) {
      const pending = context.pendingTools.shift();
      if (!pending) return;
      const content = typeof step.content === "string" ? step.content : "";
      if (content) {
        offer({
          ...base(context, { itemId: pending.itemId }),
          type: "content.delta",
          payload: { streamKind: resultStreamKind(pending.itemType), delta: content },
          raw: raw(step.type ?? "tool-result", step),
        } satisfies ProviderRuntimeEvent);
      }
      offer({
        ...base(context, { itemId: pending.itemId }),
        type: "item.completed",
        payload: {
          itemType: pending.itemType,
          status: step.status === "ERROR" ? "failed" : "completed",
          title: pending.name,
          data: { name: pending.name, args: pending.args, result: step },
        },
        raw: raw(step.type ?? "tool-result", step),
      } satisfies ProviderRuntimeEvent);
    }
  };

  const readTranscript = async (context: AntigravitySessionContext) => {
    if (!context.transcriptPath) return;
    const isInitialRead = context.processedTranscriptPath !== context.transcriptPath;
    if (isInitialRead) context.processedTranscriptBytes = 0;
    let batch: Awaited<ReturnType<typeof readCompleteAntigravityLines>>;
    try {
      batch = await readCompleteAntigravityLines(
        context.transcriptPath,
        context.processedTranscriptBytes,
      );
    } catch {
      return;
    }
    context.processedTranscriptBytes = batch.nextOffset;
    context.processedTranscriptPath = context.transcriptPath;
    const steps = batch.lines.flatMap((line) => {
      try {
        return [JSON.parse(line) as TranscriptStep];
      } catch {
        return [];
      }
    });
    const latestUserIndex = isInitialRead
      ? steps.reduce(
          (latest, step) =>
            step.type === "USER_INPUT" && typeof step.step_index === "number"
              ? Math.max(latest, step.step_index)
              : latest,
          -1,
        )
      : -1;
    for (const step of steps) {
      if (typeof step.step_index === "number" && step.step_index > latestUserIndex) {
        processTranscriptStep(context, step);
      }
    }
  };

  const markExistingTranscriptStepsProcessed = async (context: AntigravitySessionContext) => {
    if (!context.transcriptPath) return;
    try {
      const batch = await readCompleteAntigravityLines(context.transcriptPath, 0);
      context.processedTranscriptBytes = batch.nextOffset;
      context.processedTranscriptPath = context.transcriptPath;
    } catch {
      return;
    }
  };

  const pollHookFile = async (context: AntigravitySessionContext) => {
    if (context.stopped) return;
    if (!context.eventFile) return;
    let batch: Awaited<ReturnType<typeof readCompleteAntigravityLines>>;
    try {
      batch = await readCompleteAntigravityLines(context.eventFile, context.processedHookBytes);
    } catch {
      return;
    }
    context.processedHookBytes = batch.nextOffset;
    for (const line of batch.lines) {
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      const eventName = line.slice(0, tab);
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(line.slice(tab + 1)) as Record<string, unknown>;
      } catch {
        continue;
      }
      const conversationId =
        typeof payload.conversationId === "string" ? payload.conversationId : undefined;
      const transcriptPath =
        typeof payload.transcriptPath === "string" ? payload.transcriptPath : undefined;
      const modelName = typeof payload.modelName === "string" ? payload.modelName : undefined;
      const learnedConversation = conversationId && conversationId !== context.conversationId;
      if (conversationId) context.conversationId = conversationId;
      if (transcriptPath && transcriptPath !== context.transcriptPath) {
        context.transcriptPath = transcriptPath;
        context.processedTranscriptBytes = 0;
        delete context.processedTranscriptPath;
      }
      if (modelName) context.modelName = modelName;
      if (learnedConversation) {
        context.session = {
          ...context.session,
          resumeCursor: conversationId,
          updatedAt: new Date().toISOString(),
        };
        offer({
          ...base(context, { includeTurn: false }),
          type: "thread.started",
          payload: { providerThreadId: conversationId },
          raw: raw(eventName, payload),
        } satisfies ProviderRuntimeEvent);
      }
    }
    await readTranscript(context);
  };

  const startSession: AntigravityAdapterShape["startSession"] = (input) =>
    Effect.gen(function* () {
      if (input.runtimeMode !== "full-access") {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "session/start",
          issue:
            "Antigravity CLI print mode cannot pause for interactive approvals. Select Full access to use this provider.",
        });
      }
      const binaryPath = trim(input.providerOptions?.antigravity?.binaryPath) ?? "agy";
      yield* Effect.tryPromise({
        try: () => ensureCapturePlugin(binaryPath),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "plugin/install",
            detail: messageFromCause(cause, "Failed to install the Synara capture hook."),
            cause,
          }),
      });
      const existing = sessions.get(input.threadId);
      if (existing) {
        existing.stopped = true;
        existing.interrupted = true;
        yield* teardownActiveProcess(existing, "session/restart");
      }
      const now = new Date().toISOString();
      const conversationId = resumeConversationId(input.resumeCursor);
      const modelSelection =
        input.modelSelection?.provider === PROVIDER ? input.modelSelection : undefined;
      const model = modelSelection?.model ?? DEFAULT_MODEL;
      const session: ProviderSession = {
        provider: PROVIDER,
        status: "ready",
        runtimeMode: input.runtimeMode,
        cwd: trim(input.cwd) ?? serverConfig.cwd,
        model,
        threadId: input.threadId,
        ...(conversationId ? { resumeCursor: conversationId } : {}),
        createdAt: now,
        updatedAt: now,
      };
      const context: AntigravitySessionContext = {
        session,
        ...(input.lifecycleGeneration !== undefined
          ? { lifecycleGeneration: input.lifecycleGeneration }
          : {}),
        binaryPath,
        turns: [],
        ...(conversationId ? { conversationId } : {}),
        ...(modelSelection?.options ? { modelOptions: modelSelection.options } : {}),
        ...(conversationId
          ? { transcriptPath: transcriptPathForConversation(conversationId) }
          : {}),
        processedHookBytes: 0,
        processedTranscriptBytes: 0,
        processedSteps: new Set(),
        pendingTools: [],
        sawAssistant: false,
        interrupted: false,
        stopped: false,
      };
      sessions.set(input.threadId, context);
      offer({
        ...base(context, { includeTurn: false }),
        type: "session.started",
        payload: {
          message: "Antigravity CLI session started",
          ...(conversationId ? { resume: conversationId } : {}),
        },
      } satisfies ProviderRuntimeEvent);
      offer({
        ...base(context, { includeTurn: false }),
        type: "thread.started",
        payload: { ...(conversationId ? { providerThreadId: conversationId } : {}) },
      } satisfies ProviderRuntimeEvent);
      return session;
    });

  const sendTurn: AntigravityAdapterShape["sendTurn"] = (input) =>
    Effect.gen(function* () {
      const context = yield* requireSession(input.threadId);
      if (context.activeProcess) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "turn/start",
          issue: "An Antigravity turn is already active for this thread.",
        });
      }
      const prompt = appendFileAttachmentsPromptBlock({
        text: input.input,
        attachments: input.attachments,
        attachmentsDir: serverConfig.attachmentsDir,
        include: "all-files",
      });
      const normalizedPrompt = trim(prompt);
      if (!normalizedPrompt) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "turn/start",
          issue: "A prompt or file attachment is required.",
        });
      }
      const promptIssue = antigravityPromptCommandLineIssue(normalizedPrompt);
      if (promptIssue) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "turn/start",
          issue: promptIssue,
        });
      }
      const turnId = TurnId.makeUnsafe(crypto.randomUUID());
      const modelSelection =
        input.modelSelection?.provider === PROVIDER ? input.modelSelection : undefined;
      const model = modelSelection?.model ?? context.session.model ?? DEFAULT_MODEL;
      const modelOptions = modelSelection?.options ?? context.modelOptions;
      const cliModel = resolveAntigravityCliModelLabel(
        model,
        modelOptions,
        defaultEffortByModel.get(model),
      );
      const runDir = yield* Effect.tryPromise({
        try: () => fs.mkdtemp(path.join(os.tmpdir(), "synara-antigravity-")),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "turn/prepare",
            detail: messageFromCause(cause, "Failed to prepare Antigravity turn files."),
            cause,
          }),
      });
      const eventFile = path.join(runDir, "hooks.ndjson");
      const logFile = path.join(runDir, "agy.log");
      yield* Effect.tryPromise({
        try: () => fs.writeFile(eventFile, ""),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "turn/prepare",
            detail: messageFromCause(cause, "Failed to create the Antigravity hook stream."),
            cause,
          }),
      });
      context.activeTurnId = turnId;
      context.activePrompt = normalizedPrompt;
      if (modelOptions) {
        context.modelOptions = modelOptions;
      } else {
        delete context.modelOptions;
      }
      context.eventFile = eventFile;
      context.processedHookBytes = 0;
      context.processedSteps.clear();
      yield* Effect.promise(() => markExistingTranscriptStepsProcessed(context));
      context.pendingTools = [];
      context.sawAssistant = false;
      context.interrupted = false;
      context.turns.push({ id: turnId, items: [] });
      context.session = {
        ...context.session,
        status: "running",
        model,
        activeTurnId: turnId,
        updatedAt: new Date().toISOString(),
      };
      offer({
        ...base(context),
        type: "turn.started",
        payload: { model },
      } satisfies ProviderRuntimeEvent);

      const conversationId = context.conversationId;
      const args: string[] = [
        ...(conversationId ? ["--conversation", conversationId] : ["--new-project"]),
        "--dangerously-skip-permissions",
        "--model",
        cliModel,
        "--log-file",
        logFile,
        "--print-timeout",
        PRINT_TIMEOUT,
        "-p",
        normalizedPrompt,
      ];
      const child = spawn(context.binaryPath, args, {
        cwd: context.session.cwd ?? serverConfig.cwd,
        env: buildProviderChildEnvironment({
          provider: PROVIDER,
          inheritedSynaraKeys: ["SYNARA_ANTIGRAVITY_EVENTS", "SYNARA_ANTIGRAVITY_HOOK_DECISION"],
          overrides: {
            SYNARA_ANTIGRAVITY_EVENTS: eventFile,
            SYNARA_ANTIGRAVITY_HOOK_DECISION: "allow",
          },
        }),
        stdio: ["ignore", "pipe", "pipe"],
      });
      context.activeProcess = child;
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      const timer = setInterval(() => void pollHookFile(context), POLL_INTERVAL_MS);
      child.once("error", (cause) => {
        clearInterval(timer);
        if (sessions.get(input.threadId) !== context || context.activeProcess !== child) return;
        offer({
          ...base(context, { includeTurn: false }),
          type: "runtime.error",
          payload: {
            message: messageFromCause(cause, "Failed to launch Antigravity CLI."),
            class: "transport_error",
          },
          raw: raw("process-error", cause),
        } satisfies ProviderRuntimeEvent);
      });
      child.once("close", (code, signal) => {
        clearInterval(timer);
        void (async () => {
          if (sessions.get(input.threadId) !== context || context.activeProcess !== child) {
            await fs.rm(runDir, { recursive: true, force: true }).catch(() => undefined);
            return;
          }
          await pollHookFile(context);
          if (!context.sawAssistant && stdout.trim()) {
            emitTextItem(
              context,
              { step_index: Number.MAX_SAFE_INTEGER, type: "PRINT_OUTPUT", content: stdout.trim() },
              "assistant_message",
              "assistant_text",
            );
          }
          const completionBase = base(context);
          const interrupted = context.interrupted || signal !== null;
          const failed = !interrupted && (code ?? 1) !== 0;
          if (failed && stderr.trim()) {
            offer({
              ...base(context, { includeTurn: false }),
              type: "runtime.error",
              payload: { message: stderr.trim(), class: "provider_error" },
              raw: raw("stderr", { code, stderr }),
            } satisfies ProviderRuntimeEvent);
          }
          delete context.activeProcess;
          delete context.activeTurnId;
          const {
            activeTurnId: _activeTurnId,
            lastError: _lastError,
            ...inactiveSession
          } = context.session;
          context.session = {
            ...inactiveSession,
            status: failed ? "error" : "ready",
            ...(context.conversationId ? { resumeCursor: context.conversationId } : {}),
            updatedAt: new Date().toISOString(),
            ...(failed
              ? { lastError: stderr.trim() || `Antigravity CLI exited with code ${code ?? 1}.` }
              : {}),
          };
          offer({
            ...completionBase,
            type: "turn.completed",
            payload: interrupted
              ? { state: "interrupted", stopReason: "interrupted" }
              : failed
                ? {
                    state: "failed",
                    stopReason: "error",
                    errorMessage: stderr.trim() || `Antigravity CLI exited with code ${code ?? 1}.`,
                  }
                : { state: "completed", stopReason: "model_stop" },
            raw: raw("process-exit", { code, signal, stdout, stderr }),
          } satisfies ProviderRuntimeEvent);
          await fs.rm(runDir, { recursive: true, force: true }).catch(() => undefined);
        })();
      });
      return {
        threadId: input.threadId,
        turnId,
        ...(context.conversationId ? { resumeCursor: context.conversationId } : {}),
      };
    });

  const interruptTurn: AntigravityAdapterShape["interruptTurn"] = (threadId) =>
    requireSession(threadId).pipe(
      Effect.flatMap((context) => {
        context.interrupted = true;
        return teardownActiveProcess(context, "turn/interrupt");
      }),
    );

  const unsupported = (threadId: ThreadId, method: string) =>
    Effect.fail(
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method,
        detail: `Antigravity CLI print mode does not expose interactive requests for ${threadId}.`,
      }),
    );

  const stopSession: AntigravityAdapterShape["stopSession"] = (threadId) =>
    requireSession(threadId).pipe(
      Effect.flatMap((context) =>
        Effect.gen(function* () {
          context.stopped = true;
          context.interrupted = true;
          yield* teardownActiveProcess(context, "session/stop");
          sessions.delete(threadId);
          offer({
            ...base(context, { includeTurn: false }),
            type: "session.exited",
            payload: { reason: "stopped", exitKind: "graceful" },
          } satisfies ProviderRuntimeEvent);
        }),
      ),
    );

  const snapshot = (context: AntigravitySessionContext): ProviderThreadSnapshot => ({
    threadId: context.session.threadId,
    ...(context.session.cwd ? { cwd: context.session.cwd } : {}),
    turns: context.turns.map((turn) => ({ id: turn.id, items: [...turn.items] })),
  });

  const rollbackThread: AntigravityAdapterShape["rollbackThread"] = (threadId, numTurns) =>
    requireSession(threadId).pipe(
      Effect.map((context) => {
        context.turns.splice(Math.max(0, context.turns.length - Math.max(0, numTurns)));
        // Antigravity has no rollback cursor; ProviderService will rebuild local context.
        delete context.conversationId;
        delete context.transcriptPath;
        delete context.processedTranscriptPath;
        context.processedTranscriptBytes = 0;
        context.processedSteps.clear();
        const { resumeCursor: _resumeCursor, ...sessionWithoutResume } = context.session;
        context.session = sessionWithoutResume;
        return snapshot(context);
      }),
    );

  const listModels: NonNullable<AntigravityAdapterShape["listModels"]> = (input) =>
    Effect.tryPromise({
      try: async () => {
        const result = await runAntigravityHelperProcess(
          trim(input.binaryPath) ?? "agy",
          ["models"],
          {
            ...(input.cwd ? { cwd: input.cwd } : {}),
            timeoutMs: MODEL_DISCOVERY_TIMEOUT_MS,
          },
        );
        if (result.code !== 0) throw new Error(result.stderr || "agy models failed");
        const models = parseModelLines(result.stdout);
        for (const model of models) {
          if (model.defaultReasoningEffort) {
            defaultEffortByModel.set(model.slug, model.defaultReasoningEffort);
          }
        }
        return {
          models,
          source: "antigravity.cli",
          cached: false,
        } satisfies ProviderListModelsResult;
      },
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "model/list",
          detail: messageFromCause(cause, "Failed to list Antigravity models."),
          cause,
        }),
    });

  const stopAll = () =>
    Effect.forEach([...sessions.keys()], (threadId) => stopSession(threadId), {
      concurrency: "unbounded",
      discard: true,
    }).pipe(Effect.asVoid);

  yield* Effect.addFinalizer(() =>
    stopAll().pipe(Effect.ignore, Effect.andThen(Queue.shutdown(events))),
  );

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "restart-session",
      conversationRollback: "restart-session",
      supportsRuntimeModelList: true,
      supportsLiveTurnDiffPatch: false,
    },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest: (threadId) => unsupported(threadId, "request/respond"),
    respondToUserInput: (threadId) => unsupported(threadId, "user-input/respond"),
    stopSession,
    listSessions: () => Effect.sync(() => [...sessions.values()].map((context) => context.session)),
    hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
    readThread: (threadId) => requireSession(threadId).pipe(Effect.map(snapshot)),
    rollbackThread,
    stopAll,
    listModels,
    getComposerCapabilities: () =>
      Effect.succeed({
        provider: PROVIDER,
        supportsSkillMentions: true,
        supportsSkillDiscovery: true,
        supportsNativeSlashCommandDiscovery: false,
        supportsPluginMentions: false,
        supportsPluginDiscovery: false,
        supportsRuntimeModelList: true,
        supportsThreadCompaction: false,
        supportsThreadImport: false,
      } satisfies ProviderComposerCapabilities),
    get streamEvents() {
      return Stream.fromQueue(events);
    },
  } satisfies AntigravityAdapterShape;
});

export const AntigravityAdapterLive = Layer.effect(AntigravityAdapter, makeAntigravityAdapter);

export function makeAntigravityAdapterLive() {
  return Layer.effect(AntigravityAdapter, makeAntigravityAdapter);
}
