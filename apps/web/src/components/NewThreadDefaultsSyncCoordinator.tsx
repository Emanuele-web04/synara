// FILE: NewThreadDefaultsSyncCoordinator.tsx
// Purpose: Runs the shared new-chat defaults sync for the app session.
// Layer: Web app shell

import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import {
  createNewThreadDefaultsSync,
  type NewThreadDefaultsSync,
} from "../lib/newThreadDefaultsSync";
import { serverSettingsQueryOptions } from "../lib/serverReactQuery";
import { ensureNativeApi } from "../nativeApi";

export function NewThreadDefaultsSyncCoordinator() {
  const serverDefaults = useQuery(serverSettingsQueryOptions()).data?.newThreadDefaults;
  const syncRef = useRef<NewThreadDefaultsSync | null>(null);

  useEffect(() => {
    const sync = createNewThreadDefaultsSync({
      store: useComposerDraftStore,
      // A server without shared defaults answers without them; the sync then
      // keeps the copy it last received.
      write: async (patch) =>
        (await ensureNativeApi().server.updateSettings({ newThreadDefaults: patch }))
          ?.newThreadDefaults,
    });
    syncRef.current = sync;
    return () => {
      sync.dispose();
      syncRef.current = null;
    };
  }, []);

  useEffect(() => {
    // An older server without shared defaults leaves this browser's own choices alone.
    if (serverDefaults) syncRef.current?.receive(serverDefaults);
  }, [serverDefaults]);

  return null;
}
