import { spawn } from "node:child_process";
import * as os from "node:os";
import * as readline from "node:readline";

import type {
  ProviderModelDescriptor,
  ServerProviderAuthStatus,
  ServerProviderStatusState,
} from "@t3tools/contracts";
import { Effect } from "effect";

import { asNumber, asRecord, trimToUndefined } from "./geminiValue.ts";
import {
  DEFAULT_HERMES_COMMAND,
  resolveHermesAcpSpawn,
  selectHermesAuthMethodId,
} from "./hermesAcp.ts";
import {
  detailFromAcpProbeLogs,
  pushAcpLogLine,
  truncateAcpLogLine,
} from "./acp/AcpCapabilityProbe.ts";
import { resolveHermesProfileHomeFromInventory } from "./hermesProfileInventory.ts";

const HERMES_ACP_PROBE_TIMEOUT_MS = 45_000;
const HERMES_ACP_PROBE_CACHE_TTL_MS = 60_000;
const MAX_CAPTURED_LOG_LINES = 5;
const MAX_CAPTURED_LOG_LENGTH = 240;

export type HermesCapabilityProbeResult = {
  readonly models: ReadonlyArray<ProviderModelDescriptor>;
  readonly currentModelId?: string;
  readonly status: ServerProviderStatusState;
  readonly auth: { readonly status: ServerProviderAuthStatus };
  readonly message?: string;
};

type CachedProbeEntry = {
  readonly expiresAt: number;
  readonly result: HermesCapabilityProbeResult;
};

const probeCache = new Map<string, CachedProbeEntry>();

function probeCacheKey(input: {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly profile?: string;
  readonly profileHome?: string;
}): string {
  return JSON.stringify({
    binaryPath: input.binaryPath,
    cwd: input.cwd,
    profile: input.profile ?? null,
    profileHome: input.profileHome ?? null,
  });
}

function formatHermesDiscoveryWarning(detail: string): string {
  return `Hermes CLI is installed, but DP Code could not verify authentication or discover models. ${detail}`;
}

function formatHermesAuthMessage(detail: string): string {
  return `Hermes is not authenticated. ${detail}`;
}

function formatHermesModelDiscoveryFallbackMessage(): string {
  return "Hermes CLI is installed and authenticated, but it did not report any available models. DP Code will use profile defaults and custom overrides.";
}

export function parseHermesAcpProbeError(
  error: unknown,
): Omit<HermesCapabilityProbeResult, "models" | "currentModelId"> {
  const record = asRecord(error);
  const message = trimToUndefined(record?.message) ?? "Hermes ACP request failed.";
  const lowerMessage = message.toLowerCase();
  const unauthenticated =
    lowerMessage.includes("authentication required") ||
    lowerMessage.includes("not authenticated") ||
    lowerMessage.includes("auth method") ||
    lowerMessage.includes("not configured");

  if (unauthenticated) {
    return {
      status: "error",
      auth: { status: "unauthenticated" },
      message: formatHermesAuthMessage(message),
    };
  }

  return {
    status: "warning",
    auth: { status: "unknown" },
    message: formatHermesDiscoveryWarning(message),
  };
}

export function normalizeHermesCapabilityProbeResult(
  result: HermesCapabilityProbeResult,
): HermesCapabilityProbeResult {
  if (result.auth.status === "authenticated" && result.models.length === 0) {
    return {
      ...result,
      status: "ready",
      message: formatHermesModelDiscoveryFallbackMessage(),
    };
  }

  return result;
}

function readHermesModelDescription(
  record: Record<string, unknown> | undefined,
): string | undefined {
  return trimToUndefined(record?.description);
}

function parseHermesUpstreamProviderName(description: string | undefined): string | undefined {
  const trimmed = trimToUndefined(description);
  if (!trimmed) {
    return undefined;
  }
  const match = trimmed.match(/^Provider:\s*([^•]+)/iu);
  return trimToUndefined(match?.[1]);
}

