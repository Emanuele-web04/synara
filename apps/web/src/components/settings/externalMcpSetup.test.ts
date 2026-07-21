import { describe, expect, it } from "vitest";

import {
  buildExternalMcpClientConfiguration,
  buildExternalMcpExamplePrompt,
  describeExternalMcpPermissions,
} from "./externalMcpSetup";

const stdio = {
  command: "/Applications/Synara.app/Contents/MacOS/Synara",
  args: [
    "server.js",
    "mcp",
    "serve",
    "--integration",
    "mcp_int_example",
    "--home-dir",
    "/tmp/Synara home",
  ],
  env: { ELECTRON_RUN_AS_NODE: "1" },
};

describe("external MCP guided setup", () => {
  it("builds copyable Codex and Claude Code commands without embedding a credential", () => {
    const codex = buildExternalMcpClientConfiguration("codex", stdio);
    const claude = buildExternalMcpClientConfiguration("claudeCode", stdio);

    expect(codex.value).toBe(
      "codex mcp add synara --env ELECTRON_RUN_AS_NODE=1 -- /Applications/Synara.app/Contents/MacOS/Synara server.js mcp serve --integration mcp_int_example --home-dir '/tmp/Synara home'",
    );
    expect(claude.value).toBe(
      "claude mcp add --scope user synara -e ELECTRON_RUN_AS_NODE=1 -- /Applications/Synara.app/Contents/MacOS/Synara server.js mcp serve --integration mcp_int_example --home-dir '/tmp/Synara home'",
    );
    expect(`${codex.value}${claude.value}`).not.toContain("syn_mcp_v1_");
  });

  it("builds standard JSON configuration for desktop and other clients", () => {
    const desktop = buildExternalMcpClientConfiguration("claudeDesktop", stdio);
    const parsed = JSON.parse(desktop.value) as {
      mcpServers: { synara: { command: string; args: ReadonlyArray<string> } };
    };

    expect(desktop.format).toBe("json");
    expect(parsed.mcpServers.synara).toEqual(stdio);
  });

  it("builds terminal commands for PowerShell on Windows", () => {
    const codex = buildExternalMcpClientConfiguration("codex", stdio, "Win32");
    expect(codex.value).toBe(
      "& 'codex' 'mcp' 'add' 'synara' '--env' 'ELECTRON_RUN_AS_NODE=1' '--' '/Applications/Synara.app/Contents/MacOS/Synara' 'server.js' 'mcp' 'serve' '--integration' 'mcp_int_example' '--home-dir' '/tmp/Synara home'",
    );
    expect(codex.instruction).toContain("PowerShell");
  });

  it("builds a project-specific prompt without exposing implementation identifiers", () => {
    const prompt = buildExternalMcpExamplePrompt("Synara app");

    expect(prompt).toContain('project named "Synara app"');
    expect(prompt).toContain("managed worktree");
    expect(prompt).toContain("approval-required");
    expect(prompt).not.toContain("projectId");
    expect(prompt).not.toContain("request ID");
    expect(prompt).not.toContain("mcp_int_");
  });

  it("describes scopes without exposing capability identifiers", () => {
    const description = describeExternalMcpPermissions([
      "projects:read",
      "tasks:create",
      "tasks:wait",
      "tasks:read",
      "runtime:local",
    ]);

    expect(description).toBe("Create and follow its own tasks · Use the shared local checkout");
    expect(description).not.toContain("runtime:local");
  });
});
