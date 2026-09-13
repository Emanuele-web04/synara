import { describe, expect, it } from "vitest";

import { normalizeProviderCliAlias, providerCliCommandName } from "./providerCliProfiles";

describe("provider CLI profile names", () => {
  it("derives stable commands from instance ids rather than editable labels", () => {
    expect(providerCliCommandName({ provider: "claudeAgent", instanceId: "claude_work" })).toBe(
      "claude-work",
    );
    expect(providerCliCommandName({ provider: "codex", instanceId: "codex_personal" })).toBe(
      "codex-personal",
    );
    expect(providerCliCommandName({ provider: "cursor", instanceId: "cursor_team" })).toBe(
      "cursor-agent-team",
    );
  });

  it("gives default instances explicit names without replacing bare commands", () => {
    expect(providerCliCommandName({ provider: "claudeAgent", instanceId: "claudeAgent" })).toBe(
      "claude-default",
    );
    expect(providerCliCommandName({ provider: "antigravity", instanceId: "antigravity" })).toBe(
      "agy-default",
    );
  });

  it("accepts portable overrides and rejects shell syntax", () => {
    expect(
      providerCliCommandName({
        provider: "pi",
        instanceId: "pi_work",
        config: { cliAlias: "pairing-pi" },
      }),
    ).toBe("pairing-pi");
    expect(normalizeProviderCliAlias("claude work")).toBeUndefined();
    expect(normalizeProviderCliAlias("claude-work; rm -rf /")).toBeUndefined();
    expect(normalizeProviderCliAlias("claude")).toBeUndefined();
    expect(normalizeProviderCliAlias("codex")).toBeUndefined();
  });
});
