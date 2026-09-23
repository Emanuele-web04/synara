// FILE: src/main.tsx
// Purpose: Dashboard entry point.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@cloudflare/kumo/styles/standalone";

import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
