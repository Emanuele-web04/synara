// FILE: announcementSheetSlot.ts
// Purpose: One shared slot so startup announcement sheets open one at a time.
// Layer: Web UI store
//
// Each announcement decides to open from its own asynchronous probe (desktop bridge,
// server config), so no fixed order can be relied on. The first sheet that wants to
// open takes the slot; the others wait and open after it is dismissed. Confirming a
// sheet starts its follow-on flow (a dialog, a Settings page), so the waiting sheets
// stay closed for the rest of this launch instead of covering that flow; they are not
// acknowledged, so they come back on the next one.

import { useEffect, useId } from "react";
import { create } from "zustand";

interface AnnouncementSheetSlotStore {
  owner: string | null;
  /** True once a sheet was confirmed; no further sheet opens during this launch. */
  handedOff: boolean;
  claim: (id: string) => void;
  release: (id: string) => void;
  handOff: () => void;
}

export const useAnnouncementSheetSlotStore = create<AnnouncementSheetSlotStore>((set) => ({
  owner: null,
  handedOff: false,
  claim: (id) => set((state) => (state.owner === null && !state.handedOff ? { owner: id } : state)),
  release: (id) => set((state) => (state.owner === id ? { owner: null } : state)),
  handOff: () => set({ handedOff: true }),
}));

/** `open` is true while this sheet wants to open and holds the slot. */
export function useAnnouncementSheetSlot(wantsOpen: boolean): {
  open: boolean;
  handOff: () => void;
} {
  const id = useId();
  const owner = useAnnouncementSheetSlotStore((state) => state.owner);
  const claim = useAnnouncementSheetSlotStore((state) => state.claim);
  const release = useAnnouncementSheetSlotStore((state) => state.release);
  const handOff = useAnnouncementSheetSlotStore((state) => state.handOff);

  // Re-runs when the owner changes, so a waiting sheet claims the slot once it frees.
  useEffect(() => {
    if (wantsOpen) claim(id);
    else release(id);
  }, [claim, id, owner, release, wantsOpen]);
  useEffect(() => () => release(id), [id, release]);

  return { open: wantsOpen && owner === id, handOff };
}
