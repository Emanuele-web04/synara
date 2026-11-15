// FILE: useNewChatDefault.ts
// Purpose: The agent and account new chats start on, as a render-stable value.
// Layer: Web UI hook
// Exports: useNewChatDefault

import {
  type NewChatDefault,
  type NewChatDefaultSettings,
  resolveNewChatDefault,
} from "../appSettings";

/**
 * Resolves the new-chat default from the caller's app settings (from
 * `useAppSettings`). The result is cached per settings object and shared per
 * (agent, account) pair, so it keeps its identity across settings writes that do
 * not change the default and is safe as a memo dependency.
 */
export function useNewChatDefault(settings: NewChatDefaultSettings): NewChatDefault {
  return resolveNewChatDefault(settings);
}
