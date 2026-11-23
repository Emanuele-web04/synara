import { create } from "zustand";

export const useDevinImportDialogStore = create<{
  isOpen: boolean;
  openDialog: () => void;
  closeDialog: () => void;
}>((set) => ({
  isOpen: false,
  openDialog: () => set({ isOpen: true }),
  closeDialog: () => set({ isOpen: false }),
}));
