// no fixed order can be relied on (each sheet opens from its own async probe) — first sheet takes the slot, others wait; confirming starts a follow-on flow so waiting sheets stay closed for this launch (not acknowledged → back next launch)

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
