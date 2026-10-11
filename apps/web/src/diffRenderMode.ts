import * as Schema from "effect/Schema";

export const DiffRenderModeSchema = Schema.Literals(["stacked", "split"]);
export type DiffRenderMode = typeof DiffRenderModeSchema.Type;
export const DEFAULT_DIFF_RENDER_MODE: DiffRenderMode = "split";
// Keep the existing global preference as the Settings default. Thread toggles
// use a separate store, so upgrading preserves an already-selected layout.
export const DIFF_RENDER_MODE_STORAGE_KEY = "synara:diff-render-mode:v1";
