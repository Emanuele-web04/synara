import { describe, expect, it } from "vitest";

import { getClaudeArtifactCommandNotice } from "./claudeArtifactCommands";

describe("getClaudeArtifactCommandNotice", () => {
  const base = { provider: "claudeAgent" as const, command: "design" };

  it("stays silent when artifacts are live or discovery has not reported yet", () => {
    expect(getClaudeArtifactCommandNotice({ ...base, artifacts: "available" })).toBeNull();
    expect(getClaudeArtifactCommandNotice({ ...base, artifacts: undefined })).toBeNull();
  });

  it("points at the setting while artifacts are off", () => {
    const notice = getClaudeArtifactCommandNotice({ ...base, artifacts: "disabled" });
    expect(notice?.summary).toContain("Settings → Providers → Claude");
    expect(notice?.detail).toContain("/design needs Claude Artifacts");
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
