import { afterEach, describe, expect, it, vi } from "vitest";

import { OutboundHttpError, outboundHttp } from "@synara/shared/outboundHttp";

import {
  forwardMcpConnectorRequest,
  jsonRpcErrorResult,
  jsonRpcRequestIds,
  probeMcpConnector,
  SseJsonRpcCollector,
} from "./proxy.ts";

const encode = (text: string) => new TextEncoder().encode(text);

afterEach(() => {
  vi.restoreAllMocks();
});

/** Replays `chunks` through the caller's stop hook like the real client does. */
function mockOutbound(input: {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly chunks: ReadonlyArray<string>;
}) {
  return vi.spyOn(outboundHttp, "request").mockImplementation(async (request) => {
    const headers = new Headers(input.headers);
    const received: string[] = [];
    for (const chunk of input.chunks) {
      received.push(chunk);
      if (request.stopReadingAfter?.(encode(chunk), headers)) break;
    }
    return {
      status: input.status,
      headers,
      body: encode(received.join("")),
      url: String(request.url),
    };
  });
}

describe("jsonRpcRequestIds", () => {
  it("keys requests and skips notifications and responses", () => {
    expect(
      jsonRpcRequestIds([
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { jsonrpc: "2.0", id: "a", method: "tools/call" },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, result: {} },
      ]),
    ).toEqual(["1", '"a"']);
  });
});

describe("SseJsonRpcCollector", () => {
  it("completes once every expected response arrived, across split chunks and CRLF", () => {
    const collector = new SseJsonRpcCollector(["1"]);
    expect(
      collector.push(encode('event: message\r\ndata: {"jsonrpc":"2.0","method":"note"}\r')),
    ).toBe(false);
    expect(collector.push(encode('\n\r\ndata: {"jsonrpc":"2.0",'))).toBe(false);
    expect(collector.push(encode('"id":1,"result":{"ok":true}}\n\n'))).toBe(true);
    expect(collector.responses()).toEqual([{ jsonrpc: "2.0", id: 1, result: { ok: true } }]);
    expect(collector.messages).toHaveLength(2);
  });

  it("joins multi-line data fields and reads a trailing event on finish", () => {
    const collector = new SseJsonRpcCollector(["7"]);
    collector.push(
      encode('data: {"jsonrpc":"2.0","id":7,\ndata: "error":{"code":1,"message":"x"}}'),
    );
    expect(collector.isComplete()).toBe(false);
    collector.finish();
    expect(collector.responses()).toEqual([
      { jsonrpc: "2.0", id: 7, error: { code: 1, message: "x" } },
    ]);
  });
});

describe("jsonRpcErrorResult", () => {
  it("answers each request id so the model reads the reason", () => {
    expect(jsonRpcErrorResult({ jsonrpc: "2.0", id: 3, method: "tools/call" }, "nope")).toEqual({
      status: 200,
      sessionId: null,
      body: {
        kind: "json",
        value: { jsonrpc: "2.0", id: 3, error: { code: -32001, message: "nope" } },
      },
    });
  });

  it("falls back to an HTTP status when nothing expects an answer", () => {
    expect(jsonRpcErrorResult(undefined, "gone", 404).status).toBe(404);
  });
});

