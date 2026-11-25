// FILE: ProductAnalyticsAnnouncement.tsx
// Purpose: One-time startup sheet telling Stable desktop users that product analytics is
//          on, what it shares and never shares, with a shortcut to Settings › Privacy.
// Layer: Root web overlay
// Exports: ProductAnalyticsAnnouncement, PRODUCT_ANALYTICS_ANNOUNCEMENT_STORAGE_KEY
//
// Shown only while this installation is actually sharing. An installation first seen with
// sharing off is acknowledged silently: that user already chose in Settings, and turning
// sharing back on there must not pop this sheet over the page. Remote and Beta are skipped: Remote also sends technical diagnostics under the
// same switch, and Beta welcomes users with its own diagnostics disclosure. The sheet
// waits for the first-run tour like every startup announcement, and for the team sharing
// consent, which opens outside the announcement slot; then it takes the shared slot ahead
// of the "last" launch sheets.

import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Schema } from "effect";
import { useEffect, type ReactNode } from "react";

import { IS_BETA_DESKTOP, IS_REMOTE_DESKTOP } from "~/branding";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useTranslation } from "~/i18n";
import { CentralIcon } from "~/lib/central-icons";
import {
  productAnalyticsBridge,
  productAnalyticsConsentQueryOptions,
} from "~/lib/productAnalytics";
import { cn } from "~/lib/utils";
import { AnnouncementSheet } from "./AnnouncementSheet";
import { useClearOfOutsideDialogs } from "./hosts/RemoteConnectionsAnnouncement";
import {
  AnnouncementBackdrop,
  DEVICE_SHADOW_CLASS_NAME,
} from "./hosts/RemoteConnectionsAnnouncementHero";

export const PRODUCT_ANALYTICS_ANNOUNCEMENT_STORAGE_KEY =
  "synara:product-analytics-announcement:v1";

const StorageSchema = Schema.Struct({ acknowledged: Schema.Boolean });
const INITIAL_STORAGE: typeof StorageSchema.Type = { acknowledged: false };

const SHARED_POINTS = [
  { icon: "chart-3", text: "settings:productAnalyticsNoticeSharedFeatures" },
  { icon: "gauge", text: "settings:productAnalyticsNoticeSharedModels" },
  { icon: "bug", text: "settings:productAnalyticsNoticeSharedReliability" },
] as const;
const NEVER_POINTS = [
  { icon: "eye-slash", text: "settings:productAnalyticsNoticeNeverContent" },
  { icon: "lock", text: "settings:productAnalyticsNoticeNeverIdentity" },
] as const;

export function ProductAnalyticsAnnouncement() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [storage, setStorage] = useLocalStorage(
    PRODUCT_ANALYTICS_ANNOUNCEMENT_STORAGE_KEY,
    INITIAL_STORAGE,
    StorageSchema,
  );
  const bridge = productAnalyticsBridge();
  const unseen = !!bridge && !IS_REMOTE_DESKTOP && !IS_BETA_DESKTOP && !storage.acknowledged;
  const consent = useQuery({
    ...productAnalyticsConsentQueryOptions(bridge),
    enabled: unseen,
  });
  const sharing = unseen && consent.data?.enabled === true;
  const optedOut = unseen && consent.data?.enabled === false;
  const clear = useClearOfOutsideDialogs(sharing);

  useEffect(() => {
    if (optedOut) setStorage({ acknowledged: true });
  }, [optedOut, setStorage]);

  return (
    <AnnouncementSheet
      open={sharing && clear}
      presentation="feature"
      hero={<ProductAnalyticsAnnouncementHero />}
      title={t("settings:productAnalyticsNoticeTitle")}
      description={t("settings:productAnalyticsNoticeDescription")}
      details={
        <div className="mt-5 flex w-full flex-col gap-3.5 rounded-2xl bg-muted/60 px-4 py-3.5 text-start">
          <NoticeGroup
            heading={t("settings:productAnalyticsNoticeSharedHeading")}
            points={SHARED_POINTS}
            iconClassName="text-orange-600"
          />
          <NoticeGroup
            heading={t("settings:productAnalyticsNoticeNeverHeading")}
            points={NEVER_POINTS}
            iconClassName="text-muted-foreground"
          />
        </div>
      }
      dismissLabel={t("settings:productAnalyticsNoticeDismiss")}
      confirmLabel={t("settings:productAnalyticsNoticeTurnOff")}
      onDismiss={() => setStorage({ acknowledged: true })}
      onConfirm={() => {
        setStorage({ acknowledged: true });
        void navigate({ to: "/settings", search: { section: "privacy" } });
      }}
    />
  );
}

function NoticeGroup({
  heading,
  points,
  iconClassName,
}: {
  heading: string;
  points: ReadonlyArray<{ icon: string; text: string }>;
  iconClassName: string;
}) {
  const { t } = useTranslation();
  return (
    <section className="flex flex-col gap-2">
      <h3 className="m-0 text-ui-sm font-medium text-muted-foreground">{heading}</h3>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {points.map((point) => (
          <li key={point.icon} className="flex items-start gap-2.5 text-ui text-foreground">
            <CentralIcon
              name={point.icon}
              className={cn("mt-[0.15em] size-4 shrink-0", iconClassName)}
            />
            {t(point.text)}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Settings › Privacy in miniature over the launch sheets' orange backdrop: sharing on. */
function ProductAnalyticsAnnouncementHero() {
  return (
    <div className="absolute inset-0 select-none">
      <AnnouncementBackdrop />
      <div className="absolute inset-0 flex items-center justify-center">
        <div
          className={cn(
            "flex w-[264px] flex-col gap-3 rounded-[16px] bg-background p-3.5",
            DEVICE_SHADOW_CLASS_NAME,
          )}
        >
          <div className="flex items-center gap-2.5">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-orange-600/12 text-orange-600">
              <CentralIcon name="shield-check" className="size-5" />
            </span>
            <span className="flex flex-1 flex-col gap-1.5">
              <span className="h-[5px] w-24 rounded-full bg-foreground/25" />
              <span className="h-1 w-36 rounded-full bg-foreground/10" />
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            <HeroRow icon="chart-3">
              <span className="flex h-[15px] w-[26px] shrink-0 items-center justify-end rounded-full bg-orange-600 p-0.5">
                <span className="size-[11px] rounded-full bg-white" />
              </span>
            </HeroRow>
            <HeroRow icon="eye-slash">
              <CentralIcon name="lock" className="size-3.5 shrink-0 text-muted-foreground" />
            </HeroRow>
          </div>
        </div>
      </div>
    </div>
  );
}

function HeroRow({ icon, children }: { icon: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 rounded-[10px] bg-muted px-2.5 py-2">
      <CentralIcon name={icon} className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="flex flex-1 flex-col gap-1">
        <span className="h-1 w-20 rounded-full bg-foreground/20" />
        <span className="h-[3px] w-28 rounded-full bg-foreground/10" />
      </span>
      {children}
    </div>
  );
}
