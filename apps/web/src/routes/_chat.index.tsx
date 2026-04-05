import { DEFAULT_RUNTIME_MODE } from "@t3tools/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { useAppSettings } from "~/appSettings";
import { resolveSidebarNewThreadEnvMode } from "~/components/Sidebar.logic";
import { useComposerDraftStore } from "../composerDraftStore";
import { newThreadId } from "../lib/utils";
import { useStore } from "../store";

function ChatIndexRouteView() {
  const projects = useStore((store) => store.projects);
  const navigate = useNavigate();
  const { settings: appSettings } = useAppSettings();
  const hasRedirected = useRef(false);
  const firstProject = projects[0];

  useEffect(() => {
    if (!firstProject || hasRedirected.current) return;
    hasRedirected.current = true;

    const { getDraftThreadByProjectId, setProjectDraftThreadId, applyStickyState } =
      useComposerDraftStore.getState();

    // Reuse existing draft thread for this project if one exists
    const existingDraft = getDraftThreadByProjectId(firstProject.id);
    if (existingDraft) {
      void navigate({
        to: "/$threadId",
        params: { threadId: existingDraft.threadId },
        replace: true,
      });
      return;
    }

    // Create a new draft thread
    const threadId = newThreadId();
    const envMode = resolveSidebarNewThreadEnvMode({
      defaultEnvMode: appSettings.defaultThreadEnvMode,
    });

    setProjectDraftThreadId(firstProject.id, threadId, {
      createdAt: new Date().toISOString(),
      branch: null,
      worktreePath: null,
      envMode,
      runtimeMode: DEFAULT_RUNTIME_MODE,
    });
    applyStickyState(threadId);

    void navigate({
      to: "/$threadId",
      params: { threadId },
      replace: true,
    });
  }, [firstProject, navigate, appSettings.defaultThreadEnvMode]);

  return null;
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
