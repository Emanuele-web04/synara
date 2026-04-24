// FILE: useChatCodeFont.ts
// Purpose: Applies the optional chat-only code font family CSS variable from app settings.
// Layer: Web chat presentation hook
// Exports: useChatCodeFont

import { useEffect } from "react";
import { useAppSettings } from "../appSettings";
import { normalizeFontFamilyCssValue } from "../lib/fontFamily";

const CHAT_CODE_FONT_OVERRIDE_VARIABLE = "--app-font-chat-code-override";

export function useChatCodeFont() {
  const { settings } = useAppSettings();
  const chatCodeFontFamily = settings.chatCodeFontFamily;

  useEffect(() => {
    const cssFontFamily = normalizeFontFamilyCssValue(chatCodeFontFamily);
    if (cssFontFamily) {
      document.documentElement.style.setProperty(CHAT_CODE_FONT_OVERRIDE_VARIABLE, cssFontFamily);
    } else {
      document.documentElement.style.removeProperty(CHAT_CODE_FONT_OVERRIDE_VARIABLE);
    }
  }, [chatCodeFontFamily]);
}
