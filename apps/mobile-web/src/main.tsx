import "@fontsource-variable/inter";
import { RouterProvider } from "@tanstack/react-router";
import React from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";
import { capturePairingTokenFromHash } from "./lib/mobileLogic";
import { registerCompanionServiceWorker } from "./registerServiceWorker";
import { router } from "./router";

capturePairingTokenFromHash(window.location.hash, () => {
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
});
registerCompanionServiceWorker();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
