import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import type { ExternalMcpPairResult } from "@synara/contracts";

import type { PersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { computeExternalMcpRuntimeProof, runtimeProofsMatch } from "./runtimeProof.ts";

const CLIENT_STORE_VERSION = 1;
const CLIENT_STORE_DIRECTORY = path.join("mcp", "credentials");
const PENDING_PAIRING_DIRECTORY = path.join("mcp", "pending-pairing");
const RUNTIME_CHALLENGE_TIMEOUT_MS = 2_000;
const REQUEST_TIMEOUT_MS = 15_000;
const RECONNECT_TIMEOUT_MS = 10_000;
const MAX_IN_FLIGHT = 8;
const RUNTIME_STATE_RELATIVE_PATHS = [
  path.join("userdata", "server-runtime.json"),
  path.join("dev", "server-runtime.json"),
] as const;

export class ExternalMcpBridgeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ExternalMcpBridgeError";
  }
}

export interface ExternalMcpClientCredentialStore {
  readonly version: 1;
  readonly integrationId: string;
  readonly name: string;
  readonly credential: string;
  readonly expiresAt: string;
  readonly pairedAt: string;
}

interface PendingPairingStore {
  readonly version: 1;
  readonly credential: string;
  readonly createdAt: string;
}

export type ExternalMcpFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export function resolveExternalMcpBaseDir(homeDir?: string): string {
  const configured = homeDir?.trim() || process.env.SYNARA_HOME?.trim();
  if (!configured) return path.join(os.homedir(), ".synara");
  if (configured === "~") return os.homedir();
  if (configured.startsWith(`~${path.sep}`) || configured.startsWith("~/")) {
    return path.resolve(os.homedir(), configured.slice(2));
  }
  return path.resolve(configured);
}

function safeIntegrationId(integrationId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/u.test(integrationId)) {
    throw new ExternalMcpBridgeError("Invalid external MCP integration id.");
  }
  return integrationId;
}

export function externalMcpClientStorePath(baseDir: string, integrationId: string): string {
  return path.join(baseDir, CLIENT_STORE_DIRECTORY, `${safeIntegrationId(integrationId)}.json`);
}

function parseRuntimeState(raw: string, sourcePath: string): PersistedServerRuntimeState {
  try {
    const state = JSON.parse(raw) as Partial<PersistedServerRuntimeState>;
    if (
      state.version !== 1 ||
      !Number.isInteger(state.pid) ||
      !Number.isInteger(state.port) ||
      typeof state.origin !== "string" ||
      typeof state.startedAt !== "string" ||
      typeof state.externalMcpRuntimeSecret !== "string" ||
      state.externalMcpRuntimeSecret.length < 32
    ) {
      throw new Error("invalid runtime-state shape");
    }
    const origin = new URL(state.origin);
    if (
      origin.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]", "::1"].includes(origin.hostname)
    ) {
      throw new Error("runtime origin is not loopback HTTP");
    }
    return state as PersistedServerRuntimeState;
  } catch (cause) {
    throw new ExternalMcpBridgeError(`Invalid Synara runtime-state file: ${sourcePath}`, { cause });
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function discoverExternalMcpRuntime(baseDir: string): {
  readonly state: PersistedServerRuntimeState;
  readonly sourcePath: string;
} {
  const candidates = RUNTIME_STATE_RELATIVE_PATHS.flatMap((relativePath) => {
    const sourcePath = path.join(baseDir, relativePath);
    if (!fs.existsSync(sourcePath)) return [];
    const state = parseRuntimeState(fs.readFileSync(sourcePath, "utf8"), sourcePath);
    return processIsAlive(state.pid) ? [{ state, sourcePath }] : [];
  });
  if (candidates.length === 0) {
    throw new ExternalMcpBridgeError(
      `No running Synara instance was found under ${baseDir}. Start Synara first or pass --home-dir for the intended instance.`,
    );
  }
  if (candidates.length > 1) {
    throw new ExternalMcpBridgeError(
      `Multiple running Synara instances were found under ${baseDir}: ${candidates.map((candidate) => candidate.state.origin).join(", ")}. Stop one instance or pass a distinct --home-dir.`,
    );
  }
  return candidates[0]!;
}

function assertPrivateFile(filePath: string): void {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new ExternalMcpBridgeError(`Refusing unsafe credential path: ${filePath}`);
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new ExternalMcpBridgeError(
      `Credential file ${filePath} is accessible by other users. Run: chmod 600 ${JSON.stringify(filePath)}`,
    );
  }
}

function writePrivateJson(filePath: string, value: unknown): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
  const tempPath = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  if (process.platform !== "win32") fs.chmodSync(tempPath, 0o600);
  fs.renameSync(tempPath, filePath);
  if (process.platform !== "win32") fs.chmodSync(filePath, 0o600);
}

