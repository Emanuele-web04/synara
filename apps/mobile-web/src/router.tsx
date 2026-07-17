import {
  Navigate,
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { CompanionProvider } from "./companionContext";
import { MobileFrame } from "./components/MobileFrame";
import { EmptyState } from "./components/ui";
import { DiffScreen } from "./screens/DiffScreen";
import { HomeScreen } from "./screens/HomeScreen";
import { OnboardingScreen } from "./screens/OnboardingScreen";
import { ProjectScreen } from "./screens/ProjectScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { TasksScreen } from "./screens/TasksScreen";
import { ThreadScreen } from "./screens/ThreadScreen";
import { isPostPairOnboardingPending } from "./lib/onboarding";

const rootRoute = createRootRoute({
  component: () => (
    <CompanionProvider>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <MobileFrame />
    </CompanionProvider>
  ),
  notFoundComponent: () => (
    <div className="screen">
      <EmptyState
        title="Page not found"
        description="This Companion link is not available. Return to your tasks."
        action={
          <a className="button button--primary" href="/mobile/">
            Return home
          </a>
        }
      />
    </div>
  ),
});

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () =>
    isPostPairOnboardingPending() ? <Navigate to="/onboarding" replace /> : <HomeScreen />,
});
const onboardingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/onboarding",
  component: OnboardingScreen,
});
const tasksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tasks",
  component: TasksScreen,
});
const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId",
  component: ProjectScreen,
});
const threadRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/threads/$threadId",
  component: ThreadScreen,
});
const diffRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/threads/$threadId/diff",
  component: DiffScreen,
});
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsScreen,
});
const pairedRedirectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/pair",
  component: () => <Navigate to="/" replace />,
});
const offlineRedirectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/offline",
  component: () => <Navigate to="/" replace />,
});

const routeTree = rootRoute.addChildren([
  homeRoute,
  onboardingRoute,
  tasksRoute,
  projectRoute,
  threadRoute,
  diffRoute,
  settingsRoute,
  pairedRedirectRoute,
  offlineRedirectRoute,
]);

export const router = createRouter({
  routeTree,
  history: createBrowserHistory({ window }),
  basepath: "/mobile",
  defaultPreload: "intent",
  defaultPendingMinMs: 120,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
