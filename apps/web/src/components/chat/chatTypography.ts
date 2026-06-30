// FILE: chatTypography.ts
// Purpose: Centralizes transcript typography tokens shared by chat message renderers.
// Layer: Web chat presentation constants
// Exports: transcript measurement helpers and inline styles for chat text

import type { CSSProperties } from "react";
import { DEFAULT_CHAT_FONT_SIZE_PX, normalizeChatFontSizePx } from "../../appSettings";

export const USER_MESSAGE_BUBBLE_RADIUS_CLASS_NAME = "rounded-[var(--radius-user-message)]";
export const USER_MESSAGE_BUBBLE_SHELL_PADDING_CLASS_NAME = "py-1.5";
export const USER_MESSAGE_BUBBLE_SHELL_HORIZONTAL_PADDING_CLASS_NAME = "px-3";
export const USER_MESSAGE_BUBBLE_SHELL_CHROME_CLASS_NAME = [
  USER_MESSAGE_BUBBLE_SHELL_HORIZONTAL_PADDING_CLASS_NAME,
  USER_MESSAGE_BUBBLE_SHELL_PADDING_CLASS_NAME,
].join(" ");

const CHAT_TRANSCRIPT_USER_CHAR_WIDTH_RATIO = 0.48;
const CHAT_TRANSCRIPT_ASSISTANT_CHAR_WIDTH_RATIO = 0.52;
// Matches Tailwind `leading-relaxed` (1.625). Shared by the assistant transcript text,
// user message bubbles, and the composer input so every chat surface reads at one leading.
const CHAT_TRANSCRIPT_LINE_HEIGHT_RATIO = 1.625;

export function getChatTranscriptLineHeightPx(chatFontSizePx = DEFAULT_CHAT_FONT_SIZE_PX): number {
  return normalizeChatFontSizePx(chatFontSizePx) * CHAT_TRANSCRIPT_LINE_HEIGHT_RATIO;
}

export function getChatTranscriptUserMessageLineHeightPx(
  chatFontSizePx = DEFAULT_CHAT_FONT_SIZE_PX,
): number {
  return getChatTranscriptLineHeightPx(chatFontSizePx);
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

function buildChatTextStyle(fontSizePx: number, lineHeightPx: number): CSSProperties {
  return {
    fontSize: `${fontSizePx}px`,
    lineHeight: `${lineHeightPx}px`,
  };
}

export function getChatTranscriptTextStyle(
  chatFontSizePx = DEFAULT_CHAT_FONT_SIZE_PX,
): CSSProperties {
  const normalizedChatFontSizePx = normalizeChatFontSizePx(chatFontSizePx);
  return buildChatTextStyle(
    normalizedChatFontSizePx,
    getChatTranscriptLineHeightPx(normalizedChatFontSizePx),
  );
}

export function getChatTranscriptUserMessageTextStyle(
  chatFontSizePx = DEFAULT_CHAT_FONT_SIZE_PX,
): CSSProperties {
  const normalizedChatFontSizePx = normalizeChatFontSizePx(chatFontSizePx);
  return buildChatTextStyle(
    normalizedChatFontSizePx,
    getChatTranscriptUserMessageLineHeightPx(normalizedChatFontSizePx),
  );
}

export function getChatMessageFooterTextStyle(
  chatFontSizePx = DEFAULT_CHAT_FONT_SIZE_PX,
): CSSProperties {
  const normalizedChatFontSizePx = normalizeChatFontSizePx(chatFontSizePx);
  const footerFontSizePx = Math.max(8, normalizedChatFontSizePx - 2);
  return buildChatTextStyle(footerFontSizePx, getChatTranscriptLineHeightPx(footerFontSizePx));
}
