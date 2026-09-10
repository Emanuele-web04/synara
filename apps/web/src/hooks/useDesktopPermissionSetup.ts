import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { DesktopPermissionSetupState } from "@synara/contracts";
import { serverQueryKeys } from "~/lib/serverReactQuery";

/** Push-based setup state; Electron checks while System Settings owns focus. */
export function useDesktopPermissionSetup(active = true) {
  const [state, setState] = useState<DesktopPermissionSetupState | null>(null);
  const queryClient = useQueryClient();
  useEffect(() => {
    const bridge = window.desktopBridge?.permissions;
    if (!active || !bridge) return;
    let disposed = false;
    let receivedEvent = false;
    let lastGrants = "";
    const apply = (next: DesktopPermissionSetupState) => {
      if (disposed) return;
      setState(next);
      const grants = JSON.stringify(next.grants);
      if (Object.keys(next.grants).length && grants !== lastGrants) {
        lastGrants = grants;
        void queryClient.invalidateQueries({ queryKey: serverQueryKeys.computerStatus() });
      }
    };
    const unsubscribe = bridge.onState((next) => {
      receivedEvent = true;
      apply(next);
    });
    void bridge
      .getState()
      .then((next) => {
        if (!receivedEvent) apply(next);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [active, queryClient]);
  return state;
}
