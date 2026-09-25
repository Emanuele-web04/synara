import { describe, expect, it } from "vitest";
import {
  canonicalSynaraComputerToolName,
  computerToolNameFromProviderPermission,
  isSynaraComputerToolFamilyName,
  qualifiedSynaraComputerToolName,
  shouldAllowSynaraComputerProviderTool,
} from "./computerToolPermission.ts";

describe("Synara Computer provider permission", () => {
  it.each([
    ["computer_click", "computer_click"],
    ["synara_computer_type_text", "computer_type_text"],
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
