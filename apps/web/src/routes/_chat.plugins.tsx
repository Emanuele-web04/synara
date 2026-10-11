// FILE: _chat.plugins.tsx
// Purpose: Registers the plugin and skill browser under the shared chat shell.
// Layer: Route
// Exports: Route

import { createFileRoute } from "@tanstack/react-router";
import { PluginLibrary } from "~/components/PluginLibrary";

export const Route = createFileRoute("/_chat/plugins")({
  component: PluginLibrary,
});
