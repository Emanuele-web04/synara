// FILE: terminalThreads.test.ts
// Purpose: Verifies shared terminal identity helpers.
// Layer: Shared utility test

import { describe, expect, it } from "vitest";

import { resolveTerminalVisualIdentity } from "./terminalThreads";

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
