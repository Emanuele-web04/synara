import type { BrowserPasswordImportResult, BrowserVaultMethods } from "@synara/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrowserVaultMaster } from "./BrowserVaultMaster";
import { Button } from "./ui/button";

type Inventory = Awaited<ReturnType<BrowserVaultMethods["inventoryChromiumProfiles"]>>;

function countLabel(count: number | null, kind: string, status: string) {
  if (status === "locked") return `${kind}: locked`;
  if (count === null) return `${kind}: unavailable`;
  return `${count} ${kind}`;
}

function failureMessage(result: Extract<BrowserPasswordImportResult, { ok: false }>) {
  switch (result.code) {
    case "permission_denied":
      return "macOS denied access to this browser's saved-password key. Approve the Keychain prompt and retry.";
    case "keychain_unavailable":
      return "The browser's saved-password key is unavailable in Keychain.";
    case "timed_out":
      return "The browser Keychain request timed out. Close the browser and retry.";
    case "source_missing":
      return "This browser profile is no longer available. Refresh the list and retry.";
    case "too_many_logins":
      return "This profile has more saved passwords than Synara can safely import in one operation.";
    case "vault_locked":
      return "Unlock or set up Saved Logins below, then retry the import.";
    case "vault_failed":
      return "Synara could not save these passwords. Check available disk space and try again.";
    case "unsupported_platform":
      return "Password import for this browser is not available on this operating system yet.";
    case "reader_failed":
      return "Synara could not read this profile's saved passwords. Close the browser and retry.";
  }
}

