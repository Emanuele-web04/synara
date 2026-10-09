import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";

import "@fontsource-variable/jetbrains-mono";
import "./index.css";

import { appHistory } from "./appNavigation";
import { getRouter } from "./router";
import { APP_DISPLAY_NAME } from "./branding";
import { isDesktopPresentation } from "~/lib/hosts/workspacePresentation";
import { readWorkspaceFrame } from "./lib/hosts/workspaceFrame";
import { isMacPlatform } from "./lib/utils";
import { installGlassOverlayCutout } from "./lib/glassOverlayCutout";
import { trackProductNavigation } from "./lib/productAnalytics";
import { installRendererErrorDiagnostics } from "./lib/rendererErrorDiagnostics";

const disposeRendererDiagnostics = installRendererErrorDiagnostics();
if (import.meta.hot) import.meta.hot.dispose(() => disposeRendererDiagnostics?.());

const router = getRouter(appHistory);
const disposeProductNavigation = router.subscribe("onResolved", ({ toLocation, pathChanged }) => {
  if (pathChanged) trackProductNavigation(toLocation.pathname);
});
if (import.meta.hot) import.meta.hot.dispose(disposeProductNavigation);
const rootElement = document.getElementById("root") as HTMLElement;

document.title = APP_DISPLAY_NAME;
if (readWorkspaceFrame()) document.documentElement.dataset.workspaceFrame = "true";

if (isDesktopPresentation) {
  document.documentElement.dataset.runtime = "electron";
  // macOS desktop windows are transparent vibrancy windows (see getWindowMaterialOptions
  // in apps/desktop). A `backdrop-filter` cannot hide page content over a see-through
  // region there, so floating overlays get the page cut out from under them instead.
  if (isMacPlatform(navigator.platform)) {
    document.documentElement.dataset.windowTransparent = "true";
    const disposeGlassOverlayCutout = installGlassOverlayCutout(rootElement);
    if (import.meta.hot) import.meta.hot.dispose(disposeGlassOverlayCutout);
  }
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
