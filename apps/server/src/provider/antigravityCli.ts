/**
 * Antigravity CLI helpers shared by the adapter and model discovery: bounded
 * helper-process execution and `agy models` label parsing.
 *
 * @module antigravityCli
 */
import type { ChildProcess } from "node:child_process";

import type { AntigravityModelOptions, ProviderListModelsResult } from "@synara/contracts";
import { spawnProcess as spawnPlatformProcess } from "@synara/shared/processRuntime";

import { buildProviderChildEnvironment } from "../providerChildEnvironment.ts";
import { capHistoryBytes } from "../terminal/terminalHistory.ts";
import { teardownChildProcessTree } from "./supervisedProcessTeardown.ts";

const PROVIDER = "antigravity" as const;
const MODEL_DISCOVERY_TIMEOUT_MS = 30_000;
export const ANTIGRAVITY_PROCESS_OUTPUT_MAX_BYTES = 128 * 1024;

type AntigravityChildProcess = ChildProcess & {
  readonly stdout: NonNullable<ChildProcess["stdout"]>;
  readonly stderr: NonNullable<ChildProcess["stderr"]>;
};

function messageFromCause(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim() ? cause.message : fallback;
}

/** Native session id from a stored resume cursor (a bare string, or a legacy record). */
export function readAntigravityResumeSessionId(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["sessionId", "conversationId", "providerThreadId", "id"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

type BoundedOutputStream = "stdout" | "stderr";

type BoundedOutputChunk = {
  readonly stream: BoundedOutputStream;
  readonly text: string;
  readonly bytes: number;
};

/**
 * Keep diagnostics bounded across both pipes while preserving their original
 * stream labels. A provider can write to stdout and stderr concurrently, so
 * separate per-stream caps would exceed the shared retention budget.
 */
export function createBoundedProcessOutput(maxBytes = ANTIGRAVITY_PROCESS_OUTPUT_MAX_BYTES) {
  const chunks: BoundedOutputChunk[] = [];
  let byteLength = 0;

  const append = (stream: BoundedOutputStream, chunk: unknown): void => {
    const text = String(chunk);
    if (text.length === 0 || maxBytes <= 0) return;
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > maxBytes) {
      const tail = capHistoryBytes(text, maxBytes, 0);
      chunks.push({ stream, text: tail, bytes: Buffer.byteLength(tail, "utf8") });
      byteLength += chunks[chunks.length - 1]!.bytes;
    } else {
      chunks.push({ stream, text, bytes });
      byteLength += bytes;
    }
    while (byteLength > maxBytes && chunks.length > 0) {
      const first = chunks[0]!;
      const overflow = byteLength - maxBytes;
      if (first.bytes <= overflow) {
        chunks.shift();
        byteLength -= first.bytes;
        continue;
      }
      const retained = capHistoryBytes(first.text, first.bytes - overflow, 0);
      chunks[0] = { ...first, text: retained, bytes: Buffer.byteLength(retained, "utf8") };
      byteLength -= first.bytes - chunks[0].bytes;
      break;
    }
  };

  const read = (stream: BoundedOutputStream): string =>
    chunks
      .filter((chunk) => chunk.stream === stream)
      .map((chunk) => chunk.text)
      .join("");

  return {
    append,
    snapshot: () => ({ stdout: read("stdout"), stderr: read("stderr") }),
    get byteLength() {
      return byteLength;
    },
  };
}

export async function runAntigravityHelperProcess(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    timeoutMs?: number;
    environment?: Readonly<Record<string, string>>;
    baseEnvironment?: NodeJS.ProcessEnv;
    stopOnStderr?: string;
  } = {},
): Promise<{
  stdout: string;
  stderr: string;
  code: number;
}> {
  return await new Promise((resolve, reject) => {
    const child = spawnPlatformProcess(command, args, {
      cwd: options.cwd,
      env: buildProviderChildEnvironment({
        provider: PROVIDER,
        baseEnv: options.baseEnvironment ?? process.env,
        ...(options.environment ? { overrides: options.environment } : {}),
      }),
      stdio: ["ignore", "pipe", "pipe"],
      requireExecutable: true,
    }) as AntigravityChildProcess;
    const output = createBoundedProcessOutput();
    let settled = false;
    let stopping = false;
    const timeoutMs = options.timeoutMs ?? MODEL_DISCOVERY_TIMEOUT_MS;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const stop = (timeout: boolean) => {
      if (settled || stopping) return;
      stopping = true;
      const message = timeout
        ? `Antigravity helper timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}`
        : "Antigravity helper requested interactive input";
      // Wait for the supervised teardown before returning output or releasing the caller's cwd.
      void teardownChildProcessTree(child).then(
        (result) =>
          finish(() => {
            if (result.signalErrors.length > 0) {
              reject(
                new Error(
                  `${message} and teardown was unproven: ${result.signalErrors.map((error) => error.message).join("; ")}`,
                  { cause: result.signalErrors[0] },
                ),
              );
            } else if (timeout) {
              reject(new Error(message));
            } else {
              resolve({ ...output.snapshot(), code: 1 });
            }
          }),
        (cause) =>
          finish(() =>
            reject(
              new Error(
                `${message} and teardown was unproven: ${messageFromCause(cause, "unknown teardown failure")}`,
                { cause },
              ),
            ),
          ),
      );
    };
    const timer = setTimeout(() => stop(true), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => output.append("stdout", chunk));
    child.stderr.on("data", (chunk) => {
      output.append("stderr", chunk);
      if (options.stopOnStderr && output.snapshot().stderr.includes(options.stopOnStderr)) {
        stop(false);
      }
    });
    child.once("error", (cause) => {
      if (stopping) return;
      finish(() => reject(cause));
    });
    child.once("close", (code) => {
      if (stopping) return;
      const { stdout, stderr } = output.snapshot();
      finish(() => resolve({ stdout, stderr, code: code ?? 1 }));
    });
  });
}