export function BrowserPasswordImport({
  api,
  onBusyChange,
}: {
  api: BrowserVaultMethods;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [inventory, setInventory] = useState<Inventory>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [inventoryStatus, setInventoryStatus] = useState<"loading" | "ready" | "error">("loading");
  const [vaultAction, setVaultAction] = useState<"setup" | "unlock" | null>(null);
  const [vaultStatus, setVaultStatus] = useState<"loading" | "ready" | "error">("loading");
  const [masterAction, setMasterAction] = useState<"setup" | "unlock" | null>(null);
  const inventoryRequest = useRef(0);
  const vaultRequest = useRef(0);

  const refreshVaultAccess = useCallback(async () => {
    const request = ++vaultRequest.current;
    setVaultStatus("loading");
    try {
      const snapshot = await api.snapshot();
      if (request !== vaultRequest.current) return;
      setVaultAction(
        snapshot.protection.locked ? (snapshot.protection.configured ? "unlock" : "setup") : null,
      );
      setVaultStatus("ready");
    } catch {
      if (request === vaultRequest.current) {
        setStatus("Saved Logins could not be inspected. Try again before importing passwords.");
        setVaultStatus("error");
      }
    }
  }, [api]);

  const loadInventory = useCallback(async () => {
    const request = ++inventoryRequest.current;
    setInventoryStatus("loading");
    setInventory([]);
    try {
      const next = await api.inventoryChromiumProfiles();
      if (request !== inventoryRequest.current) return;
      setInventory(next);
      setSelected(
        Object.fromEntries(
          next.flatMap((browser) =>
            browser.profiles.map((profile) => [`${browser.id}:${profile.id}`, true]),
          ),
        ),
      );
      setInventoryStatus("ready");
    } catch {
      if (request === inventoryRequest.current) setInventoryStatus("error");
    }
  }, [api]);

  useEffect(() => {
    void loadInventory();
    void refreshVaultAccess();
    const unsubscribe = api.onChanged(() => void refreshVaultAccess());
    return () => {
      inventoryRequest.current++;
      vaultRequest.current++;
      unsubscribe();
    };
  }, [api, loadInventory, refreshVaultAccess]);

  const selectedProfiles = useMemo(
    () =>
      inventory.flatMap((browser) =>
        browser.profiles
          .filter((profile) => selected[`${browser.id}:${profile.id}`] === true)
          .map((profile) => ({ browser, profile })),
      ),
    [inventory, selected],
  );

  const run = async () => {
    if (busy || !confirmed || selectedProfiles.length === 0) return;
    setBusy(true);
    onBusyChange?.(true);
    setStatus(null);
    const outcomes: string[] = [];
    try {
      for (const { browser, profile } of selectedProfiles) {
        try {
          const result = await api.importPasswords({
            browser: browser.id,
            profile: profile.id,
            confirmed: true,
          });
          outcomes.push(
            result.ok
              ? `${browser.name} — ${profile.name}: ${result.imported} imported, ${result.skipped} skipped${result.warnings.length ? "; provenance could not be saved" : ""}.`
              : `${browser.name} — ${profile.name}: ${failureMessage(result)}`,
          );
          if (!result.ok && result.code === "vault_locked") {
            void refreshVaultAccess();
          }
        } catch {
          outcomes.push(`${browser.name} — ${profile.name}: Synara could not finish this import.`);
        }
      }
    } finally {
      setStatus(outcomes.join(" "));
      setBusy(false);
      setConfirmed(false);
      onBusyChange?.(false);
    }
  };

  return (
    <section
      className="mt-4 space-y-3 border-t pt-4 text-ui leading-snug"
      aria-label="Import saved passwords"
    >
      <h3 className="font-medium text-muted-foreground">Import saved passwords</h3>
      {inventoryStatus === "loading" ? (
        <p role="status" className="text-ui-sm text-muted-foreground">
          Looking for installed Chromium browsers…
        </p>
      ) : inventoryStatus === "error" ? (
        <div className="space-y-2">
          <p role="alert" className="text-ui-sm text-destructive">
            Installed browser profiles could not be inspected.
          </p>
          <Button size="sm" variant="outline" onClick={() => void loadInventory()}>
            Retry browser detection
          </Button>
        </div>
      ) : inventory.length === 0 ? (
        <p className="text-ui-sm text-muted-foreground">
          No supported installed Chromium browsers were found.
        </p>
      ) : (
        <ul className="space-y-3">
          {inventory.map((browser) => (
            <li key={browser.id} className="space-y-2">
              <div className="font-medium">{browser.name}</div>
              {browser.profiles.length === 0 ? (
                <p className="text-ui-sm text-muted-foreground">
                  {browser.profileStatus === "unavailable"
                    ? "Profile data unavailable"
                    : "No profiles found"}
                </p>
              ) : (
                <ul className="space-y-1 pl-3">
                  {browser.profiles.map((profile) => {
                    const id = `${browser.id}:${profile.id}`;
                    return (
                      <li key={profile.id}>
                        <label className="flex items-start gap-2">
                          <input
                            type="checkbox"
                            checked={selected[id] === true}
                            disabled={busy}
                            onChange={(event) =>
                              setSelected((current) => ({ ...current, [id]: event.target.checked }))
                            }
                          />
                          <span>
                            {profile.name}
                            {profile.isDefault ? " (default)" : ""}
                            <span className="block text-ui-sm text-muted-foreground">
                              {countLabel(profile.cookieCount, "cookies", profile.cookieStatus)} ·{" "}
                              {countLabel(
                                profile.passwordCount,
                                "saved passwords",
                                profile.passwordStatus,
                              )}
                            </span>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
      {vaultAction ? (
        <div className="space-y-2 rounded-md border p-3">
          <p className="text-ui-sm text-muted-foreground">
            {vaultAction === "setup"
              ? "Set up Saved Logins before importing passwords."
              : "Unlock Saved Logins before importing passwords."}
          </p>
          {masterAction ? (
            <BrowserVaultMaster
              api={api}
              action={{ kind: masterAction }}
              onDone={() => {
                setMasterAction(null);
                void refreshVaultAccess();
              }}
            />
          ) : (
            <Button size="sm" variant="outline" onClick={() => setMasterAction(vaultAction)}>
              {vaultAction === "setup" ? "Set up Saved Logins" : "Unlock Saved Logins"}
            </Button>
          )}
        </div>
      ) : null}
      {vaultStatus === "loading" ? (
        <p role="status" className="text-ui-sm text-muted-foreground">
          Checking Saved Logins protection…
        </p>
      ) : vaultStatus === "error" ? (
        <Button size="sm" variant="outline" onClick={() => void refreshVaultAccess()}>
          Retry Saved Logins check
        </Button>
      ) : null}
      {inventory.length > 0 ? (
        <>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy || selectedProfiles.length === 0}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <span>
              I authorize Synara to read saved passwords from the selected profiles and copy them
              into Saved Logins. Existing logins will be skipped.
            </span>
          </label>
          {status ? (
            <p role="status" className="text-muted-foreground">
              {status}
            </p>
          ) : null}
          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={
                busy ||
                !confirmed ||
                selectedProfiles.length === 0 ||
                vaultStatus !== "ready" ||
                vaultAction !== null
              }
              onClick={() => void run()}
            >
              {busy ? "Importing…" : "Import selected passwords"}
            </Button>
          </div>
        </>
      ) : status ? (
        <p role="status" className="text-muted-foreground">
          {status}
        </p>
      ) : null}
    </section>
  );
}
