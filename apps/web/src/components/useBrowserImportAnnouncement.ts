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
const PROFILE_PROBE_RETRY_DELAYS_MS = [250, 750] as const;

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
  const [inspectionFailed, setInspectionFailed] = useState(false);
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
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    setProfilesAvailable(false);
    setInspectionFailed(false);
    const inspect = async (attempt: number): Promise<void> => {
      try {
        const sources = await api.cookieSources();
        if (!active) return;
        const results = await Promise.allSettled(
          sources.map((source) => api.cookieProfiles(source.id)),
        );
        if (!active) return;
        const profilesAvailable = results.some(
          (result) => result.status === "fulfilled" && result.value.length > 0,
        );
        const inspectionFailed = results.some((result) => result.status === "rejected");
        if (!profilesAvailable && inspectionFailed) throw new Error("Profile inspection failed.");
        setProfilesAvailable(profilesAvailable);
        setProbedInstallation(installation);
      } catch {
        if (!active) return;
        const delay = PROFILE_PROBE_RETRY_DELAYS_MS[attempt];
        if (delay !== undefined) {
          retryTimer = setTimeout(() => void inspect(attempt + 1), delay);
        } else {
          setInspectionFailed(true);
          setProbedInstallation(installation);
        }
      }
    };
    void inspect(0);
    return () => {
      active = false;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
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
      (profilesAvailable || inspectionFailed) &&
      !seen.includes(installation) &&
      !onboardingOpen,
    ),
    inspectionFailed,
    markSeen,
  };
}
