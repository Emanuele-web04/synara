// FILE: _chat.worldcup.tsx
// Purpose: Registers the World Cup 2026 ball-physics playground under the chat shell.
// Layer: Route
// Exports: Route

import { createFileRoute } from "@tanstack/react-router";

import { WorldCup2026View } from "~/components/worldcup/WorldCup2026View";

export const Route = createFileRoute("/_chat/worldcup")({
  component: WorldCup2026View,
});
