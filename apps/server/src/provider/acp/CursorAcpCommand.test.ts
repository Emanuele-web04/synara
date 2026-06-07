/**
 * CursorAcpCommand tests - regression coverage for Cursor CLI executable resolution.
 *
 * Protects the Cursor/Grok collision where the bare `agent` name can belong to
 * Grok while Cursor's current ACP-capable executable is `cursor-agent`.
 *
 * @module CursorAcpCommand.test
 */
import { describe, expect, it } from "vitest";

import { resolveCursorAgentBinaryPath } from "./CursorAcpCommand.ts";

describe("resolveCursorAgentBinaryPath", () => {
  it("defaults to cursor-agent when no binary is configured", () => {
    expect(resolveCursorAgentBinaryPath(undefined)).toBe("cursor-agent");
    expect(resolveCursorAgentBinaryPath(null)).toBe("cursor-agent");
    expect(resolveCursorAgentBinaryPath("   ")).toBe("cursor-agent");
  });

  it("maps the old ambiguous agent default to cursor-agent", () => {
    expect(resolveCursorAgentBinaryPath("agent")).toBe("cursor-agent");
    expect(resolveCursorAgentBinaryPath("  agent  ")).toBe("cursor-agent");
  });

  it("honors explicit custom Cursor binary paths", () => {
    expect(resolveCursorAgentBinaryPath("cursor-agent")).toBe("cursor-agent");
    expect(resolveCursorAgentBinaryPath("/usr/local/bin/agent")).toBe("/usr/local/bin/agent");
  });
});
