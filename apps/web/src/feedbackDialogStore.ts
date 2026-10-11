// FILE: feedbackDialogStore.ts
// Purpose: Owns the single explicit Feedback Synara dialog state.
// Layer: Web UI state

import { create } from "zustand";
import { FEEDBACK_CATEGORIES, type FeedbackCategory } from "./feedback";

interface FeedbackDialogStore {
  isOpen: boolean;
  initialCategory: FeedbackCategory | null;
  openDialog: (initialCategory?: FeedbackCategory) => void;
  setOpen: (open: boolean) => void;
}

export const useFeedbackDialogStore = create<FeedbackDialogStore>((set) => ({
  isOpen: false,
  initialCategory: null,
  openDialog: (initialCategory) =>
    set({
      isOpen: true,
      // An onClick event is never report data or a category.
      initialCategory: FEEDBACK_CATEGORIES.some((option) => option.value === initialCategory)
        ? (initialCategory ?? null)
        : null,
    }),
  setOpen: (open) => set(open ? { isOpen: true } : { isOpen: false, initialCategory: null }),
}));