export function writeExternalMcpClientCredential(
  baseDir: string,
  paired: ExternalMcpPairResult,
): string {
  const filePath = externalMcpClientStorePath(baseDir, paired.integrationId);
  if (fs.existsSync(filePath)) {
    const existing = readExternalMcpClientCredential(baseDir, paired.integrationId);
    if (existing.credential !== paired.credential) {
      throw new ExternalMcpBridgeError(
        `Integration ${paired.integrationId} already has a different stored credential. Revoke it in Synara before replacing the local secret.`,
      );
    }
    return filePath;
  }
  writePrivateJson(filePath, {
    version: CLIENT_STORE_VERSION,
    integrationId: paired.integrationId,
    name: paired.name,
    credential: paired.credential,
    expiresAt: paired.expiresAt,
    pairedAt: new Date().toISOString(),
  } satisfies ExternalMcpClientCredentialStore);
  return filePath;
}

export function readExternalMcpClientCredential(
  baseDir: string,
  integrationId?: string,
): ExternalMcpClientCredentialStore {
  const directory = path.join(baseDir, CLIENT_STORE_DIRECTORY);
  const candidates = integrationId
    ? [externalMcpClientStorePath(baseDir, integrationId)]
    : fs.existsSync(directory)
      ? fs
          .readdirSync(directory, { withFileTypes: true })
          .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
          .map((entry) => path.join(directory, entry.name))
          .toSorted()
      : [];
  if (candidates.length === 0 || !fs.existsSync(candidates[0]!)) {
    throw new ExternalMcpBridgeError(
      integrationId
        ? `No paired external MCP credential was found for integration ${integrationId}. Run its pairing command from Synara Settings.`
        : `No paired external MCP credential was found under ${directory}. Create an integration in Synara Settings, then run its pairing command.`,
    );
  }
  if (candidates.length > 1) {
    const ids = candidates.map((candidate) => path.basename(candidate, ".json"));
    throw new ExternalMcpBridgeError(
      `Multiple paired external MCP integrations were found (${ids.join(", ")}). Pass --integration with the intended id.`,
    );
  }
  const filePath = candidates[0]!;
  assertPrivateFile(filePath);
  try {
    const parsed = JSON.parse(
      fs.readFileSync(filePath, "utf8"),
    ) as Partial<ExternalMcpClientCredentialStore>;
    if (
      parsed.version !== CLIENT_STORE_VERSION ||
      typeof parsed.integrationId !== "string" ||
      typeof parsed.name !== "string" ||
      typeof parsed.credential !== "string" ||
      typeof parsed.expiresAt !== "string" ||
      typeof parsed.pairedAt !== "string"
    ) {
      throw new Error("invalid credential-store shape");
    }
    return parsed as ExternalMcpClientCredentialStore;
  } catch (cause) {
    throw new ExternalMcpBridgeError(`Invalid external MCP credential store: ${filePath}`, {
      cause,
    });
  }
}

function pendingPairingPath(baseDir: string, pairingCode: string): string {
  const digest = createHash("sha256").update(pairingCode).digest("hex");
  return path.join(baseDir, PENDING_PAIRING_DIRECTORY, `${digest}.json`);
}

function loadOrCreatePendingPairing(
  baseDir: string,
  pairingCode: string,
): {
  readonly path: string;
  readonly value: PendingPairingStore;
} {
  const filePath = pendingPairingPath(baseDir, pairingCode);
  if (fs.existsSync(filePath)) {
    assertPrivateFile(filePath);
    const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<PendingPairingStore>;
    if (
      value.version !== 1 ||
      typeof value.credential !== "string" ||
      typeof value.createdAt !== "string"
    ) {
      throw new ExternalMcpBridgeError(`Invalid pending external MCP pairing store: ${filePath}`);
    }
    return { path: filePath, value: value as PendingPairingStore };
  }
  const value: PendingPairingStore = {
    version: 1,
    credential: `syn_mcp_v1_${randomBytes(32).toString("base64url")}`,
    createdAt: new Date().toISOString(),
  };
  writePrivateJson(filePath, value);
  return { path: filePath, value };
}

