// FILE: proxy.ts
// Purpose: Forwards one MCP Streamable HTTP exchange from a provider session to a
//   connector's upstream server and returns a plain JSON answer.
// Layer: Connectors runtime (promise-based; driven by the McpConnectors layer)
// Exports: forwardMcpConnectorRequest, SseJsonRpcCollector, jsonRpcRequestIds,
//   jsonRpcErrorResult

import {
  OutboundHttpError,
  outboundHttp,
  type OutboundHttpPolicy,
  type OutboundHttpResponse,
} from "@synara/shared/outboundHttp";

export const MCP_CONNECTOR_PROXY_TIMEOUT_MS = 5 * 60_000;
export const MCP_CONNECTOR_PROXY_MAX_REQUEST_BYTES = 1024 * 1024;
export const MCP_CONNECTOR_PROXY_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
// Advertised by the probe; servers negotiate down when they need to.
export const MCP_CONNECTOR_PROTOCOL_VERSION = "2025-06-18";

export type McpConnectorProxyBody =
  | { readonly kind: "json"; readonly value: unknown }
  | { readonly kind: "text"; readonly value: string; readonly contentType: string }
  | { readonly kind: "empty" };

export interface McpConnectorProxyResult {
  readonly status: number;
  /** Upstream `Mcp-Session-Id`, passed back so the client keeps its session. */
  readonly sessionId: string | null;
  readonly body: McpConnectorProxyBody;
}

export interface McpConnectorUpstreamRequest {
  readonly url: string;
  readonly method: "POST" | "DELETE";
  /** Parsed JSON-RPC message (or legacy batch) for POST. */
  readonly body?: unknown;
  readonly sessionId?: string | undefined;
  readonly protocolVersion?: string | undefined;
  readonly accessToken?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const idKey = (id: unknown): string => JSON.stringify(id);

/** Keys of the request ids a POST expects answers for; notifications have none. */
export function jsonRpcRequestIds(body: unknown): string[] {
  const messages = Array.isArray(body) ? body : [body];
  return messages.flatMap((message) =>
    isRecord(message) &&
    typeof message.method === "string" &&
    "id" in message &&
    message.id !== null &&
    message.id !== undefined
      ? [idKey(message.id)]
      : [],
  );
}

/**
 * A JSON-RPC error for every request in `body`, so the model reads the reason
 * (HTTP-level failures surface to it as an opaque transport error).
 */
export function jsonRpcErrorResult(
  body: unknown,
  message: string,
  fallbackStatus = 502,
): McpConnectorProxyResult {
  const messages = Array.isArray(body) ? body : [body];
  const errors = messages.flatMap((entry) =>
    isRecord(entry) &&
    typeof entry.method === "string" &&
    "id" in entry &&
    entry.id !== null &&
    entry.id !== undefined
      ? [{ jsonrpc: "2.0", id: entry.id, error: { code: -32001, message } }]
      : [],
  );
  if (errors.length === 0) {
    return {
      status: fallbackStatus,
      sessionId: null,
      body: { kind: "json", value: { jsonrpc: "2.0", id: null, error: { code: -32001, message } } },
    };
  }
  return {
    status: 200,
    sessionId: null,
    body: { kind: "json", value: Array.isArray(body) ? errors : errors[0] },
  };
}

/**
 * Incremental `text/event-stream` reader that keeps the JSON-RPC messages
 * and reports when every expected response has arrived, so a stream the
 * server keeps open does not stall the proxy until its deadline.
 */
export class SseJsonRpcCollector {
  private readonly decoder = new TextDecoder();
  private readonly pending: Set<string>;
  private buffer = "";
  private carriageReturn = false;
  readonly messages: unknown[] = [];

  constructor(private readonly expectedIds: ReadonlyArray<string>) {
    this.pending = new Set(expectedIds);
  }

  /** Feeds one chunk; true once all expected responses were seen. */
  push(chunk: Uint8Array): boolean {
    let text = this.decoder.decode(chunk, { stream: true });
    if (this.carriageReturn) text = `\r${text}`;
    // A CRLF split across chunks must not read as two line breaks.
    this.carriageReturn = text.endsWith("\r");
    if (this.carriageReturn) text = text.slice(0, -1);
    this.buffer += text.replace(/\r\n?/gu, "\n");
    let boundary = this.buffer.indexOf("\n\n");
    while (boundary >= 0) {
      this.readEvent(this.buffer.slice(0, boundary));
      this.buffer = this.buffer.slice(boundary + 2);
      boundary = this.buffer.indexOf("\n\n");
    }
    return this.isComplete();
  }

