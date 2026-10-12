import { useQuery } from "@tanstack/react-query";
import { Schema } from "effect";
import { useCallback, useEffect } from "react";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { serverConfigQueryOptions } from "~/lib/serverReactQuery";
import { readNativeApi } from "~/nativeApi";
import { useOnboardingDialogStore } from "~/onboarding/onboardingDialogStore";

export const BROWSER_IMPORT_ANNOUNCEMENT_STORAGE_KEY = "synara:browser-import-announcement:v1";
const AnnouncementSchema = Schema.Array(Schema.String);
const EMPTY_INSTALLATIONS: readonly string[] = [];

export function useBrowserImportAnnouncement() {
  const installation = useQuery({
    ...serverConfigQueryOptions(),
    select: (config) => config.worktreesDir,
  }).data;
  const [seen, setSeen] = useLocalStorage(
    BROWSER_IMPORT_ANNOUNCEMENT_STORAGE_KEY,
    EMPTY_INSTALLATIONS,
    AnnouncementSchema,
  );
  const startupSettled = useOnboardingDialogStore((state) => state.startupGateSettled);
  const onboardingOpen = useOnboardingDialogStore((state) => state.isOpen);
  const onboardingImportStepSeenForInstallation = useOnboardingDialogStore(
    (state) => state.browserImportStepSeenForInstallation,
  );
  const api = readNativeApi()?.browser.vault;

  const markSeen = useCallback(() => {
    if (installation) {
      setSeen((current) => (current.includes(installation) ? current : [...current, installation]));
    }
  }, [installation, setSeen]);

  // Persist only when onboarding actually reached the matching step. The first-run
  // gate can provisionally open and then auto-close when authoritative data arrives.
  useEffect(() => {
    if (
      onboardingImportStepSeenForInstallation === installation &&
      installation &&
      !seen.includes(installation)
    )
      markSeen();
  }, [installation, markSeen, onboardingImportStepSeenForInstallation, seen]);

  return {
    visible: Boolean(
      startupSettled && installation && api && !seen.includes(installation) && !onboardingOpen,
    ),
    markSeen,
  };
}
