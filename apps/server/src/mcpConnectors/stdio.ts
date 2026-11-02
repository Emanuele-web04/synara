import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpConnectorTransport } from "@synara/contracts";
import { McpStdioTransport } from "../platform/mcpStdioTransport.ts";
import { jsonRpcErrorResult, type McpConnectorProxyResult } from "./proxy.ts";
import type { McpConnectorForwardRequest } from "./runtime.ts";

type StdioConfig = Extract<McpConnectorTransport, { transport: "stdio" }>;
class StdioUnavailable extends Error {}
interface StdioConnection {
  readonly client: Client;
  readonly transport: McpStdioTransport;
  readonly connectorId: string | null;
}
interface StdioSession {
  readonly connectorId: string;
  readonly owner: string;
  readonly client: Client;
  readonly transport: McpStdioTransport;
  touched: number;
  active: number;
  stopping: boolean;
  readonly requests: Map<string, AbortController>;
}

async function open(
  config: StdioConfig,
  owned: Set<StdioConnection>,
  connectorId: string | null,
): Promise<StdioConnection> {
  const client = new Client({ name: "Synara", version: "1.0.0" }, { capabilities: {} });
  const transport = new McpStdioTransport(config);
  const connection = { client, transport, connectorId };
  owned.add(connection);
  try {
    await client.connect(transport, { timeout: 5_000 });
    return connection;
  } catch {
    await transport.close();
    owned.delete(connection);
    throw new StdioUnavailable("The local MCP server is not running or did not initialize.");
  }
}

/** A separate subprocess per provider MCP session; credentials never cross session owners. */
export class StdioConnectorSessions {
  private readonly sessions = new Map<string, StdioSession>();
  private readonly retired = new Set<string>();
  private readonly starting = new Map<string, Set<Promise<McpConnectorProxyResult>>>();
  private readonly owned = new Set<StdioConnection>();
  private readonly probes = new Set<Promise<boolean>>();
  private opening = 0;
  private disposed = false;

  constructor(
    private readonly ownerActive: (token: string) => boolean,
    private readonly statusChanged: (connectorId: string, available: boolean) => Promise<void>,
  ) {}

  async probe(config: StdioConfig, connectorId: string | null = null): Promise<boolean> {
    if (this.disposed) throw new StdioUnavailable("The connector runtime is closed.");
    if (connectorId && this.retired.has(connectorId)) return false;
    const pending = this.probeConnection(config, connectorId);
    this.probes.add(pending);
    try {
      return await pending;
    } finally {
      this.probes.delete(pending);
    }
  }

  private async probeConnection(config: StdioConfig, connectorId: string | null): Promise<boolean> {
    let connection: Awaited<ReturnType<typeof open>>;
    try {
      connection = await open(config, this.owned, connectorId);
    } catch (error) {
      if (error instanceof StdioUnavailable) return false;
      throw error;
    }
    // Cleanup failure is not a successful connection or an ordinary offline server.
    await connection.transport.close();
    await connection.client.close();
    this.owned.delete(connection);
    return true;
  }

