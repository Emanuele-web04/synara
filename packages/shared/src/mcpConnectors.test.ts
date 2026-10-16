import { describe, expect, it } from "vitest";

import {
  defaultMcpConnectorName,
  isMcpConnectorMentionPath,
  mcpConnectorMentionPath,
  providerSupportsMcpConnectors,
  serverNameFromMcpConnectorMentionPath,
  findMcpConnectorPreset,
  MCP_CONNECTOR_CATEGORIES,
  MCP_CONNECTOR_PRESETS,
  mcpConnectorServerName,
  mcpConnectorSlug,
  normalizeMcpConnectorUrl,
} from "./mcpConnectors";

describe("MCP_CONNECTOR_PRESETS", () => {
  it("has unique ids and endpoints on public HTTPS URLs", () => {
    const ids = MCP_CONNECTOR_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    const urls = MCP_CONNECTOR_PRESETS.map((preset) => preset.url);
    expect(new Set(urls).size).toBe(urls.length);
    for (const preset of MCP_CONNECTOR_PRESETS) {
      expect(normalizeMcpConnectorUrl(preset.url)).toEqual({ ok: true, url: preset.url });
      expect(preset.docsUrl.startsWith("https://")).toBe(true);
      // The id doubles as the server-name slug, so it must already be one.
      expect(mcpConnectorSlug(preset.id)).toBe(preset.id);
    }
  });

  it("files every preset on a shelf and leaves no shelf empty", () => {
    for (const category of MCP_CONNECTOR_CATEGORIES) {
      expect(MCP_CONNECTOR_PRESETS.some((preset) => preset.category === category)).toBe(true);
    }
  });

  it("marks presets that need the user's own OAuth app", () => {
    expect(findMcpConnectorPreset("slack")).toMatchObject({ requiresOwnApp: true });
    expect(findMcpConnectorPreset("supabase")?.requiresOwnApp).toBeUndefined();
  });

  it("leaves out vendors that refuse an unregistered client", () => {
    for (const id of ["figma", "github"]) {
      expect(findMcpConnectorPreset(id)).toBeUndefined();
    }
  });
});

describe("normalizeMcpConnectorUrl", () => {
  it("accepts HTTPS and drops the fragment", () => {
    expect(normalizeMcpConnectorUrl("  https://mcp.example.com/mcp#x ")).toEqual({
      ok: true,
      url: "https://mcp.example.com/mcp",
    });
  });

  it.each([
    ["", "Enter the server URL."],
    ["mcp.example.com", "Enter a full URL, like https://mcp.example.com/mcp."],
    ["http://mcp.example.com/mcp", "The URL must start with https://."],
    ["https://user:pass@mcp.example.com/mcp", "Remove the user name or password from the URL."],
    ["https://localhost/mcp", "Use the server's public address."],
  ])("rejects %j", (raw, reason) => {
    expect(normalizeMcpConnectorUrl(raw)).toEqual({ ok: false, reason });
  });
});

describe("connector names", () => {
  it("derives a readable default name from the host", () => {
    expect(defaultMcpConnectorName("https://mcp.acme.dev/mcp")).toBe("acme.dev");
    expect(defaultMcpConnectorName("https://www.acme.dev/mcp")).toBe("acme.dev");
    expect(defaultMcpConnectorName("https://api.acme.dev/v1/mcp/key")).toBe("acme.dev");
  });

  it("slugs names into provider-safe server names", () => {
    expect(mcpConnectorSlug("Acme Docs!")).toBe("acme_docs");
    expect(mcpConnectorSlug("42 tools")).toBe("mcp_42_tools");
    expect(mcpConnectorSlug("")).toBe("mcp");
    expect(mcpConnectorServerName("acme_docs")).toBe("acme_docs_connector");
  });

  it("never yields a name that passes for Synara's own server", () => {
    expect(mcpConnectorSlug("Synara")).toBe("custom_synara");
    expect(mcpConnectorSlug("synara tools").startsWith("synara")).toBe(false);
  });
});

describe("connector mentions", () => {
  it("round-trips the server name through the mention path", () => {
    const path = mcpConnectorMentionPath("supabase_connector");
    expect(path).toBe("connector://supabase_connector");
    expect(isMcpConnectorMentionPath(path)).toBe(true);
    expect(serverNameFromMcpConnectorMentionPath(path)).toBe("supabase_connector");
  });

  it("rejects paths that are not a valid server name", () => {
    expect(serverNameFromMcpConnectorMentionPath("plugin://linear@x")).toBeNull();
    expect(serverNameFromMcpConnectorMentionPath('connector://x" injected')).toBeNull();
    expect(serverNameFromMcpConnectorMentionPath("connector://")).toBeNull();
  });

  it("offers connectors only to providers whose sessions receive them", () => {
    expect(providerSupportsMcpConnectors("claudeAgent")).toBe(true);
    expect(providerSupportsMcpConnectors("codex")).toBe(true);
    for (const provider of ["pi", "devin", "antigravity"]) {
      expect(providerSupportsMcpConnectors(provider)).toBe(false);
    }
  });
});
