import { spawn } from "node:child_process";
import * as os from "node:os";

import { Effect } from "effect";

import { DEFAULT_HERMES_COMMAND, resolveHermesAcpSpawn } from "./hermesAcp.ts";
import { trimToUndefined } from "./geminiValue.ts";
import {
  parseHermesProfileListOutput,
  parseHermesProfileShowOutput,
  type HermesProfileRecord,
} from "./hermesProfiles.ts";

export const HERMES_ACTIVE_PROFILE_DESCRIPTION = "hermes-active-profile";

const HERMES_PROFILE_LIST_TIMEOUT_MS = 15_000;
const HERMES_PROFILE_SHOW_TIMEOUT_MS = 10_000;
const HERMES_PROFILE_LIST_CACHE_TTL_MS = 60_000;

type ListCacheEntry = {
  readonly expiresAt: number;
  readonly profiles: ReadonlyArray<HermesProfileRecord>;
};

const listCache = new Map<string, ListCacheEntry>();

function listCacheKey(binaryPath: string): string {
  return binaryPath;
}

function runHermesCli(input: {
  readonly binaryPath: string;
  readonly args: ReadonlyArray<string>;
  readonly timeoutMs: number;
}): Effect.Effect<string, Error> {
  return Effect.tryPromise({
    try: () =>
      new Promise<string>((resolve, reject) => {
        const acpSpawn = resolveHermesAcpSpawn(input.binaryPath);
        const command = acpSpawn.command;
        const child = spawn(command, input.args, {
          cwd: os.homedir(),
          shell: process.platform === "win32",
          stdio: ["ignore", "pipe", "pipe"],
        });

        const stdoutChunks: string[] = [];
        const stderrChunks: string[] = [];
        child.stdout?.on("data", (chunk) => stdoutChunks.push(String(chunk)));
        child.stderr?.on("data", (chunk) => stderrChunks.push(String(chunk)));

        const timeout = setTimeout(() => {
          child.kill();
          reject(new Error(`Timed out running ${command} ${input.args.join(" ")}`));
        }, input.timeoutMs);
        timeout.unref?.();

        child.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.once("exit", (code) => {
          clearTimeout(timeout);
          if (code !== 0) {
            const detail =
              stderrChunks.join("").trim() ||
              stdoutChunks.join("").trim() ||
              `exit code ${code ?? "null"}`;
            reject(new Error(detail));
            return;
          }
          resolve(stdoutChunks.join(""));
        });
      }),
    catch: (cause) =>
      cause instanceof Error ? cause : new Error("Failed to run Hermes profile command."),
  });
}

export function resolveDefaultHermesProfile(
  profiles: ReadonlyArray<HermesProfileRecord>,
): HermesProfileRecord | undefined {
  return profiles.find((profile) => profile.isActive) ?? profiles[0];
}

export function listHermesProfileInventory(binaryPath?: string) {
  const resolvedBinaryPath = trimToUndefined(binaryPath) ?? DEFAULT_HERMES_COMMAND;
  const cacheKey = listCacheKey(resolvedBinaryPath);
  const cached = listCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return Effect.succeed(cached.profiles);
  }

  return runHermesCli({
    binaryPath: resolvedBinaryPath,
    args: ["profile", "list"],
    timeoutMs: HERMES_PROFILE_LIST_TIMEOUT_MS,
  }).pipe(
    Effect.map((output) => parseHermesProfileListOutput(output)),
    Effect.tap((profiles) =>
      Effect.sync(() => {
        listCache.set(cacheKey, {
          expiresAt: Date.now() + HERMES_PROFILE_LIST_CACHE_TTL_MS,
          profiles,
        });
      }),
    ),
  );
}

export function resolveHermesProfileHomeFromInventory(input: {
  readonly binaryPath?: string;
  readonly profile: string;
}): Effect.Effect<string | undefined, never> {
  const profileName = trimToUndefined(input.profile);
  if (!profileName) {
    return Effect.succeed(undefined);
  }

  const resolvedBinaryPath = trimToUndefined(input.binaryPath) ?? DEFAULT_HERMES_COMMAND;
  return runHermesCli({
    binaryPath: resolvedBinaryPath,
    args: ["profile", "show", profileName],
    timeoutMs: HERMES_PROFILE_SHOW_TIMEOUT_MS,
  }).pipe(
    Effect.map((output) => parseHermesProfileShowOutput(output)?.path),
    Effect.catch(() => Effect.succeed(undefined)),
  );
}

export function resolveActiveHermesProfile(binaryPath?: string) {
  return listHermesProfileInventory(binaryPath).pipe(
    Effect.map((profiles) => resolveDefaultHermesProfile(profiles)),
  );
}

export function isHermesProfileListCached(binaryPath?: string): boolean {
  const resolvedBinaryPath = trimToUndefined(binaryPath) ?? DEFAULT_HERMES_COMMAND;
  const cached = listCache.get(listCacheKey(resolvedBinaryPath));
  return cached !== undefined && cached.expiresAt > Date.now();
}

export function clearHermesProfileInventoryCacheForTests(): void {
  listCache.clear();
}
