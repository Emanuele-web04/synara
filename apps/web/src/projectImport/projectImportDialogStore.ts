import type { ProjectImportProvider } from "@synara/contracts";
import { create } from "zustand";

export const useProjectImportDialogStore = create<{
  isOpen: boolean;
  // preselected sources for the next open; null keeps the panel default
  initialProviders: readonly ProjectImportProvider[] | null;
  openDialog: (providers?: readonly ProjectImportProvider[]) => void;
  closeDialog: () => void;
}>((set) => ({
  isOpen: false,
  initialProviders: null,
  openDialog: (providers) => set({ isOpen: true, initialProviders: providers ?? null }),
  closeDialog: () => set({ isOpen: false }),
}));
