/**
 * CursorAcpCommand tests - regression coverage for Cursor CLI executable/env resolution.
 *
 * Protects the Cursor/Grok collision where the bare `agent` name can belong to
 * Grok while Cursor's current ACP-capable executable is `cursor-agent`, and
 * keeps auth/status subprocesses browserless.
 *
 * @module CursorAcpCommand.test
 */
import { describe, expect, it } from "vitest";

import {
  buildCursorAgentCommand,
  buildCursorAgentHeadlessEnv,
  resolveCursorAgentBinaryPath,
} from "./CursorAcpCommand.ts";

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

describe("buildCursorAgentCommand", () => {
  it("runs default Cursor Agent commands directly", () => {
    expect(buildCursorAgentCommand(undefined, ["acp"])).toEqual({
      command: "cursor-agent",
      args: ["acp"],
    });
    expect(buildCursorAgentCommand("agent", ["models"])).toEqual({
      command: "cursor-agent",
      args: ["models"],
    });
  });

  it("normalizes Cursor editor launchers before appending agent args", () => {
    expect(
      buildCursorAgentCommand("cursor", ["acp"], {
        env: { PATH: "/tools" },
        pathExists: (path) => path === "/tools/cursor-agent",
      }),
    ).toEqual({
      command: "cursor-agent",
      args: ["acp"],
    });
    expect(
      buildCursorAgentCommand(
        "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
        ["models"],
        { pathExists: () => false },
      ),
    ).toEqual({
      command: "/Applications/Cursor.app/Contents/Resources/app/bin/agent",
      args: ["models"],
    });
    expect(
      buildCursorAgentCommand(
        "C:\\Users\\me\\AppData\\Local\\Programs\\Cursor\\bin\\cursor.cmd",
        ["--version"],
        { pathExists: () => false },
      ),
    ).toEqual({
      command: "C:\\Users\\me\\AppData\\Local\\Programs\\Cursor\\bin\\agent.cmd",
      args: ["--version"],
    });
    expect(
      buildCursorAgentCommand(
        "C:\\Users\\me\\AppData\\Local\\Programs\\Cursor\\bin\\cursor.cmd",
        ["--version"],
        {
          pathExists: (path) =>
            path === "C:\\Users\\me\\AppData\\Local\\Programs\\Cursor\\bin\\cursor-agent.exe",
        },
      ),
    ).toEqual({
      command: "C:\\Users\\me\\AppData\\Local\\Programs\\Cursor\\bin\\cursor-agent.exe",
      args: ["--version"],
    });
  });

  it("uses a sibling Cursor agent command when bare cursor has no cursor-agent peer", () => {
    expect(
      buildCursorAgentCommand("cursor", ["acp"], {
        env: { PATH: "/tools" },
        pathExists: (path) => path === "/tools/cursor" || path === "/tools/agent",
      }),
    ).toEqual({
      command: "/tools/agent",
      args: ["acp"],
    });
  });

  it("falls back to PATH cursor-agent before inventing an agent sibling", () => {
    expect(
      buildCursorAgentCommand("/missing/bin/cursor", ["acp"], {
        env: { PATH: "/tools" },
        pathExists: (path) => path === "/tools/cursor-agent",
      }),
    ).toEqual({
      command: "cursor-agent",
      args: ["acp"],
    });
  });

  it("prefers a sibling cursor-agent when a Cursor shim path is configured", () => {
    expect(
      buildCursorAgentCommand("/Users/me/.local/bin/cursor", ["acp"], {
        pathExists: (path) => path === "/Users/me/.local/bin/cursor-agent",
      }),
    ).toEqual({
      command: "/Users/me/.local/bin/cursor-agent",
      args: ["acp"],
    });
  });

  it("honors explicit agent paths without adding another subcommand", () => {
    expect(buildCursorAgentCommand("/Users/me/.local/bin/agent", ["acp"])).toEqual({
      command: "/Users/me/.local/bin/agent",
      args: ["acp"],
    });
    expect(buildCursorAgentCommand("/Users/me/.local/bin/cursor-agent", ["acp"])).toEqual({
      command: "/Users/me/.local/bin/cursor-agent",
      args: ["acp"],
    });
  });
});

describe("buildCursorAgentHeadlessEnv", () => {
  it("forces Cursor probe subprocesses into headless mode while preserving the base env", () => {
    expect(buildCursorAgentHeadlessEnv({ PATH: "/bin", BROWSER: "open" })).toMatchObject({
      PATH: "/bin",
      NO_BROWSER: "true",
      BROWSER: "www-browser",
      CI: "true",
      DEBIAN_FRONTEND: "noninteractive",
    });
  });
});
