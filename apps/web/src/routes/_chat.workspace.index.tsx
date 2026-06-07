import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { useWorkspaceStore } from "~/workspaceStore";

function WorkspaceIndexRouteView() {
  const navigate = useNavigate();
  const workspaceId = useWorkspaceStore((state) => state.workspacePages[0]?.id ?? null);
  const redirectedRef = useRef(false);

  useEffect(() => {
    if (redirectedRef.current) {
      return;
    }
    redirectedRef.current = true;
    // Always leave this index route: into the first workspace when one exists,
    // otherwise home (so a direct load can never strand on a blank pane).
    void navigate(
      workspaceId
        ? { to: "/workspace/$workspaceId", params: { workspaceId }, replace: true }
        : { to: "/", replace: true },
    );
  }, [navigate, workspaceId]);

  return null;
}

export const Route = createFileRoute("/_chat/workspace/")({
  component: WorkspaceIndexRouteView,
});
