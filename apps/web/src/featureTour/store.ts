import { Schema } from "effect";
import { create } from "zustand";

export const FEATURE_TOUR_STORAGE_KEY = "synara:feature-tour:since-0.9.2:v1";
export const FeatureTourSeenSchema = Schema.Array(Schema.String);
export const EMPTY_FEATURE_TOUR_SEEN: readonly string[] = [];

export const useFeatureTourStore = create<{
  replay: boolean;
  open: () => void;
  close: () => void;
}>((set) => ({
  replay: false,
  open: () => set({ replay: true }),
  close: () => set({ replay: false }),
}));
