// FILE: src/main.tsx
// Purpose: Dashboard entry point.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";

import { App } from "./App";
import { applySystemTheme } from "./theme";

// CSP blocks inline scripts, so the theme is applied here — before React
// renders — to avoid a flash of the wrong mode.
applySystemTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
