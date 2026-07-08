import { spawn } from "node:child_process";
import * as readline from "node:readline";

import type {
  ModelCapabilities,
  ProviderModelDescriptor,
  ServerProviderAuthStatus,
  ServerProviderStatusState,
} from "@synara/contracts";
import {
  DEFAULT_GEMINI_MODEL_CAPABILITIES,
  GEMINI_2_5_MODEL_CAPABILITIES,
  GEMINI_3_MODEL_CAPABILITIES,
  geminiCapabilitiesForModel,
} from "@synara/shared/model";
import { prepareWindowsSafeProcess } from "@synara/shared/windowsProcess";
import { Effect } from "effect";
import { asNumber, asRecord, trimToUndefined } from "./geminiValue.ts";

// Gemini ACP cold starts can take noticeably longer than a normal request path,
// especially when the CLI has to warm caches or discover auth state. Keep the
// health probe patient enough to avoid false warning banners.
const GEMINI_ACP_PROBE_TIMEOUT_MS = 30_000;
const GEMINI_ACP_AUTH_REQUIRED_CODE = -32_000;
const MAX_CAPTURED_LOG_LINES = 5;
const MAX_CAPTURED_LOG_LENGTH = 240;
const GEMINI_BROWSER_BLOCKLIST_VALUE = "www-browser";
const GEMINI_API_KEY_ENV_HINT = "`GEMINI_API_KEY`";
const GEMINI_VERTEX_ENV_HINT =
  "`GOOGLE_GENAI_USE_VERTEXAI=true`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, plus ADC or `GOOGLE_API_KEY`";
const GEMINI_HEADLESS_AUTH_GUIDANCE = `Use Gemini API key or Vertex AI auth for Synara: set ${GEMINI_API_KEY_ENV_HINT} in \`~/.gemini/.env\`, or set Vertex AI env (${GEMINI_VERTEX_ENV_HINT}), then refresh provider status.`;
const GEMINI_CODE_ASSIST_MIGRATION_AUTH_MESSAGE = `Gemini is not authenticated because Google Code Assist OAuth for individual accounts appears to require Antigravity. For Synara, use ${GEMINI_API_KEY_ENV_HINT} or Vertex AI auth (${GEMINI_VERTEX_ENV_HINT}); use Antigravity for individual Code Assist OAuth until Gemini CLI exposes a compatible path.`;

const GEMINI_OAUTH_BROWSER_PROMPT_PATTERNS = [
  /opening your browser for oauth sign-in/i,
  /attempting to open authentication page in your browser/i,
  /accounts\.google\.com\/(?:v3\/signin|signin\/oauth)/i,
];

export {
  DEFAULT_GEMINI_MODEL_CAPABILITIES,
  GEMINI_2_5_MODEL_CAPABILITIES,
  GEMINI_3_MODEL_CAPABILITIES,
  geminiCapabilitiesForModel,
};

export type GeminiCapabilityProbeResult = {
  readonly models: ReadonlyArray<ProviderModelDescriptor>;
  readonly status: ServerProviderStatusState;
  readonly auth: { readonly status: ServerProviderAuthStatus };
  readonly message?: string;
};

function truncateLogLine(line: string): string {
  return line.length > MAX_CAPTURED_LOG_LENGTH
    ? `${line.slice(0, MAX_CAPTURED_LOG_LENGTH - 3)}...`
    : line;
}

function pushLogLine(target: string[], line: string): void {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("{")) {
    return;
  }

  target.push(truncateLogLine(trimmed));
  if (target.length > MAX_CAPTURED_LOG_LINES) {
    target.shift();
  }
}

function formatGeminiDiscoveryWarning(detail: string): string {
  return `Gemini CLI is installed, but Synara could not verify authentication or discover models. ${detail}`;
}

function formatGeminiAuthMessage(detail: string): string {
  return `Gemini is not authenticated. ${detail} ${GEMINI_HEADLESS_AUTH_GUIDANCE}`;
}

function formatGeminiCodeAssistMigrationAuthMessage(): string {
  return GEMINI_CODE_ASSIST_MIGRATION_AUTH_MESSAGE;
}

function formatGeminiModelDiscoveryFallbackMessage(): string {
  return "Gemini CLI is installed and authenticated, but it did not report any available models. Synara will use its built-in Gemini model list.";
}

function isGeminiUnauthenticatedFailure(message: string, code?: number): boolean {
  const lowerMessage = message.toLowerCase();
  return (
    code === GEMINI_ACP_AUTH_REQUIRED_CODE ||
    isGeminiCodeAssistMigrationAuthFailure(message) ||
    lowerMessage.includes("authentication required") ||
    lowerMessage.includes("api key is missing") ||
    lowerMessage.includes("auth method") ||
    lowerMessage.includes("not configured")
  );
}

