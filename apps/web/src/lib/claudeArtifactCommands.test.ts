import { describe, expect, it } from "vitest";

import { getClaudeArtifactCommandNotice } from "./claudeArtifactCommands";

describe("getClaudeArtifactCommandNotice", () => {
  const base = { provider: "claudeAgent" as const, command: "design" };

  it("stays silent when artifacts are live or discovery has not reported yet", () => {
    expect(getClaudeArtifactCommandNotice({ ...base, artifacts: "available" })).toBeNull();
    expect(getClaudeArtifactCommandNotice({ ...base, artifacts: undefined })).toBeNull();
  });

  it("points at the setting while artifacts are off", () => {
    expect(getClaudeArtifactCommandNotice({ ...base, artifacts: "disabled" })).toContain(
      "Settings → Providers → Claude",
    );
  });

  it("explains account requirements when Claude refused artifacts", () => {
    expect(getClaudeArtifactCommandNotice({ ...base, artifacts: "unavailable" })).toContain(
      "claude.ai login",
    );
  });

  it("ignores other commands and providers", () => {
    expect(
      getClaudeArtifactCommandNotice({ ...base, artifacts: "disabled", command: "compact" }),
    ).toBeNull();
    expect(
      getClaudeArtifactCommandNotice({ ...base, artifacts: "disabled", provider: "codex" }),
    ).toBeNull();
  });
});
