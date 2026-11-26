import { ThreadId } from "@synara/contracts";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { DESIGN_CANVAS_ON } from "~/betaFeatures";
import CanvasWorkView from "~/components/canvas/CanvasWorkView";

export const Route = createFileRoute("/_chat/canvas/$workId")({
  beforeLoad: () => {
    // Canvas is Beta-only; the server refuses its RPCs on Stable as well.
    if (!DESIGN_CANVAS_ON) throw redirect({ to: "/", replace: true });
  },
  validateSearch: (search: Record<string, unknown>) => ({
    page: typeof search.page === "string" ? search.page : undefined,
    chat: typeof search.chat === "string" ? search.chat : undefined,
  }),
  component: CanvasRoute,
});
function CanvasRoute() {
  const { workId } = Route.useParams();
  const { page, chat } = Route.useSearch();
  return (
    <CanvasWorkView
      key={workId}
      workId={workId}
      pageId={page}
      chatThreadId={chat ? ThreadId.makeUnsafe(chat) : undefined}
    />
  );
}
