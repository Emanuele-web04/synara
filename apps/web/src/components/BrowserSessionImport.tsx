import type { BrowserCookieImportResult, BrowserVaultMethods } from "@synara/contracts";
import { BrowserCookieSource } from "@synara/contracts";
import { Schema } from "effect";
import { useEffect, useMemo, useRef, useState } from "react";
import { Checkbox } from "~/components/ui/checkbox";
import { Button } from "./ui/button";

type BrowserChoice = Awaited<ReturnType<BrowserVaultMethods["cookieSources"]>>[number];
type ProfileChoice = Awaited<ReturnType<BrowserVaultMethods["cookieProfiles"]>>[number];
type Inventory = Awaited<ReturnType<BrowserVaultMethods["inventoryChromiumProfiles"]>>;

interface BrowserWithProfiles {
  browser: BrowserChoice;
  profiles: ProfileChoice[];
  error: boolean;
}

function countLabel(
  count: number | null | undefined,
  status: "available" | "unavailable" | "locked" | undefined,
): string {
  if (status === "locked") return "Cookies: locked";
  if (count == null) return "Cookies: count unavailable";
  return `Cookies: ${count}`;
}

function failureMessage(result: Extract<BrowserCookieImportResult, { ok: false }>): string {
  switch (result.code) {
    case "permission_denied":
      return "The operating system denied access to this browser profile.";
    case "reader_unavailable":
      return "Synara's browser cookie reader is unavailable.";
    case "source_too_large":
      return "Synara stopped safely because this profile exceeds the secure cookie transfer limit. Choose a smaller profile or import cookies for one site from a chat.";
    case "redaction_capacity":
      return "Synara stopped because the secure cookie cleanup limit was reached and restarted its browser worker. Retry after reopening the target, then sign in directly if needed.";
    case "target_capacity":
      return "Synara stopped because this target profile has reached Chromium's safe cookie capacity. Existing target cookies were preserved.";
    case "target_eviction":
      return "Synara stopped because Chromium removed existing target cookies during transfer. Review the target profile before retrying.";
    case "target_failed":
      return "Synara could not add these cookies to the target profile. Existing sessions may have changed; review the profile before retrying.";
    case "timed_out":
      return "The browser profile could not be read before the operation timed out.";
    case "source_missing":
      return "This browser profile is no longer available. Refresh the list and retry.";
    case "cancelled":
      return "Import cancelled. Some cookies may already have been copied; review the session before retrying.";
    case "reader_failed":
      return "Synara could not read or decrypt this browser profile.";
    case "transfer_failed":
      return "The cookie transfer could not be verified.";
  }
}

function resultMessage(result: BrowserCookieImportResult): string {
  if (!result.ok) return failureMessage(result);
  const warningCount = result.warnings.reduce((sum, warning) => sum + warning.count, 0);
  const appBoundSkipped =
    result.platform === "windows" &&
    (result.browser === "chrome" || result.browser === "edge") &&
    result.warnings.some((warning) => warning.code === "decrypt_failed");
  const warningSummary = appBoundSkipped
    ? `, ${warningCount} could not be transferred. Some Chrome/Edge cookies could not be decrypted. Synara does not use App-Bound injection, so App-Bound cookies cannot be imported; sign in within Synara for those sites.`
    : warningCount
      ? `, ${warningCount} could not be transferred`
      : "";
  const sessionRestoreWarning =
    result.sessionRestore === "unavailable"
      ? " Secure restoration of session-only cookies is unavailable; some sign-ins may not survive restart."
      : "";
  return `${result.imported} imported, ${result.skipped} skipped${warningSummary}.${sessionRestoreWarning}`;
}

