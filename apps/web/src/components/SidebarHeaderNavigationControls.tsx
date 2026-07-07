// FILE: SidebarHeaderNavigationControls.tsx
// Purpose: Single source for the leading chrome cluster (sidebar toggle + route arrows).
// Layer: Shared web shell chrome
// Depends on: Sidebar state plus AppNavigationButtons

import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { FaFutbol } from "react-icons/fa";

import { AppNavigationButtons } from "./AppNavigationButtons";
import { Button } from "./ui/button";
import { SidebarTrigger, useSidebar } from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { cn } from "~/lib/utils";

/** Quick entry to the World Cup 2026 ball-physics playground, sat beside the route arrows. */
function WorldCupButton() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-7 shrink-0 rounded-lg text-muted-foreground/75 hover:text-foreground"
            aria-label={t("app.worldCup2026")}
            onClick={() => void navigate({ to: "/worldcup" })}
          />
        }
      >
        <FaFutbol className="size-4" />
      </TooltipTrigger>
      <TooltipPopup side="bottom">{t("app.worldCup2026")}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * The leading chrome cluster: the sidebar toggle followed by the route nav arrows.
 *
 * It renders in two distinct places — inside the OPEN sidebar header (where it
 * slides off-canvas with the sidebar) and in host top bars AFTER an off-canvas
 * close (chat/workspace/settings/plugin headers). Keeping it in ONE component is
 * what makes those two states visually identical: same trigger tone, icon size,
 * and gap, so toggling the sidebar never changes the button's brightness or the
 * cluster spacing. The wrapper layout (hidden/md:flex, ml-auto, …) varies per host,
 * so it is passed in via `className`; the inner controls stay constant.
 */
export function SidebarLeadingControls({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <div className={cn("flex shrink-0 items-center gap-0.5", className)}>
      <SidebarTrigger
        className="size-7 shrink-0 text-muted-foreground/75 hover:text-foreground"
        aria-label={t("sidebar.toggleThreadSidebar")}
      />
      <AppNavigationButtons className="ms-0" />
      <WorldCupButton />
    </div>
  );
}

/**
 * Host-header variant of {@link SidebarLeadingControls}: only appears once the
 * in-sidebar cluster is gone (sidebar collapsed, or mobile where the drawer floats
 * over content). When the sidebar is open on desktop the in-sidebar header owns the
 * cluster, so this renders nothing to avoid a duplicate set of controls.
 */
export function SidebarHeaderNavigationControls() {
  const { isMobile, open } = useSidebar();

  if (!isMobile && open) {
    return null;
  }

  return <SidebarLeadingControls />;
}
