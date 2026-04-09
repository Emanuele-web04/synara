import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { useWorkspaceStore } from "~/workspaceStore";

function WorkspaceIndexRouteView() {
  const navigate = useNavigate();
  const workspaceId = useWorkspaceStore((state) => state.workspacePages[0]?.id ?? null);
  const redirectedRef = useRef(false);

  useEffect(() => {
    if (!workspaceId || redirectedRef.current) {
      return;
    }
    redirectedRef.current = true;
    void navigate({
      to: "/workspace/$workspaceId",
      params: { workspaceId },
      replace: true,
    });
  }, [navigate, workspaceId]);

  return null;
}

export const Route = createFileRoute("/_chat/workspace/")({
  component: WorkspaceIndexRouteView,
});