function isGeminiLogUnauthenticatedFailure(message: string): boolean {
  const lowerMessage = message.toLowerCase();
  return (
    isGeminiCodeAssistMigrationAuthFailure(message) ||
    lowerMessage.includes("authentication required") ||
    lowerMessage.includes("api key is missing") ||
    lowerMessage.includes("auth method")
  );
}

function buildGeminiUnauthenticatedResult(
  message: string,
): Omit<GeminiCapabilityProbeResult, "models"> {
  return {
    status: "error",
    auth: { status: "unauthenticated" },
    message: isGeminiCodeAssistMigrationAuthFailure(message)
      ? formatGeminiCodeAssistMigrationAuthMessage()
      : formatGeminiAuthMessage(message),
  };
}

function detailFromProbeLogs(
  stdoutLines: ReadonlyArray<string>,
  stderrLines: ReadonlyArray<string>,
) {
  return stderrLines[stderrLines.length - 1] ?? stdoutLines[stdoutLines.length - 1];
}

export function parseGeminiAcpProbeError(
  error: unknown,
): Omit<GeminiCapabilityProbeResult, "models"> {
  const record = asRecord(error);
  const code = asNumber(record?.code);
  const message = trimToUndefined(record?.message) ?? "Gemini ACP request failed.";

  if (isGeminiUnauthenticatedFailure(message, code)) {
    return buildGeminiUnauthenticatedResult(message);
  }

  return {
    status: "warning",
    auth: { status: "unknown" },
    message: formatGeminiDiscoveryWarning(message),
  };
}

export function parseGeminiAcpProbeLogFailure(
  detail: string,
): Omit<GeminiCapabilityProbeResult, "models"> | undefined {
  return isGeminiLogUnauthenticatedFailure(detail)
    ? buildGeminiUnauthenticatedResult(detail)
    : undefined;
}

export function captureGeminiAcpProbeLogFailure(
  captured: Omit<GeminiCapabilityProbeResult, "models"> | undefined,
  line: string,
): Omit<GeminiCapabilityProbeResult, "models"> | undefined {
  return captured ?? parseGeminiAcpProbeLogFailure(line);
}

// Runs Gemini probes as status checks only; they must never launch an OAuth browser.
export function buildGeminiProbeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...env,
    NO_BROWSER: "true",
    BROWSER: GEMINI_BROWSER_BLOCKLIST_VALUE,
    CI: "true",
    DEBIAN_FRONTEND: "noninteractive",
  };
}

export function isGeminiOAuthBrowserPrompt(line: string): boolean {
  return GEMINI_OAUTH_BROWSER_PROMPT_PATTERNS.some((pattern) => pattern.test(line));
}

// Code Assist OAuth failures can surface either as the explicit Antigravity
// migration message or as a closed loadCodeAssist transport in ACP mode.
export function isGeminiCodeAssistMigrationAuthFailure(message: string): boolean {
  const lowerMessage = message.toLowerCase();
  const explicitMigration =
    lowerMessage.includes("gemini code assist") &&
    (lowerMessage.includes("antigravity") ||
      lowerMessage.includes("client is no longer supported") ||
      lowerMessage.includes("migrate"));
  const loadCodeAssistClosed =
    lowerMessage.includes("loadcodeassist") && lowerMessage.includes("premature close");

  return explicitMigration || loadCodeAssistClosed;
}

export function normalizeGeminiCapabilityProbeResult(
  result: GeminiCapabilityProbeResult,
): GeminiCapabilityProbeResult {
  if (result.auth.status === "authenticated" && result.models.length === 0) {
    return {
      ...result,
      status: "ready",
      message: formatGeminiModelDiscoveryFallbackMessage(),
    };
  }

  return result;
}

export function parseGeminiDiscoveredModels(
  response: unknown,
  _fallbackCapabilities: ModelCapabilities = DEFAULT_GEMINI_MODEL_CAPABILITIES,
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
    discoveredModels.push({
      slug,
      name: trimToUndefined(record?.name) ?? slug,
    });
  }

  return discoveredModels;
}

