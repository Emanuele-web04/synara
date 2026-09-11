import { useCallback, useEffect, useRef } from "react";
import type { ThreadId } from "@synara/contracts";
import type { ComposerComputerControlMode } from "~/computerControlMode";
import { readNativeApi } from "~/nativeApi";
import { toastManager } from "~/components/ui/toast";

/** Explicit chat activation also enters the same native permission guide as AppSnap. */
export function useComputerControlModeChange({
  threadId,
  setMode,
  focusComposer,
}: {
  threadId: ThreadId;
  setMode: (
    threadId: ThreadId,
    mode: ComposerComputerControlMode,
    options: { revokeQueued: boolean; generation: number },
  ) => void;
  focusComposer: () => void;
}) {
  const sequence = useRef(0);
  useEffect(
    () => () => {
      sequence.current += 1;
    },
    [threadId],
  );
  const change = useCallback(
    (mode: ComposerComputerControlMode) => {
      const api = readNativeApi();
      if (!api) return;
      const request = ++sequence.current;
      const current = () => request === sequence.current;
      let settingUp = false;
      void (async () => {
        const result = await api.computer.setControlEnabled({ threadId, enabled: mode !== "off" });
        if (!current()) return;
        setMode(threadId, result.enabled ? mode : "off", {
          revokeQueued: mode === "off",
          generation: result.generation ?? 0,
        });
        const permissions = window.desktopBridge?.permissions;
        if (result.enabled && permissions) {
          settingUp = true;
          // Check live state, not a possibly stale composer availability snapshot.
          const status = await api.computer.getStatus({});
          if (!current()) return;
          if (status.availability.kind === "permission-required") {
            await permissions.start("computer");
            return; // Keep Settings/its floating guide in front.
          }
        }
        if (current()) focusComposer();
      })().catch((error) => {
        if (!current()) return;
        toastManager.add({
          title: settingUp
            ? "Computer permission setup could not start"
            : "Computer control could not be changed",
          description: String(error),
          type: "error",
        });
      });
    },
    [threadId, setMode, focusComposer],
  );
  return { change, sequence };
}
