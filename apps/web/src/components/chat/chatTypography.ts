// FILE: chatTypography.ts
// Purpose: Centralizes transcript typography tokens shared by chat message renderers.
// Layer: Web chat presentation constants
// Exports: transcript measurement helpers and inline styles for chat text

import type { CSSProperties } from "react";
import { DEFAULT_CHAT_FONT_SIZE_PX, normalizeChatFontSizePx } from "../../appSettings";

const CHAT_TRANSCRIPT_USER_CHAR_WIDTH_RATIO = 0.48;
const CHAT_TRANSCRIPT_ASSISTANT_CHAR_WIDTH_RATIO = 0.52;

export function getChatTranscriptLineHeightPx(chatFontSizePx = DEFAULT_CHAT_FONT_SIZE_PX): number {
  return normalizeChatFontSizePx(chatFontSizePx) + 8;
}

export function getChatTranscriptUserCharWidthPx(
  chatFontSizePx = DEFAULT_CHAT_FONT_SIZE_PX,
): number {
  return normalizeChatFontSizePx(chatFontSizePx) * CHAT_TRANSCRIPT_USER_CHAR_WIDTH_RATIO;
}

export function getChatTranscriptAssistantCharWidthPx(
  chatFontSizePx = DEFAULT_CHAT_FONT_SIZE_PX,
): number {
  return normalizeChatFontSizePx(chatFontSizePx) * CHAT_TRANSCRIPT_ASSISTANT_CHAR_WIDTH_RATIO;
}

export function getChatTranscriptTextStyle(
  chatFontSizePx = DEFAULT_CHAT_FONT_SIZE_PX,
): CSSProperties {
  const normalizedChatFontSizePx = normalizeChatFontSizePx(chatFontSizePx);
  return {
    fontSize: `${normalizedChatFontSizePx}px`,
    lineHeight: `${getChatTranscriptLineHeightPx(normalizedChatFontSizePx)}px`,
  };
}
