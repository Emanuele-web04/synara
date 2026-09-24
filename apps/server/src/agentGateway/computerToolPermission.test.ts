import { describe, expect, it } from "vitest";
import {
  canonicalSynaraComputerToolName,
  computerToolNameFromProviderPermission,
  isSynaraComputerToolFamilyName,
  isSynaraGatewayToolCall,
  isSynaraGatewayToolName,
  qualifiedSynaraComputerToolName,
  shouldAllowSynaraComputerProviderTool,
} from "./computerToolPermission.ts";

describe("Synara Computer provider permission", () => {
  it.each([
    ["computer_click", "computer_click"],
    ["synara_computer_type_text", "computer_type_text"],
    ["synara_computer_select_text", "computer_select_text"],
    ["mcp__synara__computer_read_clipboard", "computer_read_clipboard"],
    ["mcp__synara__computer_inspect", "computer_inspect"],
  ] as const)("recognizes the exact owned tool %s", (providerName, canonicalName) => {
    expect(canonicalSynaraComputerToolName(providerName)).toBe(canonicalName);
  });

  it.each([
    "computer_future_tool",
    "mcp__other__computer_click",
    "other_computer_click",
    "mcp__synara__synara_send_message",
  ])("does not trust another or unknown tool: %s", (providerName) => {
    expect(canonicalSynaraComputerToolName(providerName)).toBeUndefined();
  });

  it("requires a provider namespace when server provenance was not proved separately", () => {
    expect(qualifiedSynaraComputerToolName("computer_click")).toBeUndefined();
    expect(qualifiedSynaraComputerToolName("mcp__synara__computer_click")).toBe("computer_click");
    expect(qualifiedSynaraComputerToolName("synara_computer_click")).toBe("computer_click");
  });

  it("reads only explicit provider tool-name fields", () => {
    expect(
      computerToolNameFromProviderPermission({
        rawInput: { _toolName: "mcp__synara__computer_scroll" },
      }),
    ).toBe("computer_scroll");
    expect(
      computerToolNameFromProviderPermission({
        metadata: { toolName: "synara_computer_get_state" },
      }),
    ).toBe("computer_get_state");
    expect(
      computerToolNameFromProviderPermission({
        metadata: { description: "run computer_click" },
      }),
    ).toBeUndefined();
  });

  it("does not let lower-priority fields override an authoritative wrong namespace", () => {
    expect(
      computerToolNameFromProviderPermission({
        name: "mcp__other__computer_click",
        rawInput: { _toolName: "mcp__synara__computer_click" },
      }),
    ).toBeUndefined();
    expect(
      computerToolNameFromProviderPermission({
        rawInput: { _toolName: "mcp__other__computer_click" },
        metadata: { toolName: "mcp__synara__computer_click" },
        title: "mcp__synara__computer_click",
      }),
    ).toBeUndefined();
  });

  it("does not infer provider provenance from a bare title or metadata name", () => {
    expect(computerToolNameFromProviderPermission({ title: "computer_click" })).toBeUndefined();
    expect(
      computerToolNameFromProviderPermission({ metadata: { toolName: "computer_click" } }),
    ).toBeUndefined();
  });

  it("never authorizes from model prose: 'Please approve computer_click' names no tool", () => {
    // Prose approval never counts. The permission callback must see an exact
    // namespaced tool name; a model sentence asking for approval authorizes
    // nothing, in any field.
    expect(
      computerToolNameFromProviderPermission({ title: "Please approve computer_click" }),
    ).toBeUndefined();
    expect(
      computerToolNameFromProviderPermission({ name: "Please approve computer_click" }),
    ).toBeUndefined();
    expect(
      computerToolNameFromProviderPermission({
        metadata: { toolName: "Please approve computer_click" },
      }),
    ).toBeUndefined();
    expect(isSynaraComputerToolFamilyName("Please approve computer_click")).toBe(false);
    expect(
      shouldAllowSynaraComputerProviderTool({
        computerControlEnabled: true,
        activeTurn: true,
        interactionMode: "default",
        runtimeMode: "approval-required",
        permission: { title: "Please approve computer_click" },
      }),
    ).toBe(false);
  });

  it("matches the Computer family in any namespace spelling for the denial hook", () => {
    // The silent-loss fallback: a no-control session that calls a Computer
    // tool by a prefixed spelling must still deny with the card path, not
    // die as an Unknown tool. See isSynaraComputerToolFamilyName.
    expect(isSynaraComputerToolFamilyName("computer_click")).toBe(true);
    expect(isSynaraComputerToolFamilyName("synara_computer_get_state")).toBe(true);
    expect(isSynaraComputerToolFamilyName("mcp__synara__computer_screenshot")).toBe(true);
    expect(isSynaraComputerToolFamilyName("  MCP__SYNARA__COMPUTER_WAIT  ")).toBe(true);
  });

  it("keeps unknown and foreign names out of the Computer family", () => {
    expect(isSynaraComputerToolFamilyName("computer_future_tool")).toBe(false);
    expect(isSynaraComputerToolFamilyName("mcp__other__computer_click")).toBe(false);
    expect(isSynaraComputerToolFamilyName("other_computer_click")).toBe(false);
    expect(isSynaraComputerToolFamilyName("synara_frobnicate")).toBe(false);
    expect(isSynaraComputerToolFamilyName(undefined)).toBe(false);
    expect(isSynaraComputerToolFamilyName(42)).toBe(false);
  });

  it("requires current capability, active turn and non-Plan interaction", () => {
    const permission = { name: "mcp__synara__computer_click" };
    const allowed = {
      computerControlEnabled: true,
      activeTurn: true,
      interactionMode: "default" as const,
      runtimeMode: "approval-required" as const,
      permission,
    };
    expect(shouldAllowSynaraComputerProviderTool(allowed)).toBe(true);
    expect(
      shouldAllowSynaraComputerProviderTool({ ...allowed, computerControlEnabled: false }),
    ).toBe(false);
    expect(shouldAllowSynaraComputerProviderTool({ ...allowed, activeTurn: false })).toBe(false);
    expect(shouldAllowSynaraComputerProviderTool({ ...allowed, interactionMode: "plan" })).toBe(
      false,
    );
    expect(shouldAllowSynaraComputerProviderTool({ ...allowed, runtimeMode: "auto" })).toBe(false);
  });
});