export function BrowserSessionImport({
  api,
  onBusyChange,
}: {
  api: BrowserVaultMethods;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [browsers, setBrowsers] = useState<BrowserWithProfiles[]>([]);
  const [inventory, setInventory] = useState<Inventory>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const cancelRequested = useRef(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, string>>({});
  const [refreshCount, setRefreshCount] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(null);
    setBrowsers([]);
    setResults({});
    setConfirmed(false);
    void Promise.all([api.cookieSources(), api.inventoryChromiumProfiles().catch(() => [])])
      .then(async ([sources, nextInventory]) => {
        const inspected = await Promise.all(
          sources.map(async (browser) => {
            try {
              return { browser, profiles: await api.cookieProfiles(browser.id), error: false };
            } catch {
              return { browser, profiles: [], error: true };
            }
          }),
        );
        const discovered = inspected.filter(({ profiles, error }) => error || profiles.length > 0);
        if (!active) return;
        setInventory(nextInventory);
        setBrowsers(discovered);
        setSelected((current) =>
          Object.fromEntries(
            discovered.flatMap(({ browser, profiles }) =>
              profiles.map((profile) => {
                const key = `${browser.id}:${profile.id}`;
                return [key, current[key] ?? true];
              }),
            ),
          ),
        );
      })
      .catch(() => {
        if (active) setLoadError("Installed browsers could not be inspected.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, refreshCount]);

  const selectedProfiles = useMemo(
    () =>
      browsers.flatMap(({ browser, profiles }) =>
        profiles
          .filter((profile) => selected[`${browser.id}:${profile.id}`] === true)
          .map((profile) => ({ browser, profile })),
      ),
    [browsers, selected],
  );

  const run = async () => {
    if (busy || !confirmed || selectedProfiles.length === 0) return;
    setBusy(true);
    setCancelling(false);
    cancelRequested.current = false;
    onBusyChange?.(true);
    setConfirmed(false);
    setResults({});
    try {
      for (const { browser, profile } of selectedProfiles) {
        if (cancelRequested.current) break;
        const key = `${browser.id}:${profile.id}`;
        try {
          const result = await api.importCookies({
            browser: Schema.decodeUnknownSync(BrowserCookieSource)(browser.id),
            profile: profile.id,
            scope: "profile",
            confirmed: true,
          });
          setResults((current) => ({ ...current, [key]: resultMessage(result) }));
          if (!result.ok && result.code === "cancelled") break;
        } catch {
          setResults((current) => ({
            ...current,
            [key]: cancelRequested.current
              ? "Import cancelled. Some cookies may already have been copied; review the session before retrying."
              : "Import stopped before Synara could verify the result. Retry this profile.",
          }));
          if (cancelRequested.current) break;
        }
      }
    } finally {
      setBusy(false);
      setCancelling(false);
      cancelRequested.current = false;
      onBusyChange?.(false);
    }
  };

  const toggleBrowser = (browser: BrowserChoice, profiles: ProfileChoice[], checked: boolean) => {
    setSelected((current) => ({
      ...current,
      ...Object.fromEntries(profiles.map((profile) => [`${browser.id}:${profile.id}`, checked])),
    }));
  };

  return (
    <section aria-label="Import signed-in sessions" className="space-y-3 text-ui leading-snug">
      <div>
        <h3 className="text-ui-lg font-medium">Signed-in sessions</h3>
        <p className="text-ui-sm text-muted-foreground">
          Choose browser profiles. Synara will copy compatible cookies for all sites in each
          selected profile.
        </p>
      </div>
      {loading ? (
        <p className="text-ui-sm text-muted-foreground" role="status">
          Looking for installed browsers…
        </p>
      ) : loadError ? (
        <p className="text-ui-sm text-destructive" role="alert">
          {loadError}
        </p>
      ) : browsers.length === 0 ? (
        <p className="text-ui-sm text-muted-foreground">
          No supported installed browsers were found.
        </p>
      ) : (
        <ul className="space-y-3">
          {browsers.map(({ browser, profiles, error }) => {
            const allSelected =
              profiles.length > 0 &&
              profiles.every((profile) => selected[`${browser.id}:${profile.id}`] === true);
            return (
              <li key={browser.id} className="space-y-2 rounded-lg border p-3">
                <label className="flex items-center gap-2 font-medium">
                  <Checkbox
                    checked={allSelected}
                    disabled={busy || profiles.length === 0}
                    onCheckedChange={(checked) =>
                      toggleBrowser(browser, profiles, checked === true)
                    }
                    aria-label={`Select all ${browser.name} profiles`}
                  />
                  {browser.name}
                </label>
                {error ? (
                  <p className="pl-6 text-ui-sm text-muted-foreground">
                    Profiles could not be inspected.
                  </p>
                ) : profiles.length === 0 ? (
                  <p className="pl-6 text-ui-sm text-muted-foreground">No profiles found.</p>
                ) : (
                  <ul className="space-y-2 pl-6">
                    {profiles.map((profile) => {
                      const key = `${browser.id}:${profile.id}`;
                      const inventoryBrowser = inventory.find(({ id }) => id === browser.id);
                      const inventoryProfile = inventoryBrowser?.profiles.find(
                        ({ id }) => id === profile.id,
                      );
                      return (
                        <li key={profile.id}>
                          <label className="flex items-start gap-2">
                            <Checkbox
                              checked={selected[key] === true}
                              disabled={busy}
                              onCheckedChange={(checked) =>
                                setSelected((current) => ({ ...current, [key]: checked === true }))
                              }
                              aria-label={`Select ${browser.name} ${profile.name}`}
                            />
                            <span className="min-w-0">
                              <span className="block">
                                {profile.name}
                                {inventoryProfile?.isDefault ? " (default)" : ""}
                              </span>
                              <span className="block text-ui-sm text-muted-foreground">
                                {countLabel(
                                  inventoryProfile?.cookieCount,
                                  inventoryProfile?.cookieStatus,
                                )}
                              </span>
                              {results[key] ? (
                                <span
                                  className="block text-ui-sm text-muted-foreground"
                                  role="status"
                                >
                                  {browser.name} — {profile.name}: {results[key]}
                                </span>
                              ) : null}
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {!loading ? (
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => setRefreshCount((count) => count + 1)}
          >
            Refresh browser list
          </Button>
        </div>
      ) : null}
      {browsers.length > 0 ? (
        <>
          <label className="flex items-start gap-2">
            <Checkbox
              checked={confirmed}
              disabled={busy || selectedProfiles.length === 0}
              onCheckedChange={(checked) => setConfirmed(checked === true)}
            />
            <span>
              I authorize Synara and its agents to import cookies from the selected profiles and use
              their signed-in sessions across Synara.
            </span>
          </label>
          <div className="flex justify-end">
            {busy ? (
              <Button
                size="sm"
                variant="outline"
                disabled={cancelling}
                onClick={() => {
                  cancelRequested.current = true;
                  setCancelling(true);
                  void api.cancelCookieImport().catch(() => {});
                }}
              >
                {cancelling ? "Cancelling…" : "Cancel import"}
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={!confirmed || selectedProfiles.length === 0}
                onClick={() => void run()}
              >
                Import selected sessions
              </Button>
            )}
          </div>
        </>
      ) : null}
    </section>
  );
}
