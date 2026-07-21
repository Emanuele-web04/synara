import { assert, describe, it } from "@effect/vitest";

import {
  buildMcpInitializeResult,
  negotiateMcpProtocolVersion,
  parseMcpMessage,
  MCP_DEFAULT_PROTOCOL_VERSION,
  type McpToolDefinition,
} from "./protocol.ts";

describe("agent gateway MCP protocol", () => {
  it("parses a JSON-RPC request with params", () => {
    const parsed = parseMcpMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "synara_list_threads" },
    });
    assert.equal(parsed.kind, "request");
    if (parsed.kind !== "request") return;
    assert.equal(parsed.request.method, "tools/call");
    assert.equal(parsed.request.params.name, "synara_list_threads");
  });

  it("classifies notifications by missing id", () => {
    const parsed = parseMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
    assert.deepEqual(parsed, { kind: "notification", method: "notifications/initialized" });
  });

  it("preserves a null JSON-RPC id as a request id", () => {
    const parsed = parseMcpMessage({ jsonrpc: "2.0", id: null, method: "tools/list" });
    assert.equal(parsed.kind, "request");
    if (parsed.kind !== "request") return;
    assert.isNull(parsed.request.id);
  });

  it("classifies client responses as ignorable", () => {
    const parsed = parseMcpMessage({ jsonrpc: "2.0", id: 5, result: {} });
    assert.deepEqual(parsed, { kind: "response" });
  });

  it("flags invalid messages and recovers the id when possible", () => {
    assert.deepEqual(parseMcpMessage("nope"), { kind: "invalid", id: null });
    assert.deepEqual(parseMcpMessage({ jsonrpc: "1.0", id: 3, method: "x" }), {
      kind: "invalid",
      id: 3,
    });
    for (const id of [true, [], { nested: true }]) {
      assert.deepEqual(parseMcpMessage({ jsonrpc: "2.0", id, method: "tools/call" }), {
        kind: "invalid",
        id: null,
      });
    }
  });

  it("negotiates supported protocol versions and falls back to the default", () => {
    assert.equal(negotiateMcpProtocolVersion("2025-03-26"), "2025-03-26");
    assert.equal(negotiateMcpProtocolVersion("1999-01-01"), MCP_DEFAULT_PROTOCOL_VERSION);
    assert.equal(negotiateMcpProtocolVersion(undefined), MCP_DEFAULT_PROTOCOL_VERSION);
  });

  it("builds an initialize result with tools capability and instructions", () => {
    const result = buildMcpInitializeResult({
      requestedProtocolVersion: "2025-06-18",
      serverVersion: "1.2.3",
      instructions: "use the tools",
    });
    assert.equal(result.protocolVersion, "2025-06-18");
    assert.deepEqual(result.capabilities, { tools: { listChanged: false } });
    assert.equal(result.instructions, "use the tools");
    assert.deepEqual(result.serverInfo, {
      name: "synara",
      title: "Synara App Control",
      version: "1.2.3",
    });
  });

  it("supports MCP tool annotations without changing protocol shaping", () => {
    const tool: McpToolDefinition = {
      name: "synara_context",
      description: "Inspect the current Synara harness context.",
      inputSchema: { type: "object" },
      annotations: {
        title: "Synara context",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    };
    assert.equal(tool.annotations?.title, "Synara context");
  });
});
