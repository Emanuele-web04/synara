// FILE: terminalThreadTitle.ts
// Purpose: Server-facing aliases around the shared terminal title parser.
// Layer: Server terminal helper
// Exports: generic-title checks plus incremental command parsing for thread renames.

export {
  GENERIC_TERMINAL_THREAD_TITLE,
  consumeTerminalIdentityInput as consumeTerminalThreadIdentityInput,
  consumeTerminalTitleInput as consumeTerminalThreadTitleInput,
  deriveTerminalCommandIdentity as deriveTerminalThreadCommandIdentity,
  deriveTerminalTitleFromCommand as deriveTerminalThreadTitleFromCommand,
  isGenericTerminalThreadTitle,
  resolveTerminalVisualIdentity,
} from "@t3tools/shared/terminalThreads";
