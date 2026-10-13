import { useTranslation } from "~/i18n";
import { ensureHomeChatProject } from "../lib/chatProjects";
import { startContainerChat, type StartContainerChatResult } from "../lib/startContainerChat";
import { useWorkspacePathsStore } from "../workspacePathsStore";
import { useHandleNewThread } from "./useHandleNewThread";

export function useHandleNewChat() {
  const { t } = useTranslation();

  const homeDir = useWorkspacePathsStore((state) => state.homeDir);
  const chatWorkspaceRoot = useWorkspacePathsStore((state) => state.chatWorkspaceRoot);
  const { handleNewThread } = useHandleNewThread();

  const handleNewChat = async (options?: {
    fresh?: boolean;
  }): Promise<StartContainerChatResult> => {
    if (!homeDir) {
      return {
        ok: false,
        error: t("Home folder is not available yet."),
      };
    }

    return startContainerChat({
      ensureProjectId: () => ensureHomeChatProject({ homeDir, chatWorkspaceRoot }),
      handleNewThread,
      fresh: options?.fresh,
      errorLabel: t("Unable to prepare a new chat."),
    });
  };

  return { handleNewChat };
}
