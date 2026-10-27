import { useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useTranslation } from "~/i18n";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { getLoadedEditorLanguage, subscribeToEditorLanguage } from "./editorLocalization";
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
  if (editorLanguage === null || editorLanguage === locale) return null;

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
