// FILE: railShellStore.ts
// Purpose: Per-window state for the rail layout: the active rail item, which panel the
//          panel column shows (Home or Spaces), and the Spaces drill-in project.
// Layer: Web UI store (sessionStorage, modeled on spacesUiStore)

import type { ProjectId } from "@synara/contracts";
import { create } from "zustand";

import {
  RAIL_PANEL_ITEM_IDS,
  reconcileActiveRailItem,
  type RailItemId,
  type RailPanelItemId,
  type RailRouteItemId,
} from "./appRail.logic";

const STORAGE_KEY = "synara:rail-shell:v1";

interface PersistedRailShellState {
  activeItem: RailItemId;
  panelView: RailPanelItemId;
  spacesProjectId: ProjectId | null;
}

const DEFAULT_RAIL_SHELL_STATE: PersistedRailShellState = {
  activeItem: "home",
  panelView: "home",
  spacesProjectId: null,
};

function isRailPanelItemId(value: unknown): value is RailPanelItemId {
  return (RAIL_PANEL_ITEM_IDS as ReadonlyArray<unknown>).includes(value);
}

function readPersisted(): PersistedRailShellState {
  if (typeof window === "undefined") {
    return DEFAULT_RAIL_SHELL_STATE;
  }
  try {
    const parsed = JSON.parse(
      window.sessionStorage.getItem(STORAGE_KEY) ?? "null",
    ) as Partial<PersistedRailShellState> | null;
    const panelView = isRailPanelItemId(parsed?.panelView) ? parsed.panelView : "home";
    return {
      // The active item is re-derived from the route on mount (reconcile), so only a
      // valid panel item is worth restoring here.
      activeItem: panelView,
      panelView,
      spacesProjectId:
        typeof parsed?.spacesProjectId === "string" ? (parsed.spacesProjectId as ProjectId) : null,
    };
  } catch {
    return DEFAULT_RAIL_SHELL_STATE;
  }
}

function persist(state: PersistedRailShellState): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        activeItem: state.activeItem,
        panelView: state.panelView,
        spacesProjectId: state.spacesProjectId,
      }),
    );
  } catch {
    // A blocked storage API must not make the rail unusable.
  }
}

interface RailShellState extends PersistedRailShellState {
  /** Route of the last reconcile; the active item re-syncs only when it changes. */
  reconciledRouteKey: string | null;
  selectPanelItem: (id: RailPanelItemId) => void;
  selectRouteItem: (id: RailRouteItemId) => void;
  openSpacesProject: (projectId: ProjectId) => void;
  closeSpacesProject: () => void;
  /** `projectIds: null` means the project list is not hydrated yet, so the drill-in is kept. */
  reconcile: (input: {
    pathname: string;
    onStudioSurface: boolean;
    projectIds: ReadonlySet<ProjectId> | null;
  }) => void;
}

export const useRailShellStore = create<RailShellState>((set, get) => ({
  ...readPersisted(),
  reconciledRouteKey: null,
  selectPanelItem: (id) => {
    set({ activeItem: id, panelView: id });
    persist(get());
  },
  selectRouteItem: (id) => {
    set({ activeItem: id });
    persist(get());
  },
  openSpacesProject: (projectId) => {
    set({ spacesProjectId: projectId });
    persist(get());
  },
  closeSpacesProject: () => {
    set({ spacesProjectId: null });
    persist(get());
  },
  reconcile: ({ pathname, onStudioSurface, projectIds }) => {
    const current = get();
    // A clicked panel item stays active on a route item's route (Spaces while on Pull
    // requests); only a navigation re-syncs it.
    const routeKey = onStudioSurface ? `studio:${pathname}` : pathname;
    const activeItem =
      routeKey === current.reconciledRouteKey
        ? current.activeItem
        : reconcileActiveRailItem({
            current: current.activeItem,
            pathname,
            onStudioSurface,
            panelView: current.panelView,
          });
    const spacesProjectId =
      current.spacesProjectId !== null &&
      projectIds !== null &&
      !projectIds.has(current.spacesProjectId)
        ? null
        : current.spacesProjectId;
    if (
      activeItem === current.activeItem &&
      spacesProjectId === current.spacesProjectId &&
      routeKey === current.reconciledRouteKey
    ) {
      return;
    }
    set({ activeItem, spacesProjectId, reconciledRouteKey: routeKey });
    persist(get());
  },
}));
