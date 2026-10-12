// FILE: inlineVisualEmbedContext.ts
// Purpose: Lets assistant markdown draw a visual where the reply places it (a fenced
//          `synara-visual` block naming the visual id) without importing the visual code.
// Layer: Chat transcript context
// Exports: InlineVisualEmbedContext

import { createContext, type ReactNode } from "react";

/**
 * Draws the visual with this id, or null when this transcript has no such
 * visual. Absent outside the transcript and inside a visual, where an embed
 * fence renders as plain code.
 */
export const InlineVisualEmbedContext = createContext<((visualId: string) => ReactNode) | null>(
  null,
);
