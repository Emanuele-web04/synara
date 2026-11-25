// FILE: lazyMarkdown.ts
// Purpose: Single memoized loader for `mdast-util-from-markdown`.
// Layer: Server shared helper
// Exports: loadFromMarkdown

import { lazyModule } from "./lazyModule.ts";

type MdastModule = typeof import("mdast-util-from-markdown");

/**
 * Loads `mdast-util-from-markdown` on first use (~28 ms saved on server boot,
 * since markdown AST parsing is only needed when staging assistant image
 * attachments or formatting completion notification previews).
 */
const loadMdastModule: () => Promise<MdastModule> = lazyModule(
  () => import("mdast-util-from-markdown"),
);

export async function loadFromMarkdown(): Promise<MdastModule["fromMarkdown"]> {
  const mod = await loadMdastModule();
  return mod.fromMarkdown;
}
