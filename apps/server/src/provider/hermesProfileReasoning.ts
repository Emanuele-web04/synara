import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { Effect } from "effect";

import { resolveHermesAcpSpawn } from "./hermesAcp.ts";
import { trimToUndefined } from "./geminiValue.ts";

export const HERMES_REASONING_EFFORT_VALUES = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export type HermesReasoningEffortValue = (typeof HERMES_REASONING_EFFORT_VALUES)[number];

const HERMES_CONFIG_SET_TIMEOUT_MS = 10_000;

function reasoningEffortLabel(value: string): string {
  switch (value) {
    case "none":
      return "Off";
    case "minimal":
      return "Minimal";
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "xhigh":
      return "Extra High";
    default:
      return value
        .split(/[-_\s]+/u)
        .filter((segment) => segment.length > 0)
        .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
        .join(" ");
  }
}

export function isHermesReasoningEffortValue(value: string): value is HermesReasoningEffortValue {
  return (HERMES_REASONING_EFFORT_VALUES as readonly string[]).includes(value);
}

export function normalizeHermesReasoningEffort(value: unknown): HermesReasoningEffortValue | undefined {
  const trimmed = trimToUndefined(typeof value === "string" ? value : undefined)?.toLowerCase();
  if (!trimmed || !isHermesReasoningEffortValue(trimmed)) {
    return undefined;
  }
  return trimmed;
}

export function parseHermesProfileReasoningEffortFromConfig(configYaml: string): string | undefined {
  const agentSection = configYaml.match(/^agent:\s*\n((?:[ \t].*\n?)*)/m)?.[1];
  if (!agentSection) {
    return undefined;
  }
  const match = agentSection.match(/^\s*reasoning_effort:\s*(\S+)/m);
  return trimToUndefined(match?.[1]);
}

export function readHermesProfileReasoningEffort(profileHome: string): Effect.Effect<string | undefined> {
  return Effect.try({
    try: () => {
      const configPath = path.join(profileHome, "config.yaml");
      if (!fs.existsSync(configPath)) {
        return undefined;
      }
      const configYaml = fs.readFileSync(configPath, "utf8");
      return normalizeHermesReasoningEffort(parseHermesProfileReasoningEffortFromConfig(configYaml));
    },
    catch: () => new Error("Failed to read Hermes profile reasoning effort."),
  }).pipe(Effect.catch(() => Effect.succeed(undefined)));
}

function runHermesConfigSet(input: {
  readonly binaryPath: string;
  readonly profileHome: string;
  readonly effort: HermesReasoningEffortValue;
}): Effect.Effect<void, Error> {
  return Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        const acpSpawn = resolveHermesAcpSpawn(input.binaryPath);
        const child = spawn(
          acpSpawn.command,
          ["config", "set", "agent.reasoning_effort", input.effort],
          {
            cwd: input.profileHome,
            shell: process.platform === "win32",
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, HERMES_HOME: input.profileHome },
          },
        );

        const stderrChunks: string[] = [];
        child.stderr?.on("data", (chunk) => stderrChunks.push(String(chunk)));

        const timeout = setTimeout(() => {
          child.kill();
          reject(new Error("Timed out updating Hermes reasoning effort."));
        }, HERMES_CONFIG_SET_TIMEOUT_MS);
        timeout.unref?.();

        child.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.once("exit", (code) => {
          clearTimeout(timeout);
          if (code !== 0) {
            reject(
              new Error(
                stderrChunks.join("").trim() ||
                  `Failed to set Hermes reasoning effort (exit ${code ?? "null"}).`,
              ),
            );
            return;
          }
          resolve();
        });
      }),
    catch: (cause) =>
      cause instanceof Error ? cause : new Error("Failed to set Hermes reasoning effort."),
  });
}

export function applyHermesProfileReasoningEffort(input: {
  readonly binaryPath: string;
  readonly profileHome: string;
  readonly effort: string;
}): Effect.Effect<void, Error> {
  const normalized = normalizeHermesReasoningEffort(input.effort);
  if (!normalized) {
    return Effect.fail(new Error(`Unsupported Hermes reasoning effort: ${input.effort}`));
  }
  return runHermesConfigSet({
    binaryPath: input.binaryPath,
    profileHome: input.profileHome,
    effort: normalized,
  });
}

export function hermesReasoningEffortDescriptors(defaultEffort?: string) {
  const normalizedDefault = normalizeHermesReasoningEffort(defaultEffort);
  return HERMES_REASONING_EFFORT_VALUES.map((value) => ({
    value,
    label: reasoningEffortLabel(value),
    ...(value === normalizedDefault ? { isDefault: true as const } : {}),
  }));
}
