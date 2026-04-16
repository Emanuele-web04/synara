// FILE: chatThreadRoute.logic.ts
// Purpose: Keep route-level chat panel state transitions and fallbacks deterministic.
// Layer: Route UI logic helpers.
// Exports: thread title fallback, deep-link bootstrap replay handling, and panel toggle helpers.

import type { TurnId } from "@t3tools/contracts";

import type { ChatRightPanel, DiffRouteSearch } from "../diffRouteSearch";

export interface ChatPanelStateSnapshot {
  panel: ChatRightPanel | null;
  diffTurnId: TurnId | null;
  diffFilePath: string | null;
}

export interface ChatPanelStatePatch {
  panel?: ChatRightPanel | null;
  diffTurnId?: TurnId | null;
  diffFilePath?: string | null;
}

export interface RoutePanelBootstrapResult {
  nextAppliedSearchKey: string | null;
  panelPatch: ChatPanelStatePatch | null;
}

export function resolveThreadPickerTitle(title: string | null): string {
  return title || "New chat";
}

function createRoutePanelSearchKey(input: {
  scopeId: string;
  search: DiffRouteSearch;
}): string | null {
  const { scopeId, search } = input;
  if (
    search.panel === undefined &&
    search.diff === undefined &&
    search.diffTurnId === undefined &&
    search.diffFilePath === undefined
  ) {
    return null;
  }

  return JSON.stringify({
    scopeId,
    panel: search.panel ?? (search.diff ? "diff" : null),
    diffTurnId: search.diffTurnId ?? null,
    diffFilePath: search.diffFilePath ?? null,
  });
}

export function resolveRoutePanelBootstrap(input: {
  scopeId: string;
  search: DiffRouteSearch;
  lastAppliedSearchKey: string | null;
}): RoutePanelBootstrapResult {
  const nextAppliedSearchKey = createRoutePanelSearchKey({
    scopeId: input.scopeId,
    search: input.search,
  });

  if (nextAppliedSearchKey === null) {
    return {
      nextAppliedSearchKey: null,
      panelPatch: null,
    };
  }

  if (input.lastAppliedSearchKey === nextAppliedSearchKey) {
    return {
      nextAppliedSearchKey,
      panelPatch: null,
    };
  }

  return {
    nextAppliedSearchKey,
    panelPatch: {
      panel: input.search.panel ?? (input.search.diff ? "diff" : null),
      diffTurnId: input.search.diffTurnId ?? null,
      diffFilePath: input.search.diffFilePath ?? null,
    },
  };
}

export function resolveToggledChatPanelPatch(
  previousState: ChatPanelStateSnapshot,
  panel: ChatRightPanel,
): ChatPanelStatePatch {
  return {
    panel: previousState.panel === panel ? null : panel,
    diffTurnId: previousState.diffTurnId,
    diffFilePath: previousState.diffFilePath,
  };
}