export async function fetchExternalMcpWithTimeout(
  fetchImpl: ExternalMcpFetch,
  url: URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ExternalMcpBridgeError(`Synara did not respond within ${timeoutMs} ms.`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([fetchImpl(url, { ...init, signal: controller.signal }), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function readExternalMcpResponseText(
  response: Response,
  timeoutMs = RUNTIME_CHALLENGE_TIMEOUT_MS,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const readAll = async () => {
    let result = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return result + decoder.decode();
      result += decoder.decode(chunk.value, { stream: true });
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      void reader.cancel().catch(() => undefined);
      reject(new ExternalMcpBridgeError(`Synara response body stalled for ${timeoutMs} ms.`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([readAll(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    reader.releaseLock();
  }
}

export async function verifyExternalMcpRuntime(
  runtime: ReturnType<typeof discoverExternalMcpRuntime>,
  fetchImpl: ExternalMcpFetch,
): Promise<void> {
  const nonce = randomBytes(24).toString("base64url");
  const response = await fetchExternalMcpWithTimeout(
    fetchImpl,
    new URL("/api/mcp/external/runtime-challenge", runtime.state.origin),
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ nonce }),
    },
    RUNTIME_CHALLENGE_TIMEOUT_MS,
  );
  let body: { readonly proof?: unknown } | null;
  try {
    body = JSON.parse(await readExternalMcpResponseText(response)) as {
      readonly proof?: unknown;
    };
  } catch {
    body = null;
  }
  const expected = computeExternalMcpRuntimeProof(runtime.state.externalMcpRuntimeSecret, nonce);
  if (
    !response.ok ||
    typeof body?.proof !== "string" ||
    !runtimeProofsMatch(expected, body.proof)
  ) {
    throw new ExternalMcpBridgeError(
      "The loopback endpoint did not prove it is the Synara process named by the private runtime-state file.",
    );
  }
}

function requestTimeoutForBody(body: string): number {
  try {
    const parsed = JSON.parse(body) as unknown;
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    let timeout = REQUEST_TIMEOUT_MS;
    for (const value of messages) {
      if (!value || typeof value !== "object") continue;
      const request = value as {
        method?: unknown;
        params?: { name?: unknown; arguments?: { timeoutMs?: unknown } };
      };
      if (request.method !== "tools/call" || request.params?.name !== "synara_wait_for_task")
        continue;
      const waitMs = request.params.arguments?.timeoutMs;
      if (typeof waitMs === "number" && Number.isFinite(waitMs)) {
        timeout = Math.max(timeout, Math.min(60_000, Math.max(0, waitMs)) + 5_000);
      }
    }
    return timeout;
  } catch {
    return REQUEST_TIMEOUT_MS;
  }
}

async function fetchWithRestartRecovery(input: {
  readonly baseDir: string;
  readonly credential: string;
  readonly body: string;
  readonly fetchImpl?: ExternalMcpFetch;
  readonly recoveryTimeoutMs?: number;
}): Promise<Response> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const deadline = Date.now() + (input.recoveryTimeoutMs ?? RECONNECT_TIMEOUT_MS);
  let lastCause: unknown;
  do {
    try {
      const runtime = discoverExternalMcpRuntime(input.baseDir);
      await verifyExternalMcpRuntime(runtime, fetchImpl);
      return await fetchExternalMcpWithTimeout(
        fetchImpl,
        new URL("/mcp/external", runtime.state.origin),
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${input.credential}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: input.body,
        },
        requestTimeoutForBody(input.body),
      );
    } catch (cause) {
      lastCause = cause;
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } while (Date.now() < deadline);
  throw new ExternalMcpBridgeError(
    "Could not authenticate and reconnect to Synara. Ensure exactly one intended instance is running.",
    { cause: lastCause },
  );
}

export async function pairExternalMcpClient(input: {
  readonly baseDir: string;
  readonly pairingCode: string;
  readonly fetchImpl?: ExternalMcpFetch;
}): Promise<{ readonly paired: ExternalMcpPairResult; readonly storePath: string }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const pending = loadOrCreatePendingPairing(input.baseDir, input.pairingCode);
  const requestBody = JSON.stringify({
    pairingCode: input.pairingCode,
    credential: pending.value.credential,
  });
  const deadline = Date.now() + RECONNECT_TIMEOUT_MS;
  let response: Response | null = null;
  let lastCause: unknown;
  do {
    try {
      const runtime = discoverExternalMcpRuntime(input.baseDir);
      await verifyExternalMcpRuntime(runtime, fetchImpl);
      response = await fetchExternalMcpWithTimeout(
        fetchImpl,
        new URL("/api/mcp/external/pair", runtime.state.origin),
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: requestBody,
        },
        REQUEST_TIMEOUT_MS,
      );
      break;
    } catch (cause) {
      lastCause = cause;
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } while (Date.now() < deadline);
  if (!response) {
    throw new ExternalMcpBridgeError(
      "Could not reconnect to Synara to complete pairing. The private pending credential was preserved for a safe retry.",
      { cause: lastCause },
    );
  }
  let body: ExternalMcpPairResult | { readonly error?: string } | null;
  try {
    body = JSON.parse(await readExternalMcpResponseText(response)) as
      | ExternalMcpPairResult
      | { readonly error?: string };
  } catch {
    body = null;
  }
  if (!response.ok || !body || !("credential" in body)) {
    throw new ExternalMcpBridgeError(
      (body && "error" in body && body.error) ||
        `Synara rejected external MCP pairing with HTTP ${response.status}.`,
    );
  }
  if (body.credential !== pending.value.credential) {
    throw new ExternalMcpBridgeError(
      "Synara returned a different pairing credential; refusing it.",
    );
  }
  const storePath = writeExternalMcpClientCredential(input.baseDir, body);
  fs.rmSync(pending.path, { force: true });
  return { paired: body, storePath };
}

type JsonRpcId = string | number | null;

function localErrorResponse(line: string, code: number, message: string): string | null {
  const error = (id: JsonRpcId) => ({ jsonrpc: "2.0", id, error: { code, message } });
  try {
    const parsed = JSON.parse(line) as unknown;
    const values = Array.isArray(parsed) ? parsed : [parsed];
    if (values.length === 0) return JSON.stringify(error(null));
    const responses: Array<ReturnType<typeof error>> = [];
    for (const value of values) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        responses.push(error(null));
        continue;
      }
      const record = value as Record<string, unknown>;
      const validId =
        typeof record.id === "string" || typeof record.id === "number" || record.id === null
          ? (record.id as JsonRpcId)
          : null;
      const validMessage = record.jsonrpc === "2.0" && typeof record.method === "string";
      if (validMessage && !("id" in record)) continue;
      responses.push(error(validId));
    }
    if (responses.length === 0) return null;
    return JSON.stringify(Array.isArray(parsed) ? responses : responses[0]);
  } catch {
    return JSON.stringify(error(null));
  }
}

function writeStream(stream: NodeJS.WritableStream, value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(value, (error?: Error | null) => (error ? reject(error) : resolve()));
  });
}

