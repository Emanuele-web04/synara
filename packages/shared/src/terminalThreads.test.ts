// FILE: terminalThreads.test.ts
// Purpose: Verifies shared terminal identity helpers.
// Layer: Shared utility test

import { describe, expect, it } from "vitest";

import {
  deriveTerminalCommandIdentity,
  deriveTerminalOutputIdentity,
  deriveTerminalProcessIdentity,
  deriveTerminalTitleSignalIdentity,
  resolveTerminalVisualIdentity,
  terminalCliKindFromValue,
} from "./terminalThreads";

describe("Antigravity CLI identity", () => {
  it.each(["agy", "antigravity", "antigravity-cli"])(
    "detects the %s command",
    (command) => {
      expect(deriveTerminalCommandIdentity(command)).toEqual({
        cliKind: "antigravity",
        iconKey: "antigravity",
        title: "Antigravity CLI",
      });
    },
  );

  it("detects the Antigravity CLI process, banner, and terminal title", () => {
    expect(deriveTerminalProcessIdentity("/Users/dev/.local/bin/agy --model fast")).toMatchObject({
      cliKind: "antigravity",
      iconKey: "antigravity",
    });
    expect(deriveTerminalOutputIdentity("Welcome to Antigravity CLI")).toMatchObject({
      cliKind: "antigravity",
      title: "Antigravity CLI",
    });
    expect(deriveTerminalTitleSignalIdentity("AGY CLI")).toMatchObject({
      cliKind: "antigravity",
      title: "Antigravity CLI",
    });
  });

  it("normalizes persisted Antigravity CLI metadata", () => {
    expect(terminalCliKindFromValue(" antigravity ")).toBe("antigravity");
    expect(
      resolveTerminalVisualIdentity({
        cliKind: "antigravity",
        fallbackTitle: "Terminal 1",
      }),
    ).toMatchObject({
      cliKind: "antigravity",
      iconKey: "antigravity",
      title: "Antigravity CLI",
    });
  });
});

describe("resolveTerminalVisualIdentity", () => {
  it("treats explicit null cliKind as a generic terminal even when the title looks provider-like", () => {
    expect(
      resolveTerminalVisualIdentity({
        cliKind: null,
        fallbackTitle: "Terminal 1",
        title: "Codex 1",
      }),
    ).toMatchObject({
      cliKind: null,
      iconKey: "terminal",
      title: "Codex 1",
    });
  });

  it("still infers provider identity from title when cliKind is omitted", () => {
    expect(
      resolveTerminalVisualIdentity({
        fallbackTitle: "Terminal 1",
        title: "Claude Code",
      }),
    ).toMatchObject({
      cliKind: "claude",
      iconKey: "claude",
      title: "Claude Code",
    });
  });
});
