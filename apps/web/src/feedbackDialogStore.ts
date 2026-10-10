import { create } from "zustand";

import type { FeedbackThreadContext } from "./feedback";

interface FeedbackDialogStore {
  isOpen: boolean;
  context: FeedbackThreadContext | null;
  openDialog: (context?: FeedbackThreadContext) => void;
  setOpen: (open: boolean) => void;
}

// Menu rows can wire this action straight into `onClick`, which hands it the
// click event at runtime whatever the declared type says. Only a real thread
// context may be stored; anything else falls back to `null` so the dialog
// keeps its live-thread default instead of serializing the event.
function isFeedbackThreadContext(value: unknown): value is FeedbackThreadContext {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.messageCount === "number" &&
    typeof candidate.activityCount === "number" &&
    typeof candidate.hasPendingApproval === "boolean" &&
    typeof candidate.hasPendingUserInput === "boolean" &&
    typeof candidate.hasThreadError === "boolean"
  );
}

export const useFeedbackDialogStore = create<FeedbackDialogStore>((set) => ({
  isOpen: false,
  context: null,
  openDialog: (context) =>
    set({ isOpen: true, context: isFeedbackThreadContext(context) ? context : null }),
  setOpen: (open) => set(open ? { isOpen: true } : { isOpen: false, context: null }),
}));
