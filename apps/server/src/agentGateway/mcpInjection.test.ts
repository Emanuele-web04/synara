import { assert, describe, it } from "@effect/vitest";

import {
  appendCodexConfigSection,
  extractManagedCodexConfigSection,
  SYNARA_MANAGED_CODEX_CONFIG_BEGIN,
  SYNARA_MANAGED_CODEX_CONFIG_END,
} from "../codexProcessEnv.ts";
import {
  buildAcpSynaraMcpServers,
  buildClaudeMcpServers,
  buildCodexMcpConfigToml,
  SYNARA_AGENT_GATEWAY_TOKEN_ENV,
} from "./mcpInjection.ts";

const connection = {
  url: "http://127.0.0.1:3773/mcp",
  bearerToken: "sagw_abc.def",
};

const stdioProxy = {
  command: "/usr/local/bin/node",
  args: ["/state/agent-gateway-mcp-proxy.mjs"],
};

describe("agent gateway MCP injection", () => {
  it("builds a codex config block that references the token env var, not the token", () => {
    const block = buildCodexMcpConfigToml(connection.url);
    assert.include(block, "[mcp_servers.synara]");
    assert.include(block, `url = "${connection.url}"`);
    assert.include(block, `bearer_token_env_var = "${SYNARA_AGENT_GATEWAY_TOKEN_ENV}"`);
    assert.notInclude(block, connection.bearerToken);
  });

  it("appends the codex section once and keeps existing config intact", () => {
    const base = '[model]\nname = "gpt-5.5"\n';
    const section = buildCodexMcpConfigToml(connection.url);
    const appended = appendCodexConfigSection(base, section);
    assert.include(appended, '[model]\nname = "gpt-5.5"');
    assert.include(appended, "[mcp_servers.synara]");

    const reappended = appendCodexConfigSection(appended, section);
    assert.equal(reappended.split("[mcp_servers.synara]").length, 2);
  });

  it("round-trips the managed section through the overlay markers", () => {
    const section = buildCodexMcpConfigToml(connection.url);
    const overlayConfig = [
      '[model]\nname = "gpt-5.5"',
      "",
      SYNARA_MANAGED_CODEX_CONFIG_BEGIN,
      section,
      SYNARA_MANAGED_CODEX_CONFIG_END,
      "",
    ].join("\n");
    // A rewrite without appendConfigToml recovers the block so concurrent env
    // preps (version checks, text generation) don't strip the session's MCP entry.
    assert.equal(extractManagedCodexConfigSection(overlayConfig), section);
    assert.isUndefined(extractManagedCodexConfigSection('[model]\nname = "gpt-5.5"\n'));
  });

  it("builds a claude http server entry with the bearer header", () => {
    const servers = buildClaudeMcpServers(connection);
    assert.deepEqual(servers, {
      synara: {
        type: "http",
        url: connection.url,
        headers: { Authorization: `Bearer ${connection.bearerToken}` },
      },
    });
  });

  it("uses the ACP http transport when the agent advertises support", () => {
    const servers = buildAcpSynaraMcpServers({
      connection,
      initializeResult: { agentCapabilities: { mcpCapabilities: { http: true } } },
      stdioProxy,
    });
    assert.deepEqual(servers, [
      {
        type: "http",
        name: "synara",
        url: connection.url,
        headers: [{ name: "Authorization", value: `Bearer ${connection.bearerToken}` }],
      },
    ]);
  });

  it("falls back to the stdio proxy when http is not advertised", () => {
    const servers = buildAcpSynaraMcpServers({
      connection,
      initializeResult: {},
      stdioProxy,
    });
    assert.deepEqual(servers, [
      {
        name: "synara",
        command: stdioProxy.command,
        args: stdioProxy.args,
        env: [
          { name: "SYNARA_AGENT_GATEWAY_URL", value: connection.url },
          { name: SYNARA_AGENT_GATEWAY_TOKEN_ENV, value: connection.bearerToken },
        ],
      },
    ]);
  });
});
