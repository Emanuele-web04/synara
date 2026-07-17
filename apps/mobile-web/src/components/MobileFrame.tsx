import {
  IconAdjustmentsHorizontal,
  IconHome,
  IconPlugConnected,
  IconSettings,
} from "@tabler/icons-react";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useCompanion } from "../companionContext";
import { ConnectionScreen } from "../screens/ConnectionScreen";
import { OfflineScreen } from "../screens/OfflineScreen";
import { PairingScreen } from "../screens/PairingScreen";

export function MobileFrame() {
  const { phase } = useCompanion();
  const onboarding = useRouterState({
    select: (state) => state.location.pathname.endsWith("/onboarding"),
  });

  if (phase === "checking-session" || phase === "connecting") {
    return <ConnectionScreen phase={phase} />;
  }
  if (phase === "unauthenticated") return <PairingScreen />;
  if (phase === "offline") return <OfflineScreen />;

  return (
    <div className="mobile-frame">
      <ConnectionStrip />
      <main className="screen-stack" id="main-content">
        <Outlet />
      </main>
      {onboarding ? null : <BottomNavigation />}
    </div>
  );
}

function ConnectionStrip() {
  const { session } = useCompanion();
  return (
    <div className="connection-strip" aria-label="Connected to Synara">
      <IconPlugConnected aria-hidden="true" size={14} stroke={1.8} />
      <span>Connected</span>
      <span aria-hidden="true">·</span>
      <span className="truncate">{window.location.hostname}</span>
      <span className="connection-strip__version">v{session?.serverVersion ?? "—"}</span>
    </div>
  );
}

function BottomNavigation() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const threadActive = pathname.includes("/threads/") || pathname.includes("/projects/");
  return (
    <nav className="bottom-nav" aria-label="Primary navigation">
      <Link
        to="/"
        className="bottom-nav__item"
        activeProps={{ "data-active": true }}
        activeOptions={{ exact: true }}
      >
        <IconHome aria-hidden="true" size={21} stroke={1.8} />
        <span>Home</span>
      </Link>
      <Link
        to="/tasks"
        className="bottom-nav__item"
        activeProps={{ "data-active": true }}
        data-active={threadActive || undefined}
      >
        <IconAdjustmentsHorizontal aria-hidden="true" size={21} stroke={1.8} />
        <span>Tasks</span>
      </Link>
      <Link
        to="/settings"
        className="bottom-nav__item"
        activeProps={{ "data-active": true }}
      >
        <IconSettings aria-hidden="true" size={21} stroke={1.8} />
        <span>Settings</span>
      </Link>
    </nav>
  );
}
