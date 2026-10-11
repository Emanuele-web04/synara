import { useMemo } from "react";
import { buildFeedbackSubmission } from "../feedback";
import { buildGithubIssueInterviewPrompt } from "../feedbackGithubIssue";
import { useFeedbackDialogStore } from "../feedbackDialogStore";
import { useFocusedChatContext } from "../focusedChatContext";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { appendComposerPromptText } from "../lib/chatReferences";
import { isOrdinarySpaceProject } from "../lib/spaces";
import { useWorkspacePathsStore } from "../workspacePathsStore";
import { FeedbackDialog } from "./FeedbackDialog";
import { toastManager } from "./ui/toast";

export function GlobalFeedbackDialog() {
  const { activeProject, activeProjectId } = useFocusedChatContext();
  const isOpen = useFeedbackDialogStore((state) => state.isOpen);
  const requestedInitialCategory = useFeedbackDialogStore((state) => state.initialCategory);
  const setOpen = useFeedbackDialogStore((state) => state.setOpen);

  const { handleNewThread, projects, threadsHydrated } = useHandleNewThread();
  // The agent draft path targets a real user project, so the always-present Home and
  // Studio containers must not count: with zero ordinary projects there is no project
  // to draft the bug-report thread in and the path stays hidden.
  const homeDir = useWorkspacePathsStore((store) => store.homeDir);
  const chatWorkspaceRoot = useWorkspacePathsStore((store) => store.chatWorkspaceRoot);
  const studioWorkspaceRoot = useWorkspacePathsStore((store) => store.studioWorkspaceRoot);
  const ordinaryProjects = useMemo(
    () =>
      projects.filter((project) =>
        isOrdinarySpaceProject(project, { homeDir, chatWorkspaceRoot, studioWorkspaceRoot }),
      ),
    [chatWorkspaceRoot, homeDir, projects, studioWorkspaceRoot],
  );
  const hasProjects = ordinaryProjects.length > 0;
  // handleNewThread returns null until the thread store finishes hydrating, so
  // offering the draft action earlier would surface a guaranteed error toast.
  const canDraftIssue = hasProjects && threadsHydrated;

  const onDraftGithubIssue = async (details: string) => {
    // The active container can be Home or Studio even when ordinary projects exist;
    // the draft must land in a real user project, so prefer an ordinary one.
    const activeProjectIsOrdinary =
      activeProject != null &&
      isOrdinarySpaceProject(activeProject, { homeDir, chatWorkspaceRoot, studioWorkspaceRoot });
    const projectId =
      (activeProjectIsOrdinary ? activeProjectId : undefined) ?? ordinaryProjects[0]?.id ?? null;
    if (!projectId) {
      throw new Error("No project available.");
    }
    const submission = buildFeedbackSubmission({ category: "bug", details });
    const prompt = buildGithubIssueInterviewPrompt({ details: submission.details });
    // The bug-report draft must not claim the project's new-thread slot: a
    // fresh mapped draft would evict and delete the user's unsent composer
    // text. preserveProjectDraft keeps the existing draft untouched.
    const threadId = await handleNewThread(projectId, {
      fresh: true,
      preserveProjectDraft: true,
    });
    if (!threadId) {
      throw new Error("Could not open a draft thread.");
    }

    appendComposerPromptText(threadId, prompt);
    setOpen(false);
    toastManager.add({
      type: "success",
      title: "Bug-report thread ready",
      description: "Review the prompt and send it.",
    });
  };

  return (
    <FeedbackDialog
      open={isOpen}
      initialCategory={requestedInitialCategory}
      onOpenChange={setOpen}
      onDraftGithubIssue={canDraftIssue ? onDraftGithubIssue : undefined}
    />
  );
}
