import { assert, describe, it } from "@effect/vitest";

import {
  appendCodexConfigSection,
  configHasTomlTableHeader,
  extractManagedCodexConfigSection,
  mergeShellEnvPolicyExclude,
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

  it("merges the token exclusion into a user-defined shell environment policy", () => {
    const withExclude = [
      "[shell_environment_policy]",
      'exclude = ["AWS_*"]',
      "",
      "[model]",
      'name = "gpt-5.5"',
    ].join("\n");
    const merged = mergeShellEnvPolicyExclude(withExclude, SYNARA_AGENT_GATEWAY_TOKEN_ENV);
    assert.include(merged, `exclude = ["${SYNARA_AGENT_GATEWAY_TOKEN_ENV}", "AWS_*"]`);

    // Idempotent: the var is not added twice.
    assert.equal(mergeShellEnvPolicyExclude(merged, SYNARA_AGENT_GATEWAY_TOKEN_ENV), merged);

    // A policy table without an exclude key gains one.
    const withoutExclude = ["[shell_environment_policy]", 'inherit = "core"'].join("\n");
    const gained = mergeShellEnvPolicyExclude(withoutExclude, SYNARA_AGENT_GATEWAY_TOKEN_ENV);
    assert.include(gained, `exclude = ["${SYNARA_AGENT_GATEWAY_TOKEN_ENV}"]`);
    assert.include(gained, 'inherit = "core"');

    // No policy table: unchanged (the managed section appends its own).
    assert.equal(
      mergeShellEnvPolicyExclude('[model]\nname = "gpt-5.5"', SYNARA_AGENT_GATEWAY_TOKEN_ENV),
      '[model]\nname = "gpt-5.5"',
    );
  });

  it("ignores commented and unrelated token references when merging shell exclusions", () => {
    const commentedExample = [
      "[shell_environment_policy]",
      `# exclude = ["${SYNARA_AGENT_GATEWAY_TOKEN_ENV}"]`,
      'exclude = ["AWS_*"]',
    ].join("\n");
    const mergedCommentedExample = mergeShellEnvPolicyExclude(
      commentedExample,
      SYNARA_AGENT_GATEWAY_TOKEN_ENV,
    );
    assert.include(
      mergedCommentedExample,
      `exclude = ["${SYNARA_AGENT_GATEWAY_TOKEN_ENV}", "AWS_*"]`,
    );

    const unrelatedString = [
      "[shell_environment_policy]",
      `note = "keep ${SYNARA_AGENT_GATEWAY_TOKEN_ENV} private"`,
      'exclude = ["AWS_*"]',
    ].join("\n");
    const mergedUnrelatedString = mergeShellEnvPolicyExclude(
      unrelatedString,
      SYNARA_AGENT_GATEWAY_TOKEN_ENV,
    );
    assert.include(
      mergedUnrelatedString,
      `exclude = ["${SYNARA_AGENT_GATEWAY_TOKEN_ENV}", "AWS_*"]`,
    );
  });

  it("recognizes only active exact entries in multiline shell exclusion arrays", () => {
    const existing = [
      "[shell_environment_policy]",
      "exclude = [",
      '  "AWS_*",',
      `  "${SYNARA_AGENT_GATEWAY_TOKEN_ENV}",`,
      "]",
    ].join("\n");
    assert.equal(mergeShellEnvPolicyExclude(existing, SYNARA_AGENT_GATEWAY_TOKEN_ENV), existing);

    const tokenOnlyInComment = [
      "[shell_environment_policy]",
      "exclude = [",
      `  # "${SYNARA_AGENT_GATEWAY_TOKEN_ENV}",`,
      '  "AWS_*",',
      "]",
    ].join("\n");
    const merged = mergeShellEnvPolicyExclude(tokenOnlyInComment, SYNARA_AGENT_GATEWAY_TOKEN_ENV);
    assert.include(merged, `exclude = ["${SYNARA_AGENT_GATEWAY_TOKEN_ENV}",`);
  });

  it("detects real TOML table headers, ignoring comments and strings", () => {
    assert.isTrue(
      configHasTomlTableHeader('[mcp_servers.synara]\nurl = "x"', "[mcp_servers.synara]"),
    );
    assert.isTrue(
      configHasTomlTableHeader("  [mcp_servers.synara]  # managed", "[mcp_servers.synara]"),
    );
    assert.isTrue(
      configHasTomlTableHeader("  [ mcp_servers.synara ]  # managed", "[mcp_servers.synara]"),
    );
    assert.isTrue(configHasTomlTableHeader("  [ mcp_servers . synara ]", "[mcp_servers.synara]"));
    assert.isTrue(configHasTomlTableHeader('[mcp_servers."synara"]', "[mcp_servers.synara]"));
    assert.isTrue(configHasTomlTableHeader("['mcp_servers'.'synara']", "[mcp_servers.synara]"));
    assert.isTrue(configHasTomlTableHeader('[mcp_servers."syn\\u0061ra"]', "[mcp_servers.synara]"));
    assert.isTrue(
      configHasTomlTableHeader('["shell_environment_policy"]', "[shell_environment_policy]"),
    );
    assert.isFalse(configHasTomlTableHeader('["mcp_servers.synara"]', "[mcp_servers.synara]"));
    assert.isFalse(configHasTomlTableHeader('[mcp_servers."syn\\qara"]', "[mcp_servers.synara]"));
    // A commented-out example block must not count as the table being present.
    assert.isFalse(configHasTomlTableHeader("# [mcp_servers.synara]", "[mcp_servers.synara]"));
    assert.isFalse(
      configHasTomlTableHeader('note = "see [mcp_servers.synara] docs"', "[mcp_servers.synara]"),
    );
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