export const probeGeminiCapabilities = (input: {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly capabilities?: ModelCapabilities;
}) =>
  Effect.tryPromise(
    () =>
      new Promise<GeminiCapabilityProbeResult>((resolve) => {
        const env = buildGeminiProbeEnv();
        const prepared = prepareWindowsSafeProcess(input.binaryPath, ["--acp"], {
          cwd: input.cwd,
          env,
        });
        const child = spawn(prepared.command, prepared.args, {
          cwd: input.cwd,
          env,
          shell: prepared.shell,
          windowsHide: prepared.windowsHide,
          stdio: ["pipe", "pipe", "pipe"],
        });

        if (!child.stdin || !child.stdout || !child.stderr) {
          child.kill();
          resolve({
            status: "warning",
            auth: { status: "unknown" },
            models: [],
            message: formatGeminiDiscoveryWarning(
              "Gemini ACP did not expose the expected stdio streams.",
            ),
          });
          return;
        }

        const stdoutLines: string[] = [];
        const stderrLines: string[] = [];
        const stdoutReader = readline.createInterface({ input: child.stdout });
        const stderrReader = readline.createInterface({ input: child.stderr });

        let settled = false;
        let sessionNewRequested = false;
        let capturedAuthFailure: Omit<GeminiCapabilityProbeResult, "models"> | undefined;
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
          result: GeminiCapabilityProbeResult,
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
                  id: 3,
                  method: "session/close",
                  params: { sessionId: options.sessionId },
                })}\n`
              : undefined;
          terminate(closePayload);
          resolve(result);
        };

        const sendRequest = (id: number, method: string, params: Record<string, unknown>) => {
          if (!child.stdin.writable) {
            finalize({
              status: "warning",
              auth: { status: "unknown" },
              models: [],
              message: formatGeminiDiscoveryWarning("Gemini ACP stdin is not writable."),
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

        const finalizeOAuthBrowserPrompt = () => {
          finalize({
            status: "error",
            auth: { status: "unauthenticated" },
            models: [],
            message: formatGeminiAuthMessage(
              "Gemini attempted to start an OAuth browser flow during a Synara status check. Run `gemini` in a terminal to sign in.",
            ),
          });
        };

        const capturePlainAuthLogLine = (line: string) => {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("{")) {
            return;
          }

          capturedAuthFailure = captureGeminiAcpProbeLogFailure(capturedAuthFailure, trimmed);
        };

        timeout = setTimeout(() => {
          const detail = detailFromProbeLogs(stdoutLines, stderrLines);
          const authFailure =
            capturedAuthFailure ?? (detail ? parseGeminiAcpProbeLogFailure(detail) : undefined);
          if (authFailure) {
            finalize({
              ...authFailure,
              models: [],
            });
            return;
          }

          finalize({
            status: "warning",
            auth: { status: "unknown" },
            models: [],
            message: formatGeminiDiscoveryWarning(
              detail
                ? `Timed out while starting Gemini ACP session. Last output: ${detail}`
                : "Timed out while starting Gemini ACP session.",
            ),
          });
        }, GEMINI_ACP_PROBE_TIMEOUT_MS);

        stdoutReader.on("line", (line) => {
          pushLogLine(stdoutLines, line);
          if (isGeminiOAuthBrowserPrompt(line)) {
            finalizeOAuthBrowserPrompt();
            return;
          }

          const trimmed = line.trim();
          if (!trimmed.startsWith("{")) {
            capturePlainAuthLogLine(line);
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
                ...parseGeminiAcpProbeError(error),
                models: [],
              });
              return;
            }

            if (!sessionNewRequested) {
              sessionNewRequested = true;
              sendRequest(2, "session/new", {
                cwd: input.cwd,
                mcpServers: [],
              });
            }
            return;
          }

          if (id !== 2) {
            return;
          }

          const error = asRecord(parsed.error);
          if (error) {
            finalize({
              ...parseGeminiAcpProbeError(error),
              models: [],
            });
            return;
          }

          const result = parsed.result;
          const models = parseGeminiDiscoveredModels(
            result,
            input.capabilities ?? DEFAULT_GEMINI_MODEL_CAPABILITIES,
          );

          finalize(
            normalizeGeminiCapabilityProbeResult({
              status: "ready",
              auth: { status: "authenticated" },
              models,
              ...(models.length > 0
                ? { message: "Gemini CLI is installed and authenticated." }
                : {}),
            }),
            (() => {
              const sessionId = trimToUndefined(asRecord(result)?.sessionId);
              return sessionId ? { sessionId } : undefined;
            })(),
          );
        });

        stderrReader.on("line", (line) => {
          pushLogLine(stderrLines, line);
          if (isGeminiOAuthBrowserPrompt(line)) {
            finalizeOAuthBrowserPrompt();
            return;
          }

          capturePlainAuthLogLine(line);
        });

        child.once("error", (error) => {
          finalize({
            status: "warning",
            auth: { status: "unknown" },
            models: [],
            message: formatGeminiDiscoveryWarning(
              error.message.length > 0 ? error.message : "Failed to start Gemini ACP session.",
            ),
          });
        });

        child.once("exit", (code, signal) => {
          if (settled) {
            return;
          }

          const detail = detailFromProbeLogs(stdoutLines, stderrLines);
          const authFailure =
            capturedAuthFailure ?? (detail ? parseGeminiAcpProbeLogFailure(detail) : undefined);
          if (authFailure) {
            finalize({
              ...authFailure,
              models: [],
            });
            return;
          }

          const exitMessage =
            detail ??
            `Gemini ACP exited before responding (code ${code ?? "null"}${signal ? `, signal ${signal}` : ""}).`;
          finalize({
            status: "warning",
            auth: { status: "unknown" },
            models: [],
            message: formatGeminiDiscoveryWarning(exitMessage),
          });
        });

        sendRequest(1, "initialize", {
          protocolVersion: 1,
          clientInfo: {
            name: "synara",
            title: "Synara",
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
