// FILE: _chat.studio.index.tsx
// Purpose: Legacy redirect — the Studio surface is now Groups at /groups.
// Layer: Routing

import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_chat/studio/")({
  beforeLoad: () => {
    throw redirect({ to: "/groups", replace: true });
  },
});
