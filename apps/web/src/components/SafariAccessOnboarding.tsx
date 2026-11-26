import type { DesktopSafariAccessInfo } from "@synara/contracts";
import { Schema } from "effect";
import { SettingsIcon } from "~/lib/icons";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Key01Icon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { AnnouncementSheetPopup } from "./AnnouncementSheet";
import { DIALOG_HERO_ITEM_SHADOW_CLASS_NAME, DialogHeroLink } from "./DialogHeroBand";
import { Button } from "./ui/button";
import { useAnnouncementSheetSlot, useAnnouncementSheetSlotStore } from "./announcementSheetSlot";
import { Dialog } from "./ui/dialog";
import { useTranslation } from "~/i18n";

export const SAFARI_ACCESS_STORAGE_KEY = "synara:safari-access-onboarding:v1";
const OPEN_EVENT = "synara:safari-access-setup";
/** "continued" is a legacy value from the earlier two-button intro; treat it like "later". */
const Decision = Schema.Literals(["unseen", "later", "continued"]);
const SAFARI_ICON_SRC = "/app-icons/safari.png";
const SYNARA_ICON_SRC = "/app-icons/dark.png";

const STATUS = {
  settingsOpened: "System Settings is open. Once Synara is switched on, quit and reopen it.",
  appRevealed: "Synara is selected in Finder. Drag it into the Full Disk Access list.",
  openFailed: "Couldn't open it automatically. It lives in System Settings › Privacy & Security.",
} as const;

function useSafariAccessInfo() {
  const [info, setInfo] = useState<DesktopSafariAccessInfo | null>(null);
  useEffect(() => {
    let disposed = false;
    const bridge = window.desktopBridge?.safariAccess;
    const request = bridge ? bridge.getInfo() : Promise.resolve({ supported: false } as const);
    void request
      .then((value) => {
        if (!disposed) setInfo(value);
      })
      .catch(() => {
        if (!disposed) setInfo({ supported: false });
      });
    return () => {
      disposed = true;
    };
  }, []);
  return info;
}

export function SafariAccessSetupButton() {
  const { t } = useTranslation();

  const info = useSafariAccessInfo();
  if (!info?.supported) return null;
  return (
    <Button size="sm" variant="outline" onClick={() => window.dispatchEvent(new Event(OPEN_EVENT))}>
      <SettingsIcon className="size-4" />
      {t("onboarding:safariImportSetup")}
    </Button>
  );
}

/**
 * Intro decisions are persisted, never permission claims. Full Disk Access is
 * reported per launch by the desktop process that reads Safari's cookies.
 */