export async function serveExternalMcpStdio(input: {
  readonly baseDir: string;
  readonly integrationId?: string;
  readonly stdin?: NodeJS.ReadableStream;
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
  readonly fetchImpl?: ExternalMcpFetch;
}): Promise<void> {
  const stdin = input.stdin ?? process.stdin;
  const stdout = input.stdout ?? process.stdout;
  const stderr = input.stderr ?? process.stderr;
  const credential = readExternalMcpClientCredential(input.baseDir, input.integrationId);
  const lines = readline.createInterface({ input: stdin, crlfDelay: Infinity });
  const inFlight = new Set<Promise<void>>();
  let outputQueue = Promise.resolve();
  const emit = (stream: NodeJS.WritableStream, value: string) => {
    outputQueue = outputQueue.then(() => writeStream(stream, value));
    return outputQueue;
  };
  const handleLine = async (line: string) => {
    let response: Response;
    try {
      response = await fetchWithRestartRecovery({
        baseDir: input.baseDir,
        credential: credential.credential,
        body: line,
        ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      await emit(stderr, `[synara mcp] ${message}\n`);
      const body = localErrorResponse(line, -32603, message);
      if (body) await emit(stdout, `${body}\n`);
      return;
    }
    if (response.status === 202 || response.status === 204) return;
    let responseText: string;
    try {
      responseText = await readExternalMcpResponseText(response);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      await emit(stderr, `[synara mcp] ${message}\n`);
      const body = localErrorResponse(line, -32603, message);
      if (body) await emit(stdout, `${body}\n`);
      return;
    }
    if (response.status === 401) {
      const message =
        "Synara rejected the stored external MCP credential because it was revoked, expired, or replaced. Pair the integration again from Settings.";
      await emit(stderr, `[synara mcp] ${message}\n`);
      const body = localErrorResponse(line, -32001, message);
      if (body) await emit(stdout, `${body}\n`);
      return;
    }
    if (!response.ok) {
      if (responseText.trim()) {
        try {
          JSON.parse(responseText);
          await emit(stdout, `${responseText.trim()}\n`);
          return;
        } catch {
          // Fall through to a transport error that preserves request ids.
        }
      }
      const message = `Synara external MCP request failed with HTTP ${response.status}.`;
      await emit(stderr, `[synara mcp] ${message}\n`);
      const body = localErrorResponse(line, -32603, message);
      if (body) await emit(stdout, `${body}\n`);
      return;
    }
    if (responseText.trim()) await emit(stdout, `${responseText.trim()}\n`);
  };

  for await (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    while (inFlight.size >= MAX_IN_FLIGHT) await Promise.race(inFlight);
    let task: Promise<void>;
    task = handleLine(line).finally(() => inFlight.delete(task));
    inFlight.add(task);
  }
  await Promise.all(inFlight);
  await outputQueue;
}