  async forward(
    connectorId: string,
    config: StdioConfig,
    request: McpConnectorForwardRequest,
  ): Promise<McpConnectorProxyResult> {
    const owner = request.ownerToken;
    if (!owner || !this.ownerActive(owner) || this.disposed || this.retired.has(connectorId))
      return jsonRpcErrorResult(request.body, "The MCP session is unavailable.", 403);
    if (request.method === "DELETE") {
      const session = request.sessionId ? this.sessions.get(request.sessionId) : undefined;
      if (!session || session.owner !== owner || session.connectorId !== connectorId)
        return { status: 404, sessionId: null, body: { kind: "empty" } };
      await this.close(request.sessionId!);
      return { status: 204, sessionId: null, body: { kind: "empty" } };
    }
    const body = request.body;
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      !("method" in body) ||
      typeof body.method !== "string" ||
      !JSONRPCMessageSchema.safeParse(body).success
    ) {
      return jsonRpcErrorResult(body, "Expected one MCP request.", 400);
    }
    const message = body as {
      method: string;
      id?: string | number;
      params?: Record<string, unknown>;
    };
    if (message.method === "initialize") {
      const pending = this.initialize(connectorId, config, request, message, owner);
      const starts = this.starting.get(connectorId) ?? new Set();
      this.starting.set(connectorId, starts);
      starts.add(pending);
      try {
        return await pending;
      } finally {
        starts.delete(pending);
        if (starts.size === 0) this.starting.delete(connectorId);
      }
    }
    const session = request.sessionId ? this.sessions.get(request.sessionId) : undefined;
    if (!session || session.owner !== owner || session.connectorId !== connectorId)
      return jsonRpcErrorResult(body, "The local MCP session expired. Start a new chat.", 404);
    session.touched = Date.now();
    if (message.id === undefined) {
      if (message.method === "notifications/cancelled") {
        session.requests.get(JSON.stringify(message.params?.requestId))?.abort();
        return { status: 202, sessionId: request.sessionId!, body: { kind: "empty" } };
      }
      if (message.method !== "notifications/initialized")
        await session.client.notification({
          method: message.method,
          ...(message.params ? { params: message.params } : {}),
        });
      return { status: 202, sessionId: request.sessionId!, body: { kind: "empty" } };
    }
    const requestKey = JSON.stringify(message.id);
    if (session.requests.has(requestKey))
      return jsonRpcErrorResult(body, "MCP request ID is already in use.", 400);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    session.requests.set(requestKey, controller);
    if (request.signal?.aborted) cancel();
    else request.signal?.addEventListener("abort", cancel, { once: true });
    try {
      session.active += 1;
      const result = await session.client.request(
        { method: message.method, ...(message.params ? { params: message.params } : {}) },
        ResultSchema,
        { timeout: 5 * 60_000, signal: controller.signal },
      );
      return {
        status: 200,
        sessionId: request.sessionId!,
        body: { kind: "json", value: { jsonrpc: "2.0", id: message.id, result } },
      };
    } catch {
      return jsonRpcErrorResult(body, "The local MCP request failed or was cancelled.");
    } finally {
      request.signal?.removeEventListener("abort", cancel);
      session.requests.delete(requestKey);
      session.active -= 1;
      session.touched = Date.now();
    }
  }

  private async initialize(
    connectorId: string,
    config: StdioConfig,
    request: McpConnectorForwardRequest,
    message: { id?: string | number },
    owner: string,
  ): Promise<McpConnectorProxyResult> {
    const body = request.body;
    if (this.sessions.size + this.opening >= 64)
      return jsonRpcErrorResult(body, "Too many local MCP sessions.");
    this.opening += 1;
    let connection: Awaited<ReturnType<typeof open>>;
    try {
      connection = await open(config, this.owned, connectorId);
    } catch (error) {
      if (error instanceof StdioUnavailable) await this.statusChanged(connectorId, false);
      throw error;
    } finally {
      this.opening -= 1;
    }
    if (
      request.signal?.aborted ||
      !this.ownerActive(owner) ||
      this.retired.has(connectorId) ||
      this.disposed
    ) {
      await connection.transport.close();
      await connection.client.close();
      this.owned.delete(connection);
      return jsonRpcErrorResult(body, "MCP request cancelled.");
    }
    const sessionId = randomUUID();
    const session: StdioSession = {
      ...connection,
      owner,
      connectorId,
      touched: Date.now(),
      active: 0,
      stopping: false,
      requests: new Map(),
    };
    this.sessions.set(sessionId, session);
    connection.client.onclose = () => {
      if (!session.stopping) void this.statusChanged(connectorId, false);
    };
    await this.statusChanged(connectorId, true);
    return {
      status: 200,
      sessionId,
      body: {
        kind: "json",
        value: {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: connection.client.getServerCapabilities() ?? {},
            serverInfo: connection.client.getServerVersion(),
          },
        },
      },
    };
  }

  private async close(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    session.stopping = true;
    for (const controller of session.requests.values()) controller.abort();
    await session.transport.close();
    await session.client.close();
    for (const connection of this.owned)
      if (connection.client === session.client) this.owned.delete(connection);
    this.sessions.delete(id);
  }

  async disconnect(connectorId: string): Promise<void> {
    this.retired.add(connectorId);
    await Promise.allSettled([...(this.starting.get(connectorId) ?? [])]);
    await Promise.all(
      [...this.sessions]
        .filter(([, session]) => session.connectorId === connectorId)
        .map(([id]) => this.close(id)),
    );
    // Also retain and retry handles from failed initialization or health probes.
    await Promise.all(
      [...this.owned]
        .filter((connection) => connection.connectorId === connectorId)
        .map(async (connection) => {
          await connection.transport.close();
          await connection.client.close();
          this.owned.delete(connection);
        }),
    );
  }

  async sweep(ownerActive: (token: string) => boolean): Promise<void> {
    await Promise.all(
      [...this.sessions]
        .filter(
          ([, session]) =>
            !ownerActive(session.owner) ||
            (session.active === 0 && Date.now() - session.touched > 30 * 60_000),
        )
        .map(([id]) => this.close(id)),
    );
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    // Keep every handle until teardown is proven, including failed initialization/probes.
    await Promise.allSettled([...this.starting.values()].flatMap((starts) => [...starts]));
    await Promise.allSettled([...this.probes]);
    await Promise.all(
      [...this.owned].map(async (connection) => {
        await connection.transport.close();
        await connection.client.close();
        this.owned.delete(connection);
      }),
    );
    this.sessions.clear();
  }
}
