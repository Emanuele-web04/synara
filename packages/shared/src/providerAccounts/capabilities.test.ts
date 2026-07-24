import { describe, expect, it } from "vitest";

import { authCapabilities, supportLevelFor } from "./capabilities";

describe("authCapabilities", () => {
  it("returns the full matrix per provider", () => {
    expect(authCapabilities("codex")).toEqual({
      agent: { oauth: "supported", apiKey: "supported" },
      app: { oauth: "experimental", supportLevel: "experimental" },
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

  it("claude agent oauth is verified-only (beta), api key full", () => {
    expect(supportLevelFor("claudeAgent", "agent", "oauth")).toBe("beta");
    expect(supportLevelFor("claudeAgent", "agent", "apiKey")).toBe("supported");
  });

  it("cursor agent is api-key first with native-only oauth", () => {
    expect(supportLevelFor("cursor", "agent", "oauth")).toBe("unsupported");
    expect(supportLevelFor("cursor", "agent", "apiKey")).toBe("supported");
  });

  it("grok supports both agent auth methods fully", () => {
    expect(supportLevelFor("grok", "agent", "oauth")).toBe("supported");
    expect(supportLevelFor("grok", "agent", "apiKey")).toBe("supported");
  });

  it("app surfaces require oauth", () => {
    expect(supportLevelFor("codex", "app", "oauth")).toBe("experimental");
    expect(supportLevelFor("cursor", "app", "oauth")).toBe("beta");
    expect(supportLevelFor("codex", "app", "apiKey")).toBe("unsupported");
    expect(supportLevelFor("grok", "app", "oauth")).toBe("unsupported");
  });
});