  finish(): void {
    const rest = this.buffer + this.decoder.decode() + (this.carriageReturn ? "\n" : "");
    this.buffer = "";
    this.carriageReturn = false;
    if (rest.trim()) this.readEvent(rest.replace(/\r\n?/gu, "\n"));
  }

  isComplete(): boolean {
    return this.expectedIds.length > 0 && this.pending.size === 0;
  }

  /** Responses to the expected ids, in request order. */
  responses(): unknown[] {
    const byId = new Map<string, unknown>();
    for (const message of this.messages) {
      if (isRecord(message) && "id" in message && ("result" in message || "error" in message)) {
        byId.set(idKey(message.id), message);
      }
    }
    return this.expectedIds.flatMap((id) => (byId.has(id) ? [byId.get(id)] : []));
  }

  private readEvent(raw: string): void {
    const data = raw
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(line.startsWith("data: ") ? 6 : 5))
      .join("\n");
    if (!data.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
      this.messages.push(message);
      if (isRecord(message) && "id" in message && ("result" in message || "error" in message)) {
        this.pending.delete(idKey(message.id));
      }
    }
  }
}

// One admission gate per server: a slow vendor must not queue every other
// connector (or the Settings probe) behind its long-running tool calls.
function proxyPolicy(url: string): OutboundHttpPolicy {
  const origin = new URL(url).origin;
  return {
    service: `mcp-connector-proxy:${origin}`,
    allowedOrigins: [origin],
    timeoutMs: MCP_CONNECTOR_PROXY_TIMEOUT_MS,
    maxRequestBytes: MCP_CONNECTOR_PROXY_MAX_REQUEST_BYTES,
    maxResponseBytes: MCP_CONNECTOR_PROXY_MAX_RESPONSE_BYTES,
    maxRedirects: 0,
    maxConcurrent: 8,
    maxQueued: 64,
    requirePublicAddress: true,
  };
}

