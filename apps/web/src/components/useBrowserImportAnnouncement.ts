import { useQuery } from "@tanstack/react-query";
import { Schema } from "effect";
import { useCallback, useEffect, useState } from "react";

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
  const [profilesAvailable, setProfilesAvailable] = useState(false);
  const [probedInstallation, setProbedInstallation] = useState<string | null>(null);

  const markSeen = useCallback(() => {
    if (installation) {
      setSeen((current) => (current.includes(installation) ? current : [...current, installation]));
    }
  }, [installation, setSeen]);

  useEffect(() => {
    if (!startupSettled || onboardingOpen || !installation || seen.includes(installation) || !api)
      return;
    let active = true;
    setProfilesAvailable(false);
    void api
      .cookieSources()
      .then(async (sources) => {
        if (!active) return;
        const profiles = await Promise.all(
          sources.map((source) => api.cookieProfiles(source.id).catch(() => [])),
        );
        if (active) setProfilesAvailable(profiles.some((items) => items.length > 0));
      })
      .catch((error) => {
        // A failed inspection must not acknowledge the announcement; retry next launch.
        console.warn("[browser-import] Could not inspect profiles for the welcome prompt", error);
      })
      .finally(() => {
        if (active) setProbedInstallation(installation);
      });
    return () => {
      active = false;
    };
  }, [api, installation, onboardingOpen, seen, startupSettled]);

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
      startupSettled &&
      installation &&
      api &&
      probedInstallation === installation &&
      profilesAvailable &&
      !seen.includes(installation) &&
      !onboardingOpen,
    ),
    markSeen,
  };
}
