// FILE: remoteProjectSpacesStore.ts
// Purpose: Persists the controlling computer's Space assignments for Remote projects.

import type { SpaceId } from "@synara/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { getExecutionStorage } from "./lib/hosts/executionStorage";
import { checkoutKey, type CheckoutRef } from "./lib/projectCatalog/model";

interface RemoteProjectSpacesState {
  spaceByCheckout: Readonly<Record<string, SpaceId>>;
  assignSpace: (checkout: CheckoutRef, spaceId: SpaceId) => void;
}

export const useRemoteProjectSpacesStore = create<RemoteProjectSpacesState>()(
  persist(
    (set) => ({
      spaceByCheckout: {},
      assignSpace: (checkout, spaceId) => {
        const key = checkoutKey(checkout);
        set((state) =>
          state.spaceByCheckout[key] === spaceId
            ? state
            : { spaceByCheckout: { ...state.spaceByCheckout, [key]: spaceId } },
        );
      },
    }),
    {
      name: "synara:remote-project-spaces:v1",
      storage: createJSONStorage(getExecutionStorage),
      partialize: ({ spaceByCheckout }) => ({ spaceByCheckout }),
    },
  ),
);
