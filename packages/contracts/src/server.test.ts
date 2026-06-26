import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { ServerProviderStatus } from "./server";

const decodeServerProviderStatus = Schema.decodeUnknownSync(ServerProviderStatus);

describe("ServerProviderStatus", () => {
  it("promotes legacy provider-only snapshots to the default provider instance", () => {
    const parsed = decodeServerProviderStatus({
      provider: "codex",
      status: "ready",
      available: true,
      authStatus: "authenticated",
      checkedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(parsed.provider).toBe("codex");
    expect(parsed.driver).toBe("codex");
    expect(parsed.instanceId).toBe("codex");
  });

  it("preserves exact instance identity for same-driver provider snapshots", () => {
    const parsed = decodeServerProviderStatus({
      provider: "claudeAgent",
      driver: "claudeAgent",
      instanceId: "claude_work",
      displayName: "Claude Work",
      status: "ready",
      available: true,
      authStatus: "authenticated",
      checkedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(parsed.provider).toBe("claudeAgent");
    expect(parsed.driver).toBe("claudeAgent");
    expect(parsed.instanceId).toBe("claude_work");
    expect(parsed.displayName).toBe("Claude Work");
  });
});
