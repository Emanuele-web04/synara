// FILE: useDismissedThreadStatusKeys.ts
// Purpose: The thread status pills the user dismissed in the sidebar, for surfaces outside
//          it (the Inbox) that must not list what the sidebar stopped showing.
// Layer: Web hook over persisted sidebar UI state
// Exports: useDismissedThreadStatusKeys

import { useSyncExternalStore } from "react";

import {
  readSidebarUiStateSnapshot,
  subscribeSidebarUiStateWrites,
} from "../components/Sidebar.uiState";

const NO_DISMISSALS: Readonly<Record<string, string>> = {};

export function useDismissedThreadStatusKeys(): Readonly<Record<string, string>> {
  return useSyncExternalStore(
    subscribeSidebarUiStateWrites,
    () => readSidebarUiStateSnapshot().dismissedThreadStatusKeyByThreadId,
    () => NO_DISMISSALS,
  );
}
