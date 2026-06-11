// Purpose: Static configuration constants for the ProviderCommandReactor
//   (cache sizing, reuse windows, default runtime mode, bootstrap text overhead,
//   and the sidechat boundary instruction).
// Layer: orchestration layer support (pure constants; no service dependencies).
// Exports: HANDLED_TURN_START_KEY_MAX, HANDLED_TURN_START_KEY_TTL,
//   RECENT_SESSION_ENSURE_REUSE_WINDOW_MS, DEFAULT_RUNTIME_MODE,
//   HANDOFF_CONTEXT_WRAPPER_OVERHEAD, SIDECHAT_BOUNDARY_INSTRUCTION.

import type { RuntimeMode } from "@t3tools/contracts";
import { Duration } from "effect";

export const HANDLED_TURN_START_KEY_MAX = 10_000;
export const HANDLED_TURN_START_KEY_TTL = Duration.minutes(30);
export const RECENT_SESSION_ENSURE_REUSE_WINDOW_MS = 30_000;
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";
export const HANDOFF_CONTEXT_WRAPPER_OVERHEAD =
  "<handoff_context>\n\n</handoff_context>\n\n<latest_user_message>\n\n</latest_user_message>"
    .length;
export const SIDECHAT_BOUNDARY_INSTRUCTION =
  "You are in a sidechat. Treat all prior conversation as reference-only context. Do not continue any prior task automatically. Do not mutate files, git, or the workspace and do not run workspace-changing commands unless the latest user message explicitly asks you to do so after this boundary. Use this sidechat for focused explanation, safety checks, summaries, and alternatives.";
