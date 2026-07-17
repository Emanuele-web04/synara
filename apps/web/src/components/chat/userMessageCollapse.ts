// Keep the renderer and virtualization estimator on the same collapsed-message
// policy. The character threshold is only a first-paint overflow hint; rendered
// and estimated heights are both governed by the line limit.
export const COLLAPSED_USER_MESSAGE_MAX_CHARS = 600;
export const USER_MESSAGE_COLLAPSED_MAX_LINES = 12;
export const USER_MESSAGE_COLLAPSED_FADE_LINES = 2;

export function userMessageLikelyOverflows(text: string): boolean {
  if (text.length > COLLAPSED_USER_MESSAGE_MAX_CHARS) {
    return true;
  }

  let newlineCount = 0;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    newlineCount += 1;
    if (newlineCount >= USER_MESSAGE_COLLAPSED_MAX_LINES) {
      return true;
    }
  }
  return false;
}

export function resolveCollapsedUserMessageLineEstimate(estimatedLines: number): {
  renderedLines: number;
  collapsible: boolean;
} {
  const safeLines = Math.max(0, estimatedLines);
  return {
    renderedLines: Math.min(safeLines, USER_MESSAGE_COLLAPSED_MAX_LINES),
    collapsible: safeLines > USER_MESSAGE_COLLAPSED_MAX_LINES,
  };
}
