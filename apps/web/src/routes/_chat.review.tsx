// FILE: _chat.review.tsx
// Purpose: Layout route for the review area; renders the index board or the $reference detail.
// Layer: Route layout

import { createFileRoute, Outlet } from "@tanstack/react-router";

function ReviewLayoutRoute() {
  return <Outlet />;
}

export const Route = createFileRoute("/_chat/review")({
  component: ReviewLayoutRoute,
});
