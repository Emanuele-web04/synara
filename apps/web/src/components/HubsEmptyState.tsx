// FILE: HubsEmptyState.tsx
// Purpose: The Hubs landing when no hub exists yet. Renders on the shared route card, like
//          the Automations landing, so the panel seam, surface fill, and route header match
//          every other view instead of floating on the bare shell.
// Layer: Route UI component
// Exports: HubsEmptyState
// Depends on: RouteInsetSurface, RouteSurface.

import { RouteInsetSurface } from "./RouteInsetSurface";
import { RouteSurface, RouteSurfaceHeader } from "./RouteSurface";
import { useTranslation } from "~/i18n";

export function HubsEmptyState() {
  const { t } = useTranslation();

  return (
    <RouteInsetSurface>
      <RouteSurface>
        <RouteSurfaceHeader />
        <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-6 pb-16 text-center">
          <p className="text-ui-lg font-medium text-foreground">{t("No hubs yet")}</p>
          <p className="text-ui text-muted-foreground">
            {t("Create one from the sidebar to coordinate work across repos.")}
          </p>
        </main>
      </RouteSurface>
    </RouteInsetSurface>
  );
}