const DEFAULT_EFFORT_BY_MODEL: Readonly<Record<string, string>> = {
  "Gemini 3.7 Flash": "high",
  "Gemini 3.6 Flash": "medium",
  "Gemini 3.5 Flash": "medium",
  "Gemini 3.1 Pro": "low",
  "Claude Sonnet 4.6": "thinking",
  "Claude Opus 4.6": "thinking",
  "Claude 3.7 Sonnet": "thinking",
  "DeepSeek V4 Flash Max": "high",
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
  const stripped = value.replace(/\x1b\[[0-9;]*m/g, "").trim();
  if (!stripped) return null;

  // Newer `agy models` rows are `slug<TAB>Display Name (Effort)`. Older builds
  // printed only the display label. Prefer the display column when present so
  // Synara never treats `slug\tName` as a single model id at dispatch.
  const tabIndex = stripped.indexOf("\t");
  const labelColumn =
    tabIndex >= 0 ? stripped.slice(tabIndex + 1).trim() : stripped.replace(/^(?:[*•-]\s+)+/u, "");
  const trimmed = labelColumn.replace(/^(?:[*•-]\s+)+/u, "").trim();
  if (!trimmed) return null;

  const match = trimmed.match(/^(.*?)\s+\(([^()]+)\)$/u);
  if (!match?.[1] || !match[2]) return { model: trimmed };
  return {
    model: match[1].trim(),
    effort: match[2].trim().toLowerCase(),
  };
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
    const preferredEffort = DEFAULT_EFFORT_BY_MODEL[model];
    const defaultEffort =
      preferredEffort && efforts.includes(preferredEffort) ? preferredEffort : efforts[0];
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
  // An Orchestrator suffix names a planner. Leave a saved bare selection for the
  // session to resolve instead of treating discovery's default as an explicit choice.
  const defaultEffort =
    parsed.model.toLowerCase() === "orchestrator"
      ? undefined
      : (discoveredDefaultEffort?.trim().toLowerCase() ?? DEFAULT_EFFORT_BY_MODEL[parsed.model]);
  const effort = parsed.effort ?? options?.reasoningEffort?.trim().toLowerCase() ?? defaultEffort;
  // Always rebuild the CLI display label. Returning the raw input would preserve
  // corrupted `slug\tName (Effort)` rows from older discovery parsing.
  return effort ? `${parsed.model} (${effortLabel(effort)})` : parsed.model;
}