describe("forwardMcpConnectorRequest", () => {
  const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "x" } };

  it("answers every requested id when an SSE batch ends with missing responses", async () => {
    mockOutbound({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      chunks: ['data: {"jsonrpc":"2.0","id":1,"result":{}}\n\n'],
    });
    const result = await forwardMcpConnectorRequest(
      { url: "https://mcp.example.com/mcp", method: "POST", body: [call, { ...call, id: 2 }] },
      "Example",
    );
    expect(result.body).toMatchObject({
      kind: "json",
      value: [
        { id: 1, error: expect.any(Object) },
        { id: 2, error: expect.any(Object) },
      ],
    });
  });

  it("collapses an SSE answer to its JSON-RPC response and keeps the session id", async () => {
    const spy = mockOutbound({
      status: 200,
      headers: { "content-type": "text/event-stream", "mcp-session-id": "sess-1" },
      chunks: [
        'data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n',
        'data: {"jsonrpc":"2.0","id":1,"result":{"content":[]}}\n\n',
        "data: never read\n\n",
      ],
    });
    const result = await forwardMcpConnectorRequest(
      {
        url: "https://mcp.example.com/mcp",
        method: "POST",
        body: call,
        sessionId: "sess-1",
        protocolVersion: "2025-06-18",
        accessToken: "tok",
      },
      "Example",
    );
    expect(result).toEqual({
      status: 200,
      sessionId: "sess-1",
      body: { kind: "json", value: { jsonrpc: "2.0", id: 1, result: { content: [] } } },
    });
    const headers = new Headers(spy.mock.calls[0]?.[0].headers);
    expect(headers.get("authorization")).toBe("Bearer tok");
    expect(headers.get("mcp-session-id")).toBe("sess-1");
    expect(headers.get("mcp-protocol-version")).toBe("2025-06-18");
    expect(spy.mock.calls[0]?.[0].policy).toMatchObject({
      service: "mcp-connector-proxy:https://mcp.example.com",
      allowedOrigins: ["https://mcp.example.com"],
      maxRedirects: 0,
      requirePublicAddress: true,
    });
  });

  it("passes JSON answers and statuses through", async () => {
    mockOutbound({
      status: 404,
      headers: { "content-type": "application/json" },
      chunks: ['{"error":"session not found"}'],
    });
    const result = await forwardMcpConnectorRequest(
      { url: "https://mcp.example.com/mcp", method: "POST", body: call },
      "Example",
    );
    expect(result).toEqual({
      status: 404,
      sessionId: null,
      body: { kind: "json", value: { error: "session not found" } },
    });
  });

  it("turns a timeout into a JSON-RPC error naming the connector", async () => {
    vi.spyOn(outboundHttp, "request").mockRejectedValue(
      new OutboundHttpError("timeout", "deadline"),
    );
    const result = await forwardMcpConnectorRequest(
      { url: "https://mcp.example.com/mcp", method: "POST", body: call },
      "Example",
    );
    expect(result.body).toEqual({
      kind: "json",
      value: {
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32001, message: "Example did not answer in time." },
      },
    });
  });
});

describe("probeMcpConnector", () => {
  it("reads the OAuth challenge from a 401", async () => {
    mockOutbound({
      status: 401,
      headers: {
        "www-authenticate":
          'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp", scope="read write"',
      },
      chunks: [],
    });
    await expect(
      probeMcpConnector("https://mcp.example.com/mcp", "Example", "1.0.0"),
    ).resolves.toEqual({
      kind: "oauth",
      resourceMetadataUrl: "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
      scope: "read write",
    });
  });

  it("treats an answered initialize as a server that needs no sign-in", async () => {
    mockOutbound({
      status: 200,
      headers: { "content-type": "application/json" },
      chunks: [
        '{"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2025-06-18","capabilities":{},"serverInfo":{"name":"Example","version":"1"}}}',
      ],
    });
    await expect(
      probeMcpConnector("https://mcp.example.com/mcp", "Example", "1.0.0"),
    ).resolves.toEqual({ kind: "open" });
  });

  it.each([
    [200, "text/html", "<html>Sign in</html>"],
    [
      200,
      "application/json",
      '{"jsonrpc":"2.0","id":0,"error":{"code":-32601,"message":"unknown method"}}',
    ],
    [200, "application/json", '{"jsonrpc":"2.0","id":99,"result":{}}'],
    [200, "application/json", '{"jsonrpc":"2.0","id":0,"result":{}}'],
    [202, "application/json", ""],
  ])(
    "refuses a successful HTTP status without an initialize result (%s %s)",
    async (status, contentType, body) => {
      mockOutbound({ status, headers: { "content-type": contentType }, chunks: [body] });
      expect(
        (await probeMcpConnector("https://mcp.example.com/mcp", "Example", "1.0.0")).kind,
      ).toBe("unavailable");
    },
  );

  it("explains a refusal", async () => {
    mockOutbound({ status: 403, headers: {}, chunks: [] });
    await expect(
      probeMcpConnector("https://mcp.example.com/mcp", "Example", "1.0.0"),
    ).resolves.toEqual({ kind: "unavailable", message: "Example refused the connection." });
  });
});
