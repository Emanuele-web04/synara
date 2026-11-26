import { createFileRoute, redirect } from "@tanstack/react-router";
import { DESIGN_CANVAS_ON } from "~/betaFeatures";
import CanvasLibraryView from "~/components/canvas/CanvasLibraryView";

export const Route = createFileRoute("/_chat/canvas/")({
  beforeLoad: () => {
    if (!DESIGN_CANVAS_ON) throw redirect({ to: "/", replace: true });
  },
  component: CanvasLibraryView,
});
