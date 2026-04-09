// FILE: terminalRuntimeTypes.test.ts
// Purpose: Cover stable runtime identity helpers without pulling browser-only runtime modules.
// Layer: Terminal runtime tests

import { describe, expect, it } from "vitest";

import { buildTerminalRuntimeKey } from "./terminalRuntimeTypes";

describe("buildTerminalRuntimeKey", () => {
  it("builds a thread-scoped runtime key for terminal persistence", () => {
    expect(buildTerminalRuntimeKey("thread-123", "terminal-abc")).toBe("thread-123::terminal-abc");
  });
});
