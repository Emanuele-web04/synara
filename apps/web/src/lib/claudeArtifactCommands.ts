import { t } from "~/i18n";
import type { ProviderArtifactsState, ProviderKind } from "@synara/contracts";

// Claude commands that publish a claude.ai Artifact. Claude Code keeps the
// Artifact tool off for embedded (Agent SDK) sessions unless the host opts in.
const CLAUDE_ARTIFACT_COMMANDS = new Set(["design", "slides"]);

export interface ProviderCommandNotice {
  /** One line shown in the command row, so keyboard users read it without hovering. */
  readonly summary: string;
  /** Full explanation for the warning tooltip. */
  readonly detail: string;
}

/** Why a Claude artifact command cannot publish right now, or null when it can. */
export function getClaudeArtifactCommandNotice(
  input: {
    readonly provider: ProviderKind;
    readonly command: string;
    /** Reported by command discovery; undefined while unknown, which stays silent. */
    readonly artifacts: ProviderArtifactsState | undefined;
  },
  translate: typeof t = t,
): ProviderCommandNotice | null {
  if (input.provider !== "claudeAgent" || !CLAUDE_ARTIFACT_COMMANDS.has(input.command)) {
    return null;
  }
  switch (input.artifacts) {
    case "disabled":
      return {
        summary: translate("chat:claudeArtifactsOff"),
        detail: translate("chat:claudeArtifactsOffDetail", { command: input.command }),
      };
    case "unavailable":
      return {
        summary: translate("chat:claudeArtifactsUnavailable"),
        detail: translate("chat:claudeArtifactsUnavailableDetail"),
      };
    default:
      return null;
  }
}
