import { describe, expect, it } from "vitest";

import { assistantItemId } from "./AcpSessionRuntime.ts";

describe("assistantItemId", () => {
  // Format contract only — distinct runtimeInstanceId wiring is covered by
  // AcpJsonRpcConnection.test.ts ("assigns distinct fallback assistant item ids...").
  it("produces distinct ids across runtime instances with the same session id and segment index", () => {
    const sessionId = "session-1";
    const a = assistantItemId(sessionId, "aaaa1111", 0);
    const b = assistantItemId(sessionId, "bbbb2222", 0);
    expect(a).not.toBe(b);
    expect(a).toBe("assistant:session-1:aaaa1111:segment:0");
    expect(b).toBe("assistant:session-1:bbbb2222:segment:0");
  });
});
