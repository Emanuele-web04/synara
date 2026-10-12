import type { BrowserVaultMethods } from "@synara/contracts";
import { useEffect, useState } from "react";
import { readNativeApi } from "~/nativeApi";
import { BrowserPasswordImport } from "./BrowserPasswordImport";
import { BrowserSessionImport } from "./BrowserSessionImport";

export const BROWSER_IMPORT_DESCRIPTION =
  "Review installed browser profiles and choose what to import. Saved-password import is currently supported only on macOS.";

export function BrowserImportPanel({
  api,
  onBusyChange,
}: {
  api?: BrowserVaultMethods;
  onBusyChange?: (busy: boolean) => void;
}) {
  const browserApi = api ?? readNativeApi()?.browser.vault;
  const [sessionsBusy, setSessionsBusy] = useState(false);
  const [passwordsBusy, setPasswordsBusy] = useState(false);
  useEffect(() => {
    onBusyChange?.(sessionsBusy || passwordsBusy);
  }, [onBusyChange, passwordsBusy, sessionsBusy]);
  if (!browserApi)
    return (
      <section aria-label="Import from browsers" className="space-y-2 text-ui">
        <h2 className="text-ui-lg font-semibold">Browser import</h2>
        <p className="text-ui-sm text-muted-foreground">
          Browser import is available in the Synara desktop app.
        </p>
      </section>
    );
  return (
    <section aria-label="Import from browsers" className="space-y-5">
      <header className="space-y-1">
        <h2 className="text-ui-lg font-semibold">Import from browsers</h2>
        <p className="text-ui text-muted-foreground">
          {BROWSER_IMPORT_DESCRIPTION} Nothing is imported until you confirm each type.
        </p>
      </header>
      <BrowserSessionImport api={browserApi} onBusyChange={setSessionsBusy} />
      <BrowserPasswordImport api={browserApi} onBusyChange={setPasswordsBusy} />
    </section>
  );
}
