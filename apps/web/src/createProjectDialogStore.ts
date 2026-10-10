// FILE: createProjectDialogStore.ts
// Purpose: Owns whether the sidebar's Create project dialog is open, so other surfaces (the
//          composer's project picker) open the same dialog and flow instead of a copy.
// Layer: Web UI state

import { create } from "zustand";

interface CreateProjectDialogStore {
  isOpen: boolean;
  setOpen: (open: boolean) => void;
}

export const useCreateProjectDialogStore = create<CreateProjectDialogStore>((set) => ({
  isOpen: false,
  setOpen: (open) => set({ isOpen: open }),
}));
