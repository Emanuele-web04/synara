import { useEffect, useRef, useState } from "react";
import type { BrowserCookieImportResult, BrowserVaultMethods, ThreadId } from "@synara/contracts";
import { SettingsSelectControl } from "./settings/SettingControls";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { SelectItem } from "./ui/select";
import { DisclosureRegion } from "./ui/DisclosureRegion";
import { useTranslation } from "~/i18n";

export interface BrowserCookieDestination {
  threadId: ThreadId;
  tabId: string;
  origin: string | null;
}
type Choice = { id: string; name: string };

function importFailure(
  result: Extract<BrowserCookieImportResult, { ok: false }>,
  browser: string,
): string {
  if (result.code === "permission_denied") {
    if (result.platform === "macos" && browser === "safari")
      return "macOS denied access to Safari's cookie files. Allow Synara in System Settings > Privacy & Security > Full Disk Access, then quit and reopen Synara before retrying. Revisit Safari import setup in Synara Settings > General for the correct app. You can sign in directly instead.";
    if (result.platform === "macos")
      return "macOS denied access to this browser's cookie data. Review Synara's file access in Privacy & Security and any Keychain prompt, then retry.";
    return "The operating system denied access to this browser's cookie data. Review its access permissions or sign in directly.";
  }
  if (result.code === "timed_out")
    return "The browser reader timed out. Close the source browser and retry.";
  if (result.code === "source_missing")
    return "The selected profile is no longer available. Choose another profile or open the source browser first.";
  if (result.code === "reader_unavailable")
    return "The native cookie reader is unavailable. Reinstall Synara with its optional native dependencies, or sign in directly.";
  if (result.code === "persistence_failed")
    return "Cookies were imported, but secure storage could not save their session state for future launches. Existing sessions may have changed.";
  if (result.code === "reader_failed" && result.stage === "acquisition")
    return "The native reader could not open or acquire the source cookie store. A permission denial was not confirmed. Check that the source profile is available and Synara has access to it.";
  if (result.code === "reader_failed" && (result.stage === "parse" || result.stage === "decode"))
    return "The native reader could not decode this profile's cookie data. This is a cookie-format failure, not a confirmed permission denial.";
  if (result.code === "reader_failed" && result.stage === "decrypt")
    return "The native reader could not decrypt this profile's cookies. Review any OS key-store prompt, or sign in directly.";
  if (result.code === "reader_failed")
    return "The native reader could not read this profile. A permission denial was not identified. Close the source browser and retry, or sign in directly.";
  return "The cookie transfer could not be verified. Existing sessions may have changed; retry or sign in directly.";
}

