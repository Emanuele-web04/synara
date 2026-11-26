// FILE: useRemoteHostState.ts
// Purpose: This computer's remote-access state (trusted devices, invitations, the
//          owner's allow switch), polled while the Connections pane shows it.
// Layer: Web remote-access feature hook
// Depends on: the owner `remoteAccess` RPC `list` operation.

import { useCallback, useEffect, useRef, useState } from "react";

import {
  callRemoteAccess,
  remoteAccessErrorMessage,
  type RemoteHostState,
} from "~/lib/hosts/remoteAccess";

const POLL_INTERVAL_MS = 3_000;

export function useRemoteHostState(): {
  readonly state: RemoteHostState | null;
  readonly loadError: string | null;
  readonly refresh: () => Promise<void>;
} {
  const [state, setState] = useState<RemoteHostState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const mounted = useRef(true);
  // Monotonic request generation: a slow poll must not overwrite a newer answer.
  const sequence = useRef(0);

  const refresh = useCallback(async () => {
    const current = ++sequence.current;
    try {
      const next = await callRemoteAccess({ operation: "list" });
      if (!mounted.current || current !== sequence.current) return;
      if (next.kind === "host-state") {
        setState(next);
        setLoadError(null);
      }
    } catch (cause) {
      if (mounted.current && current === sequence.current)
        setLoadError(remoteAccessErrorMessage(cause, "Remote access is unavailable."));
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [refresh]);

  return { state, loadError, refresh };
}