const isEventStream = (headers: Headers) =>
  (headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream");
const isJson = (headers: Headers) =>
  (headers.get("content-type") ?? "").toLowerCase().includes("json");

/**
 * Sends the exchange upstream. SSE answers are collapsed to their JSON-RPC
 * responses (the gateway has no standalone stream, so server-initiated
 * notifications in the stream are dropped). Network failures resolve to a
 * JSON-RPC error rather than throwing.
 */
export async function forwardMcpConnectorRequest(
  request: McpConnectorUpstreamRequest,
  displayName: string,
): Promise<McpConnectorProxyResult> {
  const requestIds = request.method === "POST" ? jsonRpcRequestIds(request.body) : [];
  const headers = new Headers({ accept: "application/json, text/event-stream" });
  if (request.method === "POST") headers.set("content-type", "application/json");
  if (request.sessionId) headers.set("mcp-session-id", request.sessionId);
  if (request.protocolVersion) headers.set("mcp-protocol-version", request.protocolVersion);
  if (request.accessToken) headers.set("authorization", `Bearer ${request.accessToken}`);

  let collector: SseJsonRpcCollector | undefined;
  let response: OutboundHttpResponse;
  try {
    response = await outboundHttp.request({
      policy: proxyPolicy(request.url),
      url: request.url,
      method: request.method,
      headers,
      ...(request.method === "POST" ? { body: JSON.stringify(request.body) } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
      stopReadingAfter: (chunk, responseHeaders) => {
        if (!isEventStream(responseHeaders)) return false;
        collector ??= new SseJsonRpcCollector(requestIds);
        return collector.push(chunk);
      },
    });
  } catch (cause) {
    const message =
      cause instanceof OutboundHttpError && cause.code === "timeout"
        ? `${displayName} did not answer in time.`
        : cause instanceof OutboundHttpError && cause.code === "response-too-large"
          ? `${displayName} sent a response larger than Synara accepts.`
          : `Synara could not reach ${displayName}.`;
    return jsonRpcErrorResult(request.body, message);
  }

  const sessionId = response.headers.get("mcp-session-id");
  if (isEventStream(response.headers) && response.status < 300) {
    collector ??= new SseJsonRpcCollector(requestIds);
    if (!collector.isComplete()) collector.finish();
    if (requestIds.length === 0) return { status: 202, sessionId, body: { kind: "empty" } };
    const responses = collector.responses();
    if (!collector.isComplete()) {
      return jsonRpcErrorResult(
        request.body,
        `${displayName} closed the stream without answering every request.`,
      );
    }
    return {
      status: 200,
      sessionId,
      body: { kind: "json", value: Array.isArray(request.body) ? responses : responses[0] },
    };
  }
  if (response.body.byteLength === 0) {
    return { status: response.status, sessionId, body: { kind: "empty" } };
  }
  const text = new TextDecoder().decode(response.body);
  if (isJson(response.headers)) {
    try {
      return {
        status: response.status,
        sessionId,
        body: { kind: "json", value: JSON.parse(text) },
      };
    } catch {
      // Fall through and pass the text along unchanged.
    }
  }
  return {
    status: response.status,
    sessionId,
    body: {
      kind: "text",
      value: text,
      contentType: response.headers.get("content-type") ?? "text/plain; charset=utf-8",
    },
  };
}

export type McpConnectorProbeResult =
  | { readonly kind: "open" }
  | {
      readonly kind: "oauth";
      readonly resourceMetadataUrl: string | undefined;
      readonly scope: string | undefined;
    }
  | { readonly kind: "unavailable"; readonly message: string };

function authenticateParameter(header: string, name: string): string | undefined {
  const match = new RegExp(`${name}="([^"]*)"`, "u").exec(header);
  return match?.[1] || undefined;
}

/** Sends an unauthenticated `initialize` to learn whether the server needs sign-in. */
export async function probeMcpConnector(
  url: string,
  displayName: string,
  clientVersion: string,
): Promise<McpConnectorProbeResult> {
  const body = {
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: MCP_CONNECTOR_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "Synara", version: clientVersion },
    },
  };
  let collector: SseJsonRpcCollector | undefined;
  let response: OutboundHttpResponse;
  try {
    response = await outboundHttp.request({
      policy: {
        ...proxyPolicy(url),
        service: "mcp-connector-probe",
        timeoutMs: 20_000,
        maxResponseBytes: 1024 * 1024,
      },
      url,
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      stopReadingAfter: (chunk, headers) => {
        if (!isEventStream(headers)) return false;
        collector ??= new SseJsonRpcCollector([idKey(0)]);
        return collector.push(chunk);
      },
    });
  } catch {
    return { kind: "unavailable", message: `Synara could not reach ${displayName}.` };
  }
  if (response.status === 401) {
    const challenge = response.headers.get("www-authenticate") ?? "";
    return {
      kind: "oauth",
      resourceMetadataUrl: authenticateParameter(challenge, "resource_metadata"),
      scope: authenticateParameter(challenge, "scope"),
    };
  }
  if (response.status >= 200 && response.status < 300) {
    // Close the anonymous session the probe opened, if the server keeps one.
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) {
      void forwardMcpConnectorRequest({ url, method: "DELETE", sessionId }, displayName);
    }
    let answer: unknown;
    if (isEventStream(response.headers)) {
      collector?.finish();
      answer = collector?.responses()[0];
    } else if (isJson(response.headers)) {
      try {
        answer = JSON.parse(new TextDecoder().decode(response.body));
      } catch {
        /* Not an MCP response. */
      }
    }
    // A website, login page, 202 stream acknowledgement or JSON-RPC error
    // must not be saved as a connected MCP server.
    const result = isRecord(answer) ? answer.result : undefined;
    if (
      isRecord(answer) &&
      answer.jsonrpc === "2.0" &&
      answer.id === 0 &&
      !("error" in answer) &&
      isRecord(result) &&
      typeof result.protocolVersion === "string" &&
      isRecord(result.capabilities) &&
      isRecord(result.serverInfo) &&
      typeof result.serverInfo.name === "string" &&
      typeof result.serverInfo.version === "string"
    ) {
      return { kind: "open" };
    }
    return {
      kind: "unavailable",
      message: `${displayName} did not return a valid MCP initialize response.`,
    };
  }
  if (response.status === 403) {
    return { kind: "unavailable", message: `${displayName} refused the connection.` };
  }
  if (response.status === 404 || response.status === 405) {
    return { kind: "unavailable", message: `No MCP server answered at this URL.` };
  }
  return {
    kind: "unavailable",
    message: `${displayName} answered with HTTP ${response.status}.`,
  };
}
