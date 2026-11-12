// FILE: useDefaultDesktopAppIcon.ts
// Purpose: The app icon this build (Stable, Beta, dev) uses until the user picks another.
// Layer: Settings hook
// Exports: useDefaultDesktopAppIcon

import { desktopFlavorFromProtocol } from "@synara/shared/betaFeatures";
import { useMemo } from "react";

import { defaultDesktopAppIconForFlavor } from "~/appSettings";

export function useDefaultDesktopAppIcon() {
  return useMemo(
    () =>
      defaultDesktopAppIconForFlavor(
        desktopFlavorFromProtocol(
          typeof window === "undefined" ? undefined : window.location?.protocol,
          import.meta.env.DEV,
        ),
      ),
    [],
  );
}
