// FILE: announcementSheetSlot.ts
// Purpose: One shared slot so startup announcement sheets open one at a time.
// Layer: Web UI store
//
// Each announcement decides to open from its own asynchronous probe (desktop bridge,
// server config), so no fixed order can be relied on. The first sheet that wants to
// open takes the slot; the others wait and open after it closes.

import { useEffect, useId } from "react";
import { create } from "zustand";

interface AnnouncementSheetSlotStore {
  owner: string | null;
  claim: (id: string) => void;
  release: (id: string) => void;
}

export const useAnnouncementSheetSlotStore = create<AnnouncementSheetSlotStore>((set) => ({
  owner: null,
  claim: (id) => set((state) => (state.owner === null ? { owner: id } : state)),
  release: (id) => set((state) => (state.owner === id ? { owner: null } : state)),
}));

/** True while this sheet wants to open and holds the slot. */
export function useAnnouncementSheetSlot(wantsOpen: boolean): boolean {
  const id = useId();
  const owner = useAnnouncementSheetSlotStore((state) => state.owner);
  const claim = useAnnouncementSheetSlotStore((state) => state.claim);
  const release = useAnnouncementSheetSlotStore((state) => state.release);

  // Re-runs when the owner changes, so a waiting sheet claims the slot once it frees.
  useEffect(() => {
    if (wantsOpen) claim(id);
    else release(id);
  }, [claim, id, owner, release, wantsOpen]);
  useEffect(() => () => release(id), [id, release]);

  return wantsOpen && owner === id;
}
