// FILE: useUiText.ts
// Purpose: Exposes fixed-interface translations for React components.

import { useCallback, useMemo } from "react";

import { useAppSettings } from "../appSettings";
import { resolveUiLanguage, translateUiText } from "../lib/uiLanguage";

export function useUiText(): (text: string) => string {
  const { settings } = useAppSettings();
  const language = useMemo(
    () => resolveUiLanguage(settings.uiLanguage),
    [settings.uiLanguage],
  );

  return useCallback((text: string) => translateUiText(language, text), [language]);
}
