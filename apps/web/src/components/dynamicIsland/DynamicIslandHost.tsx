// FILE: DynamicIslandHost.tsx
// Purpose: Bridge the renderer thread state to the optional native macOS island helper.
//          Falls back to a hidden native snapshot when the state cannot be rendered natively
//          (user-input/plan/idle); a React fallback can be added later for cross-platform parity.

import { useEffect, useMemo, useState } from "react";

import { useAppSettings } from "~/appSettings";
import { NativeIslandCoordinator } from "~/components/dynamicIsland/NativeIslandCoordinator";
import { projectNativeIslandViewModel } from "~/components/dynamicIsland/islandViewModel";
import { useStore } from "~/store";
import { createAllThreadsSelector } from "~/storeSelectors";

function readWindowFocus(): boolean {
  return typeof document === "undefined" ? true : document.hasFocus();
}

function useWindowFocus(): boolean {
  const [focused, setFocused] = useState(readWindowFocus);

  useEffect(() => {
    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  return focused;
}

export function DynamicIslandHost() {
  const { settings } = useAppSettings();
  const selectThreads = useMemo(() => createAllThreadsSelector(), []);
  const threads = useStore(selectThreads);
  const windowFocused = useWindowFocus();
  const viewModel = useMemo(() => projectNativeIslandViewModel(threads), [threads]);

  return (
    <NativeIslandCoordinator
      viewModel={viewModel}
      enabled={settings.dynamicIslandEnabled}
      windowFocused={windowFocused}
      onNativeSnapshotActive={() => {}}
    />
  );
}