function fallbackHermesUpstreamProviderName(upstreamProviderId: string): string {
  if (upstreamProviderId === "opencode-go") {
    return "OpenCode Go";
  }
  return upstreamProviderId
    .split(/[-_]/g)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function parseHermesDiscoveredModels(
  response: unknown,
): ReadonlyArray<ProviderModelDescriptor> {
  const availableModels = asRecord(asRecord(response)?.models)?.availableModels;
  if (!Array.isArray(availableModels)) {
    return [];
  }

  const discoveredModels: ProviderModelDescriptor[] = [];
  const seen = new Set<string>();

  for (const candidate of availableModels) {
    const record = asRecord(candidate);
    const slug = trimToUndefined(record?.modelId);
    if (!slug || seen.has(slug)) {
      continue;
    }

    seen.add(slug);
    const colonIndex = slug.indexOf(":");
    const upstreamProviderId = colonIndex > 0 ? slug.slice(0, colonIndex) : undefined;
    const description = readHermesModelDescription(record);
    const upstreamProviderName =
      parseHermesUpstreamProviderName(description) ??
      (upstreamProviderId ? fallbackHermesUpstreamProviderName(upstreamProviderId) : undefined);
    const name = trimToUndefined(record?.name) ?? slug;

    discoveredModels.push({
      slug,
      name,
      ...(upstreamProviderId ? { upstreamProviderId } : {}),
      ...(upstreamProviderName ? { upstreamProviderName } : {}),
    });
  }

  return discoveredModels;
}

function readCurrentModelId(response: unknown): string | undefined {
  return trimToUndefined(asRecord(asRecord(response)?.models)?.currentModelId);
}

export function isHermesProbeCacheHit(input: {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly profile?: string;
  readonly profileHome?: string;
}): boolean {
  const cacheKey = probeCacheKey(input);
  const cached = probeCache.get(cacheKey);
  return cached !== undefined && cached.expiresAt > Date.now();
}

export const probeHermesCapabilities = (input: {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly profile?: string;
  readonly profileHome?: string;
}) =>
  Effect.gen(function* () {
    const profileHome =
      input.profileHome ??
      (input.profile
        ? yield* resolveHermesProfileHomeFromInventory({
            binaryPath: input.binaryPath,
            profile: input.profile,
          })
        : undefined);

    const cacheKey = probeCacheKey({
      binaryPath: input.binaryPath,
      cwd: input.cwd,
      ...(input.profile ? { profile: input.profile } : {}),
      ...(profileHome ? { profileHome } : {}),
    });
    const cached = probeCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.result;
    }

    const result = yield* Effect.tryPromise(
      () =>
        new Promise<HermesCapabilityProbeResult>((resolve) => {
          const acpSpawn = resolveHermesAcpSpawn(input.binaryPath);
          const child = spawn(acpSpawn.command, acpSpawn.args, {
            cwd: input.cwd,
            shell: process.platform === "win32",
            stdio: ["pipe", "pipe", "pipe"],
            env: profileHome ? { ...process.env, HERMES_HOME: profileHome } : process.env,
          });

          if (!child.stdin || !child.stdout || !child.stderr) {
            child.kill();
            resolve({
              status: "warning",
              auth: { status: "unknown" },
              models: [],
              message: formatHermesDiscoveryWarning(
                "Hermes ACP did not expose the expected stdio streams.",
              ),
            });
            return;
          }

          const stdoutLines: string[] = [];
          const stderrLines: string[] = [];
          const stdoutReader = readline.createInterface({ input: child.stdout });
          const stderrReader = readline.createInterface({ input: child.stderr });

          let settled = false;
          let initializeResult: Record<string, unknown> | undefined;
          let authMethodId: string | undefined;
          let sessionNewRequested = false;
          let authenticateRequested = false;
          let timeout: ReturnType<typeof setTimeout> | undefined;

          const cleanup = () => {
            if (timeout) {
              clearTimeout(timeout);
            }
            stdoutReader.removeAllListeners();
            stderrReader.removeAllListeners();
            child.removeAllListeners();
            stdoutReader.close();
            stderrReader.close();
          };

          const terminate = (gracefulClosePayload?: string) => {
            if (gracefulClosePayload && child.stdin.writable) {
              child.stdin.write(gracefulClosePayload);
              child.stdin.end();
              const delayedKill = setTimeout(() => {
                if (!child.killed) {
                  child.kill();
                }
              }, 150);
              delayedKill.unref?.();
              return;
            }

            if (child.stdin.writable) {
              child.stdin.end();
            }
            if (!child.killed) {
              child.kill();
            }
          };

          const finalize = (
            probeResult: HermesCapabilityProbeResult,
            options?: { readonly sessionId?: string },
          ) => {
            if (settled) {
              return;
            }

            settled = true;
            cleanup();
            const closePayload =
              options?.sessionId && options.sessionId.length > 0
                ? `${JSON.stringify({
                    jsonrpc: "2.0",
                    id: 4,
                    method: "session/close",
                    params: { sessionId: options.sessionId },
                  })}\n`
                : undefined;
            terminate(closePayload);
            resolve(probeResult);
          };

          const sendRequest = (id: number, method: string, params: Record<string, unknown>) => {
            if (!child.stdin.writable) {
              finalize({
                status: "warning",
                auth: { status: "unknown" },
                models: [],
                message: formatHermesDiscoveryWarning("Hermes ACP stdin is not writable."),
              });
              return;
            }

            child.stdin.write(
              `${JSON.stringify({
                jsonrpc: "2.0",
                id,
                method,
                params,
              })}\n`,
            );
          };

          timeout = setTimeout(() => {
            const detail = detailFromAcpProbeLogs(stdoutLines, stderrLines);
            finalize({
              status: "warning",
              auth: { status: "unknown" },
              models: [],
              message: formatHermesDiscoveryWarning(
                detail
                  ? `Timed out while starting Hermes ACP session. Last output: ${detail}`
                  : "Timed out while starting Hermes ACP session.",
              ),
            });
          }, HERMES_ACP_PROBE_TIMEOUT_MS);

          stdoutReader.on("line", (line) => {
            pushAcpLogLine(stdoutLines, line);

            const trimmed = line.trim();
            if (!trimmed.startsWith("{")) {
              return;
            }

            let parsed: Record<string, unknown> | undefined;
            try {
              parsed = asRecord(JSON.parse(trimmed));
            } catch {
              return;
            }

            if (!parsed) {
              return;
            }

            const id = asNumber(parsed.id);
            if (id === 1) {
              const error = asRecord(parsed.error);
              if (error) {
                finalize({
                  ...parseHermesAcpProbeError(error),
                  models: [],
                });
                return;
              }

              initializeResult = asRecord(parsed.result);
              authMethodId = initializeResult
                ? selectHermesAuthMethodId({
                    initializeResult: initializeResult as never,
                  })
                : undefined;

              if (authMethodId) {
                authenticateRequested = true;
                sendRequest(2, "authenticate", { methodId: authMethodId });
              } else if (!sessionNewRequested) {
                sessionNewRequested = true;
                sendRequest(3, "session/new", {
                  cwd: input.cwd,
                  mcpServers: [],
                });
              }
              return;
            }

            if (id === 2 && authenticateRequested) {
              const error = asRecord(parsed.error);
              if (error) {
                finalize({
                  ...parseHermesAcpProbeError(error),
                  models: [],
                });
                return;
              }

              if (!sessionNewRequested) {
                sessionNewRequested = true;
                sendRequest(3, "session/new", {
                  cwd: input.cwd,
                  mcpServers: [],
                });
              }
              return;
            }

            if (id !== 3) {
              return;
            }

            const error = asRecord(parsed.error);
            if (error) {
              finalize({
                ...parseHermesAcpProbeError(error),
                models: [],
              });
              return;
            }

            const result = parsed.result;
            const models = parseHermesDiscoveredModels(result);
            const currentModelId = readCurrentModelId(result);

            finalize(
              normalizeHermesCapabilityProbeResult({
                status: "ready",
                auth: { status: "authenticated" },
                models,
                ...(currentModelId ? { currentModelId } : {}),
                ...(models.length > 0
                  ? { message: "Hermes CLI is installed and authenticated." }
                  : {}),
              }),
              (() => {
                const sessionId = trimToUndefined(asRecord(result)?.sessionId);
                return sessionId ? { sessionId } : undefined;
              })(),
            );
          });

          stderrReader.on("line", (line) => {
            pushAcpLogLine(stderrLines, line);
          });

          child.once("error", (error) => {
            finalize({
              status: "warning",
              auth: { status: "unknown" },
              models: [],
              message: formatHermesDiscoveryWarning(
                error.message.length > 0 ? error.message : "Failed to start Hermes ACP session.",
              ),
            });
          });

          child.once("exit", (code, signal) => {
            if (settled) {
              return;
            }

            const detail = detailFromAcpProbeLogs(stdoutLines, stderrLines);
            const exitMessage =
              detail ??
              `Hermes ACP exited before responding (code ${code ?? "null"}${signal ? `, signal ${signal}` : ""}).`;
            finalize({
              status: "warning",
              auth: { status: "unknown" },
              models: [],
              message: formatHermesDiscoveryWarning(exitMessage),
            });
          });

          sendRequest(1, "initialize", {
            protocolVersion: 1,
            clientInfo: {
              name: "dpcode",
              title: "DP Code",
              version: "0.1.0",
            },
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
              auth: { terminal: false },
            },
          });
        }),
    );

    probeCache.set(cacheKey, {
      expiresAt: Date.now() + HERMES_ACP_PROBE_CACHE_TTL_MS,
      result,
    });
    return result;
  });

export function clearHermesAcpProbeCacheForTests(): void {
  probeCache.clear();
}

export function resolveHermesProbeBinaryPath(binaryPath?: string): string {
  return trimToUndefined(binaryPath) ?? DEFAULT_HERMES_COMMAND;
}

export function resolveHermesProbeCwd(cwd?: string): string {
  return trimToUndefined(cwd) ?? os.homedir();
}
