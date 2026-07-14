import { describe, expect, it } from "vitest";

import { wrapCanvasAgentContext } from "./canvasAgentContext";

describe("wrapCanvasAgentContext", () => {
  it("injects bounded drawing rules without scene or capability data", () => {
    const result = wrapCanvasAgentContext({ threadId: "drawing-1", messageText: "画 TCP/IP 图" });
    expect(result).toContain('drawing_id="drawing-1"');
    expect(result).toContain("ask exactly one focused clarification question");
    expect(result).toContain("Call read_me before your first drawing operation");
    expect(result).toContain("画 TCP/IP 图");
    expect(result).not.toContain("BRIDGE_TOKEN");
  });
});
