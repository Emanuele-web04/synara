import { useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";

import type { UiLocale } from "@synara/contracts";

import { useTranslation } from "~/i18n";
import { UI_LOCALES } from "~/i18n/locale";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import {
  editorNlsLocale,
  getLoadedEditorLanguage,
  subscribeToEditorLanguage,
} from "./editorLocalization";
import { reloadEditorAfterSave } from "./editorRecovery";

/** Only engine-owned controls need a new document; Synara's UI switches live. */
export function EditorLanguageReloadNotice() {
  const { t, locale } = useTranslation();
  const client = useQueryClient();
  const [reloading, setReloading] = useState(false);
  const editorLanguage = useSyncExternalStore(
    subscribeToEditorLanguage,
    getLoadedEditorLanguage,
    getLoadedEditorLanguage,
  );
  const interfaceLanguage = UI_LOCALES.includes(locale as UiLocale)
    ? editorNlsLocale(locale as UiLocale)
    : "en";
  if (editorLanguage === null || editorLanguage === interfaceLanguage) return null;

  const reload = async () => {
    if (reloading) return;
    setReloading(true);
    try {
      await reloadEditorAfterSave(client);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: t("workspace:editorReloadFailed"),
        description: error instanceof Error ? error.message : t("workspace:editorDraftPreserved"),
      });
    } finally {
      setReloading(false);
    }
  };

  return (
    <span className="flex flex-wrap items-center gap-2" aria-live="polite">
      <span>{t("settings:editorLanguageReloadNotice")}</span>
      <Button size="xs" variant="outline" disabled={reloading} onClick={() => void reload()}>
        {t("settings:editorLanguageSaveAndReload")}
      </Button>
    </span>
  );
}
