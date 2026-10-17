// FILE: SplashScreen.tsx
// Purpose: Render the branded startup face while the app is still booting a route or session.
// Layer: Shared app loading presentation

import { SynaraLogo } from "@synara/profile-ui/logo";
import { RouteInsetSurface } from "~/components/RouteInsetSurface";

export function SplashScreen({
  errorMessage,
  onRetry,
}: {
  errorMessage?: string | null;
  onRetry?: (() => void) | null;
}) {
  const showRetry = Boolean(errorMessage && onRetry);

  return (
    // The shared route surface, so the splash sits in the same block as every other route
    // (under the rail layout's top band) and goes clear with whole-window glass.
    <RouteInsetSurface>
      <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center">
        <div className="flex flex-col items-center gap-5 select-none">
          <SynaraLogo aria-label="Synara" className="size-24" />

          {errorMessage ? (
            <div className="flex max-w-sm flex-col items-center gap-3 px-6 text-center">
              <span className="text-sm text-muted-foreground/75">{errorMessage}</span>
              {showRetry ? (
                <button
                  type="button"
                  className="rounded-md border border-border/70 px-3 py-1.5 text-sm text-foreground/85 transition-colors hover:bg-[var(--sidebar-accent)]"
                  onClick={onRetry ?? undefined}
                >
                  Retry
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </RouteInsetSurface>
  );
}
