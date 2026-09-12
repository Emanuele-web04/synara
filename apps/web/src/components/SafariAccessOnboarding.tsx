import type { DesktopSafariAccessInfo } from "@synara/contracts";
import { Schema } from "effect";
import { SettingsIcon } from "~/lib/icons";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";

export const SAFARI_ACCESS_STORAGE_KEY = "synara:safari-access-onboarding:v1";
const OPEN_EVENT = "synara:safari-access-setup";
/** "continued" is a legacy value from the earlier two-button intro; treat it like "later". */
const Decision = Schema.Literals(["unseen", "later", "continued"]);
const SAFARI_ICON_SRC = "/app-icons/safari.png";

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
  const info = useSafariAccessInfo();
  if (!info?.supported) return null;
  return (
    <Button size="sm" variant="outline" onClick={() => window.dispatchEvent(new Event(OPEN_EVENT))}>
      <SettingsIcon className="size-4" />
      Safari import setup
    </Button>
  );
}

/** Intro decisions are persisted, never permission claims. No protected files are probed here. */
export function SafariAccessOnboarding({ children }: { children?: ReactNode }) {
  const info = useSafariAccessInfo();
  const [decision, setDecision] = useLocalStorage(SAFARI_ACCESS_STORAGE_KEY, "unseen", Decision);
  const [revisit, setRevisit] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const open = info?.supported === true && (decision === "unseen" || revisit);

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
      {info && !open ? children : null}
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!value) close();
        }}
      >
        <DialogPopup showCloseButton={false} initialFocus={sheetRef} className="max-w-[400px]">
          <div ref={sheetRef} tabIndex={-1} className="min-h-0 overflow-y-auto outline-none">
            <DialogHeader className="items-center gap-3 px-6 pt-7 pb-0 text-center">
              <img
                src={SAFARI_ICON_SRC}
                alt=""
                aria-hidden
                draggable={false}
                className="size-16 select-none drop-shadow-[0_6px_14px_rgba(0,0,0,0.18)]"
              />
              <DialogTitle className="mt-1">Bring your Safari logins along?</DialogTitle>
              <DialogDescription className="text-balance leading-relaxed">
                Synara's browser can pick up sites you're already signed into in Safari, so you
                don't have to log in twice. It's optional, and nothing is copied until you ask.
              </DialogDescription>
            </DialogHeader>

            {info?.supported ? (
              <ol className="mx-6 mt-5 space-y-3 text-sm leading-relaxed">
                <Step n={1}>
                  Open <span className="font-medium text-foreground">System Settings</span> ›
                  Privacy &amp; Security › Full Disk Access.
                </Step>
                <Step n={2}>
                  Switch on <span className="font-medium text-foreground">{info.appName}</span>.
                  {info.appPath ? (
                    <>
                      {" "}
                      Not listed?{" "}
                      <button
                        type="button"
                        disabled={busy}
                        title={info.appPath}
                        onClick={() => {
                          void run("revealApp");
                        }}
                        className="rounded-sm underline decoration-muted-foreground/40 underline-offset-[3px] transition-colors hover:text-foreground hover:decoration-current focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60"
                      >
                        Show app in Finder
                      </button>{" "}
                      and drag it in.
                    </>
                  ) : null}
                </Step>
                <Step n={3}>Quit and reopen Synara.</Step>
              </ol>
            ) : null}

            <p className="mx-6 mt-5 text-xs leading-relaxed text-muted-foreground/80">
              Full Disk Access is a broad macOS permission that reaches beyond Safari. If you'd
              rather not, that's fine. You can find this again under Settings › General.
            </p>

            {status ? (
              <p role="status" className="mx-6 mt-3 text-xs leading-relaxed text-muted-foreground">
                {status}
              </p>
            ) : null}

            <DialogFooter className="mt-5 px-6 pb-6 pt-0">
              <Button variant="ghost" onClick={close}>
                Not now
              </Button>
              <Button
                disabled={busy}
                onClick={() => {
                  void run("openSettings");
                }}
              >
                Open System Settings
              </Button>
            </DialogFooter>
          </div>
        </DialogPopup>
      </Dialog>
    </>
  );
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-3 text-muted-foreground">
      <span
        aria-hidden
        className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium tabular-nums text-foreground/70"
      >
        {n}
      </span>
      <span className="min-w-0">{children}</span>
    </li>
  );
}