export function BrowserCookieImport({
  api,
  destination,
}: {
  api: BrowserVaultMethods;
  destination: BrowserCookieDestination;
}) {
  const { t } = useTranslation();

  const [open, setOpen] = useState(false);
  const [sources, setSources] = useState<Choice[]>([]);
  const [profiles, setProfiles] = useState<Choice[]>([]);
  const [source, setSource] = useState("");
  const [profile, setProfile] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [scope, setScope] = useState<"site" | "profile">(destination.origin ? "site" : "profile");
  const [confirmed, setConfirmed] = useState(false);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );

  const loadProfiles = async (browser: string) => {
    const request = ++generation.current;
    setSource(browser);
    setConfirmed(false);
    setProfile("");
    setProfiles([]);
    setBusy(true);
    setStatus(null);
    try {
      const choices = await api.cookieProfiles(browser);
      if (request !== generation.current) return;
      setProfiles(choices);
      setProfile(choices[0]?.id ?? "");
      if (!choices.length) setStatus("No available profiles found.");
    } catch {
      if (request === generation.current)
        setStatus("Profiles could not be read. Check browser installation and system permissions.");
    } finally {
      if (request === generation.current) setBusy(false);
    }
  };

  const load = async () => {
    setOpen(true);
    setBusy(true);
    setStatus(null);
    const request = ++generation.current;
    try {
      const choices = await api.cookieSources();
      if (request !== generation.current) return;
      setSources(choices);
      if (choices[0]) await loadProfiles(choices[0].id);
      else {
        setStatus("Cookie import is unavailable on this platform.");
        setBusy(false);
      }
    } catch {
      if (request === generation.current) {
        setStatus("Cookie import is unavailable. Sign in directly in the browser instead.");
        setBusy(false);
      }
    }
  };

  const run = async () => {
    if (
      busy ||
      !profile ||
      !["chrome", "safari", "edge"].includes(source) ||
      (scope === "profile" && !confirmed)
    )
      return;
    if (source !== "chrome" && source !== "safari" && source !== "edge") return;
    const request = ++generation.current;
    setBusy(true);
    setStatus(null);
    try {
      const target = {
        threadId: destination.threadId,
        tabId: destination.tabId,
        browser: source,
        profile,
      } as const;
      const result =
        scope === "profile"
          ? await api.importCookies({ ...target, scope: "profile", confirmed: true })
          : destination.origin
            ? await api.importCookies({ ...target, scope: "site", origin: destination.origin })
            : null;
      if (request === generation.current && result)
        setStatus(
          result.ok
            ? `${result.imported} ${result.imported === 1 ? "cookie" : "cookies"} imported. ${result.skipped} skipped.${result.warnings.length ? " Some cookies could not be transferred; you may need to sign in again." : ""}`
            : importFailure(result, source),
        );
    } catch {
      if (request === generation.current)
        setStatus(
          "Import stopped because the browser destination changed or the operation became unavailable. Select the destination and retry.",
        );
    } finally {
      if (request === generation.current) {
        setBusy(false);
        setConfirmed(false);
      }
    }
  };

  return (
    <section className="mt-4 border-t pt-3">
      <Button
        variant="ghost"
        size="sm"
        disabled={busy}
        onClick={() => {
          if (open) setOpen(false);
          else void load();
        }}
      >
        {t("computer:importBrowserCookies")}
      </Button>
      <DisclosureRegion open={open}>
        <div className="space-y-3 pt-3 text-ui leading-snug">
          <div className="space-y-1">
            <span>{t("computer:importScope")}</span>
            <SettingsSelectControl
              ariaLabel={t("computer:cookieImportScope")}
              triggerClassName="w-full"
              value={scope}
              disabled={busy}
              onValueChange={(value) => {
                setScope(value === "profile" ? "profile" : "site");
                setConfirmed(false);
                setStatus(null);
              }}
              valueContent={
                scope === "profile"
                  ? t("computer:allSitesInThisProfile")
                  : `${t("computer:thisSite")} ${destination.origin ?? ""}`
              }
            >
              {destination.origin ? (
                <SelectItem hideIndicator value="site">
                  {t("computer:thisSite")} {destination.origin}
                </SelectItem>
              ) : null}
              <SelectItem hideIndicator value="profile">
                {t("computer:allSitesInThisProfile")}
              </SelectItem>
            </SettingsSelectControl>
          </div>
          <p className="text-ui leading-snug text-muted-foreground">
            {scope === "profile"
              ? t("computer:importsAllCompatibleCookiesFromTheSelectedProfileEvery")
              : t("computer:importsThisSiteItsSubdomainsAndMatchingParentDomains")}
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div className="min-w-0 space-y-1">
              <span>{t("computer:browser")}</span>
              <SettingsSelectControl
                ariaLabel={t("computer:cookieSourceBrowser")}
                triggerClassName="w-full"
                value={source}
                disabled={busy}
                onValueChange={(value) => {
                  void loadProfiles(value);
                }}
                valueContent={sources.find(({ id }) => id === source)?.name ?? ""}
              >
                {sources.map(({ id, name }) => (
                  <SelectItem hideIndicator key={id} value={id}>
                    {name}
                  </SelectItem>
                ))}
              </SettingsSelectControl>
            </div>
            <div className="min-w-0 space-y-1">
              <span>{t("computer:nav_profile")}</span>
              <SettingsSelectControl
                ariaLabel={t("computer:cookieSourceProfile")}
                triggerClassName="w-full"
                value={profile}
                disabled={busy}
                onValueChange={(value) => {
                  setProfile(value);
                  setConfirmed(false);
                }}
                valueContent={profiles.find(({ id }) => id === profile)?.name ?? ""}
              >
                {profiles.map(({ id, name }) => (
                  <SelectItem hideIndicator key={id} value={id}>
                    {name}
                  </SelectItem>
                ))}
              </SettingsSelectControl>
            </div>
          </div>
          <DisclosureRegion open={scope === "profile"}>
            <label className="flex items-start gap-2 text-ui leading-snug">
              <Checkbox
                className="mt-0.5"
                checked={confirmed}
                disabled={busy}
                onCheckedChange={(checked) => setConfirmed(checked)}
              />
              <span>{t("computer:iAllowSynaraAndItsAgentsToUseAll")}</span>
            </label>
          </DisclosureRegion>
          {status ? (
            <p role="status" className="text-ui leading-snug text-muted-foreground">
              {status}
            </p>
          ) : null}
          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={busy || !profile || (scope === "profile" && !confirmed)}
              onClick={() => {
                void run();
              }}
            >
              {busy
                ? t("computer:working")
                : scope === "profile"
                  ? t("computer:importAllSites")
                  : t("computer:importForThisSite")}
            </Button>
          </div>
        </div>
      </DisclosureRegion>
    </section>
  );
}
