import { describe, expect, it } from "vitest";

import { authCapabilities, isConnectSupported, supportLevelFor } from "./capabilities";

describe("authCapabilities", () => {
  it("returns the full matrix per provider", () => {
    expect(authCapabilities("codex")).toEqual({
      agent: { oauth: "supported", apiKey: "supported" },
      app: { oauth: "unsupported", supportLevel: "unsupported" },
    });
    expect(authCapabilities("cursor").agent.oauth).toBe("unsupported");
    expect(authCapabilities("grok").app.supportLevel).toBe("unsupported");
  });
});

describe("supportLevelFor", () => {
  it("codex supports both agent auth methods fully", () => {
    expect(supportLevelFor("codex", "agent", "oauth")).toBe("supported");
    expect(supportLevelFor("codex", "agent", "apiKey")).toBe("supported");
  });

  it("claude agent is api-key only until managed oauth is implemented", () => {
    expect(supportLevelFor("claudeAgent", "agent", "oauth")).toBe("unsupported");
    expect(supportLevelFor("claudeAgent", "agent", "apiKey")).toBe("supported");
  });

  it("cursor agent is api-key first with native-only oauth", () => {
    expect(supportLevelFor("cursor", "agent", "oauth")).toBe("unsupported");
    expect(supportLevelFor("cursor", "agent", "apiKey")).toBe("supported");
  });

  it("grok agent is api-key only until managed oauth is implemented", () => {
    expect(supportLevelFor("grok", "agent", "oauth")).toBe("unsupported");
    expect(supportLevelFor("grok", "agent", "apiKey")).toBe("supported");
  });

  it("app surfaces stay unsupported until desktop isolation is proven", () => {
    expect(supportLevelFor("codex", "app", "oauth")).toBe("unsupported");
    expect(supportLevelFor("cursor", "app", "oauth")).toBe("unsupported");
    expect(supportLevelFor("codex", "app", "apiKey")).toBe("unsupported");
    expect(supportLevelFor("grok", "app", "oauth")).toBe("unsupported");
  });
});

describe("isConnectSupported", () => {
  it("rejects unsupported provider/surface/auth combinations", () => {
    expect(isConnectSupported("codex", "agent", "oauth")).toBe(true);
    expect(isConnectSupported("cursor", "agent", "apiKey")).toBe(true);
    expect(isConnectSupported("cursor", "agent", "oauth")).toBe(false);
    expect(isConnectSupported("codex", "app", "oauth")).toBe(false);
    expect(isConnectSupported("grok", "app", "oauth")).toBe(false);
  });
});
