import type { ProviderArtifactsState, ProviderKind } from "@synara/contracts";

// Claude Code keeps the Artifact tool off for embedded (Agent SDK) sessions unless the host opts in
const CLAUDE_ARTIFACT_COMMANDS = new Set(["design", "slides"]);

export interface ProviderCommandNotice {
  readonly summary: string;
  readonly detail: string;
}

export function getClaudeArtifactCommandNotice(input: {
  readonly provider: ProviderKind;
  readonly command: string;
  readonly artifacts: ProviderArtifactsState | undefined;
}): ProviderCommandNotice | null {
  if (input.provider !== "claudeAgent" || !CLAUDE_ARTIFACT_COMMANDS.has(input.command)) {
    return null;
  }
  switch (input.artifacts) {
    case "disabled":
      return {
        summary: "Artifacts are off. Turn them on in Settings → Providers → Claude.",
        detail: `/${input.command} needs Claude Artifacts, which are off in Synara sessions by default. Turn on "Artifacts, /design and /slides" in Settings → Providers → Claude, then start a new session.`,
      };
    case "unavailable":
      return {
        summary: "Artifacts are unavailable for this Claude account or version.",
        detail: `Artifacts are on but Claude did not enable them for this session. They need a claude.ai login on a Pro, Max, Team or Enterprise plan and Claude Code 2.1.234 or later.`,
      };
    default:
      return null;
  }
}