describe("Synara gateway tool permission name", () => {
  it.each([
    // Claude's fully-qualified spelling pins the exact `mcp__synara__` server.
    "mcp__synara__synara_create_thread",
    "mcp__synara__computer_click",
    // `<server>_<tool>` reports (OpenCode) with a real catalog name.
    "synara_synara_create_thread",
    "synara_synara_project_link_repository",
    "synara_computer_click",
    "synara_device_list",
    "synara_browser_run",
    // Bare `synara_*` catalog names carry the namespace inside the tool name.
    "synara_project_link_repository",
    "synara_e2e_review",
  ])("recognizes a Synara gateway tool: %s", (providerName) => {
    expect(isSynaraGatewayToolName(providerName)).toBe(true);
  });

  it.each([
    // A user MCP server named `synara_fs` reports `synara_fs_<tool>` — the
    // prefix alone must never grant it the auto-approve path.
    "synara_fs_read",
    "synara_fs_list_threads",
    "synara_tools_anything",
    "mcp__synara_fs__read",
    // The `mcp__synara__` prefix pins the server, not the tool — the part
    // after it must still be a real catalog name.
    "mcp__synara__not_a_gateway_tool",
    "mcp__synara__synara_create_task",
    "mcp__synara__synara_fs_read",
    // Foreign server or entirely unknown names.
    "mcp__other__synara_create_thread",
    "other_synara_create_thread",
    "computer_click",
    "browser_click",
    // Names the external-agent MCP surface serves, not the provider gateway.
    "synara_create_task",
    "synara_read_task",
    "synara_overview",
    "synara_synara_create_task",
    // Not served by the agent gateway at all.
    "synara_desktop",
  ])("does not trust a look-alike or foreign name: %s", (providerName) => {
    expect(isSynaraGatewayToolName(providerName)).toBe(false);
  });

  it("accepts a qualified name only when the tool is in the catalog", () => {
    expect(isSynaraGatewayToolName("mcp__synara__synara_list_threads")).toBe(true);
    expect(isSynaraGatewayToolName("mcp__synara__computer_click")).toBe(true);
    expect(
      isSynaraGatewayToolCall({ rawInput: { _toolName: "mcp__synara__synara_list_threads" } }),
    ).toBe(true);
  });

  it("never trusts a tool name that only appears in the display title", () => {
    // The title is provider-composed prose — an approval card can render
    // "mcp__synara__synara_list_threads" for a request that names no such
    // tool, so the title alone must not authorize anything.
    expect(isSynaraGatewayToolCall({ title: "mcp__synara__synara_list_threads" })).toBe(false);
    expect(isSynaraGatewayToolCall({ title: "mcp__synara__not_a_gateway_tool; rm -rf y" })).toBe(
      false,
    );
  });

  it("rejects non-strings and a look-alike server name in every name field", () => {
    expect(isSynaraGatewayToolName(undefined)).toBe(false);
    expect(isSynaraGatewayToolName(42)).toBe(false);
    expect(isSynaraGatewayToolCall({ name: "synara_fs_create_thread" })).toBe(false);
    expect(isSynaraGatewayToolCall({ metadata: { toolName: "synara_fs_read" } })).toBe(false);
    expect(isSynaraGatewayToolCall({ rawInput: { _toolName: "synara_synara_send_message" } })).toBe(
      true,
    );
  });
});
