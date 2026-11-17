// FILE: IosBetaAnnouncement.tsx
// Purpose: Shows at most one connection launch sheet per startup and links to Synara for iPhone.
// Layer: Root web overlay
// Exports: ConnectionLaunchAnnouncements, IOS_BETA_ANNOUNCEMENT_STORAGE_KEY
//
// Shown only where this computer can pair an iPhone, with the same rules as the Remote
// Connections sheet: ordered last among startup surfaces, kept clear of the team sharing
// consent, and skipped after the first-run tour, whose pairing step already introduces
// the iPhone app.

import { Schema } from "effect";
import { useEffect, useState } from "react";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useTranslation } from "~/i18n";
import { openExternalLink } from "~/lib/linkChips";
import { cn } from "~/lib/utils";
import { useOnboardingDialogStore } from "~/onboarding/onboardingDialogStore";
import { AnnouncementSheet } from "../AnnouncementSheet";
import {
  RemoteConnectionsAnnouncement,
  useClearOfOutsideDialogs,
  useRemoteConnectionsAvailable,
} from "./RemoteConnectionsAnnouncement";
import {
  AnnouncementBackdrop,
  DEVICE_SHADOW_CLASS_NAME,
} from "./RemoteConnectionsAnnouncementHero";

export const IOS_BETA_ANNOUNCEMENT_STORAGE_KEY = "synara:ios-beta-announcement:v1";
const IOS_BETA_PAGE_URL = "https://trysynara.com/ios";
// The top of the iPhone Inbox; the band crops the rest of the phone.
const IPHONE_SCREEN_SRC = "/announcements/ios-beta-iphone.png";

const StorageSchema = Schema.Struct({ acknowledged: Schema.Boolean });
const INITIAL_STORAGE: typeof StorageSchema.Type = { acknowledged: false };

export function ConnectionLaunchAnnouncements() {
  const { t } = useTranslation();
  const [storage, setStorage] = useLocalStorage(
    IOS_BETA_ANNOUNCEMENT_STORAGE_KEY,
    INITIAL_STORAGE,
    StorageSchema,
  );
  const onboardingOpen = useOnboardingDialogStore((state) => state.isOpen);
  const available = useRemoteConnectionsAvailable();
  const unseen = available && !storage.acknowledged;
  // Keep the startup choice after dismissal so the other sheet stays deferred until relaunch.
  const [prioritizeIos] = useState(() => !storage.acknowledged);
  const clear = useClearOfOutsideDialogs(prioritizeIos && unseen);

  useEffect(() => {
    if (onboardingOpen && unseen) setStorage({ acknowledged: true });
  }, [onboardingOpen, setStorage, unseen]);

  return (
    <>
      <RemoteConnectionsAnnouncement deferred={prioritizeIos} />
      <AnnouncementSheet
        open={unseen && clear}
        order="last"
        presentation="feature"
        hero={<IosBetaAnnouncementHero />}
        title={t("workspace:introducingSynaraForIphone")}
        description={t("workspace:iosBetaAnnouncementDescription")}
        dismissLabel={t("common:notNow")}
        confirmLabel={t("workspace:joinTheBeta")}
        onDismiss={() => setStorage({ acknowledged: true })}
        onConfirm={() => {
          setStorage({ acknowledged: true });
          openExternalLink(IOS_BETA_PAGE_URL);
        }}
      />
    </>
  );
}

/** The iPhone Inbox rising out of the same orange backdrop as the Remote Connections sheet. */
function IosBetaAnnouncementHero() {
  return (
    <div className="absolute inset-0 select-none">
      <AnnouncementBackdrop />
      <img
        src={IPHONE_SCREEN_SRC}
        alt=""
        draggable={false}
        className={cn(
          "absolute top-[26px] left-1/2 w-[199px] max-w-none -translate-x-1/2",
          DEVICE_SHADOW_CLASS_NAME,
        )}
      />
    </div>
  );
}
