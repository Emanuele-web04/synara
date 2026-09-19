import { useQuery } from "@tanstack/react-query";
import { Schema } from "effect";
import { useCallback, useEffect } from "react";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { serverConfigQueryOptions } from "~/lib/serverReactQuery";
import { useOnboardingDialogStore } from "~/onboarding/onboardingDialogStore";
import { useProjectImportDialogStore } from "./projectImportDialogStore";

const AnnouncementSchema = Schema.Array(Schema.String);
const EMPTY_INSTALLATIONS: readonly string[] = [];

export function useProjectImportAnnouncement() {
  const installation = useQuery({
    ...serverConfigQueryOptions(),
    select: (config) => config.worktreesDir,
  }).data;
  const [seen, setSeen] = useLocalStorage(
    "synara:project-import-announcement:v1",
    EMPTY_INSTALLATIONS,
    AnnouncementSchema,
  );
  const startupSettled = useOnboardingDialogStore((state) => state.startupGateSettled);
  const onboardingOpen = useOnboardingDialogStore((state) => state.isOpen);
  const dialogOpen = useProjectImportDialogStore((state) => state.isOpen);
  const markSeen = useCallback(() => {
    if (installation)
      setSeen((current) => (current.includes(installation) ? current : [...current, installation]));
  }, [installation, setSeen]);
  // The welcome tour already presents this feature; don't announce it again afterwards.
  useEffect(() => {
    if ((onboardingOpen || dialogOpen) && installation && !seen.includes(installation)) markSeen();
  }, [dialogOpen, installation, markSeen, onboardingOpen, seen]);
  return {
    visible: Boolean(
      startupSettled &&
      installation &&
      !seen.includes(installation) &&
      !onboardingOpen &&
      !dialogOpen,
    ),
    markSeen,
  };
}
