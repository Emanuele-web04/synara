// Built-in composer vocabulary shared by parsing and telemetry schemas.
// Custom command names are deliberately excluded from this finite list.
/** Shared built-in vocabulary; custom command names never enter telemetry. */
export const BUILT_IN_COMPOSER_SLASH_COMMANDS = [
  "clear",
  "compact",
  "model",
  "plan",
  "debug",
  "default",
  "review",
  "fork",
  "side",
  "status",
  "subagents",
  "computer-use",
  "fast",
  "export",
  "goal",
  "rename",
  "feedback",
  "automation",
] as const;
