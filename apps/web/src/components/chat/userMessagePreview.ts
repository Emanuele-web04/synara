export const COLLAPSED_USER_MESSAGE_MAX_CHARS = 600;

export interface UserMessagePreviewState {
  text: string;
  collapsible: boolean;
  truncated: boolean;
}

export function deriveUserMessagePreviewState(
  text: string,
  options?: {
    expanded?: boolean;
    maxChars?: number;
  },
): UserMessagePreviewState {
  const expanded = options?.expanded ?? false;
  const requestedMaxChars = options?.maxChars;
  const safeMaxChars =
    typeof requestedMaxChars === "number" && Number.isFinite(requestedMaxChars)
      ? Math.floor(requestedMaxChars)
      : COLLAPSED_USER_MESSAGE_MAX_CHARS;
  const maxChars = Math.max(0, safeMaxChars);

  if (expanded || text.length <= maxChars) {
    return {
      text,
      collapsible: text.length > maxChars,
      truncated: false,
    };
  }

  return {
    text: text.slice(0, maxChars) + "…",
    collapsible: true,
    truncated: true,
  };
}
