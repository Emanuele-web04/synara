export const CHAT_WIDTH_MODES = ["standard", "wide", "full"] as const;
export type ChatWidthMode = (typeof CHAT_WIDTH_MODES)[number];

export const DEFAULT_CHAT_WIDTH: ChatWidthMode = "standard";

const CHAT_MAX_WIDTH_BY_MODE: Record<ChatWidthMode, string> = {
  standard: "46rem",
  wide: "72rem",
  full: "100%",
};

export function isChatWidthMode(value: unknown): value is ChatWidthMode {
  return typeof value === "string" && (CHAT_WIDTH_MODES as readonly string[]).includes(value);
}

export function normalizeChatWidthMode(
  value: unknown,
  fallback: ChatWidthMode = DEFAULT_CHAT_WIDTH,
): ChatWidthMode {
  return isChatWidthMode(value) ? value : fallback;
}

export function getChatWidthCssVariables(mode: ChatWidthMode = DEFAULT_CHAT_WIDTH) {
  return {
    "--app-chat-max-width": CHAT_MAX_WIDTH_BY_MODE[mode],
  } as const;
}

export type ChatWidthCssVariable = keyof ReturnType<typeof getChatWidthCssVariables>;