export function SafariAccessOnboarding({
  children,
  startup = false,
}: {
  children?: ReactNode;
  /** The root opts automatic first-launch guidance into startup arbitration. */
  startup?: boolean;
}) {
  const { t } = useTranslation();

  const info = useSafariAccessInfo();
  const [decision, setDecision] = useLocalStorage(SAFARI_ACCESS_STORAGE_KEY, "unseen", Decision);
  const [revisit, setRevisit] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const granted = info?.supported === true && info.fullDiskAccess === "granted";
  // Once access is on there is nothing left to set up, so only a deliberate
  // revisit opens the sheet; the stored decision is left untouched.
  const wantsOpen = info?.supported === true && ((decision === "unseen" && !granted) || revisit);
  const { open: startupOpen } = useAnnouncementSheetSlot(startup && wantsOpen && !revisit);
  // Local setup and deliberate Settings revisits must not depend on the root's
  // first-run gate or wait behind an automatic announcement.
  const open = wantsOpen && (!startup || revisit || startupOpen);
  const handedOff = useAnnouncementSheetSlotStore((state) => state.handedOff);

  useEffect(() => {
    const show = () => {
      setStatus(null);
      setRevisit(true);
    };
    window.addEventListener(OPEN_EVENT, show);
    return () => {
      generation.current++;
      window.removeEventListener(OPEN_EVENT, show);
    };
  }, []);

  const close = () => {
    generation.current++;
    setBusy(false);
    setStatus(null);
    setRevisit(false);
    setDecision("later");
  };
  const run = async (action: "openSettings" | "revealApp") => {
    if (busy) return;
    const request = ++generation.current;
    setBusy(true);
    try {
      const opened = await window.desktopBridge?.safariAccess?.[action]();
      if (request !== generation.current) return;
      setStatus(
        opened
          ? action === "openSettings"
            ? STATUS.settingsOpened
            : STATUS.appRevealed
          : STATUS.openFailed,
      );
    } catch {
      if (request === generation.current) setStatus(STATUS.openFailed);
    } finally {
      if (request === generation.current) setBusy(false);
    }
  };

  return (
    <>
      {info && (!wantsOpen || revisit || handedOff) ? children : null}
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!value) close();
        }}
      >
        <AnnouncementSheetPopup
          hero={<SafariAccessScene />}
          title={t("onboarding:bringYourSafariLoginsAlong")}
          description={t("onboarding:synaraSBrowserCanPickUpSitesYouRe")}
          details={
            <div className="flex flex-col gap-3 pt-4">
              {info?.supported && info.fullDiskAccess === "granted" ? (
                <p className="text-ui leading-relaxed text-muted-foreground">
                  {t("onboarding:safariAccessGrantedPrefix")}{" "}
                  <span className="font-medium text-foreground">{info.appName}</span>
                  {t("onboarding:safariAccessGrantedSuffix")}
                </p>
              ) : info?.supported ? (
                <ol className="space-y-2.5 rounded-[14px] border border-border px-4 py-3.5 text-ui leading-relaxed">
                  <Step n={1}>
                    {t("onboarding:notification_open")}{" "}
                    <span className="font-medium text-foreground">
                      {t("onboarding:systemSettings")}
                    </span>{" "}
                    {t("onboarding:privacySecurityFullDiskAccess")}
                  </Step>
                  <Step n={2}>
                    {t("onboarding:switchOn")}{" "}
                    <span className="font-medium text-foreground">{info.appName}</span>.
                    {info.appPath ? (
                      <>
                        {" "}
                        {t("onboarding:notListed")}{" "}
                        <button
                          type="button"
                          disabled={busy}
                          title={info.appPath}
                          onClick={() => {
                            void run("revealApp");
                          }}
                          className="rounded-sm underline decoration-muted-foreground/40 underline-offset-[3px] transition-colors hover:text-foreground hover:decoration-current focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60"
                        >
                          {t("onboarding:showAppInFinder")}
                        </button>{" "}
                        {t("onboarding:andDragItIn")}
                      </>
                    ) : null}
                  </Step>
                  <Step n={3}>{t("onboarding:quitAndReopenSynara")}</Step>
                </ol>
              ) : null}

              <p className="text-center text-ui-sm leading-relaxed text-muted-foreground/80">
                {t("onboarding:fullDiskAccessIsABroadMacOSPermissionThat")}
              </p>

              {status ? (
                <p
                  role="status"
                  className="text-center text-ui leading-relaxed text-muted-foreground"
                >
                  {status}
                </p>
              ) : null}
            </div>
          }
          dismissLabel={t("common:notNow")}
          confirmLabel={t("onboarding:openSystemSettings")}
          confirmDisabled={busy}
          onDismiss={close}
          onConfirm={() => {
            void run("openSettings");
          }}
        />
      </Dialog>
    </>
  );
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-3 text-muted-foreground">
      <span
        aria-hidden
        className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-ui-sm font-medium tabular-nums text-foreground/70"
      >
        {n}
      </span>
      <span className="min-w-0">{children}</span>
    </li>
  );
}

/** Safari's icon handing a key to Synara's, with the macOS switch that allows it. */
function SafariAccessScene() {
  const { t } = useTranslation();
  const appIconClassName = "size-14 select-none drop-shadow-[0_8px_16px_rgba(0,0,0,0.18)]";
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="flex items-center gap-3">
        <img
          src={SAFARI_ICON_SRC}
          alt=""
          draggable={false}
          className={cn(appIconClassName, "scene-float")}
        />
        <DialogHeroLink badge={<Key01Icon className="size-3.5" />} />
        <img
          src={SYNARA_ICON_SRC}
          alt=""
          draggable={false}
          className={cn(appIconClassName, "scene-float [animation-delay:-3s]")}
        />
      </div>
      <span
        className={cn(
          "flex items-center gap-2 rounded-full border border-border bg-popover py-1 ps-2.5 pe-1.5 text-ui-timestamp font-medium text-foreground",
          DIALOG_HERO_ITEM_SHADOW_CLASS_NAME,
        )}
      >
        {t("onboarding:safariHeroFullDiskAccess")}
        <span
          className="scene-switch-track flex h-3.5 w-6 items-center justify-end rounded-full bg-[#34c759] p-0.5"
          style={{ "--scene-switch-travel": "10px" } as CSSProperties}
        >
          <span
            className="scene-switch-knob size-2.5 rounded-full bg-white shadow-xs"
            style={{ "--scene-switch-travel": "10px" } as CSSProperties}
          />
        </span>
      </span>
    </div>
  );
}
