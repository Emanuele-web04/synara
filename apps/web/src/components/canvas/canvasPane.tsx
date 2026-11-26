import type { ThreadId } from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import { requestComposerFocus } from "~/composerFocusRequestStore";
import { useComposerDraftStore } from "~/composerDraftStore";
import { useTranslation } from "~/i18n";
import { useRightDockStore } from "~/rightDockStore";
import { canvasWorkQueryOptions } from "./canvasWorkCache";
import { useCanvasLibrary } from "./useCanvasLibrary";

/** Opens a work in a chat's right dock, next to that chat. */
export function openCanvasPane(threadId: ThreadId, workId: string, pageId?: string | null) {
  useRightDockStore
    .getState()
    .openPane(threadId, { kind: "canvas", canvasWorkId: workId, canvasPageId: pageId ?? null });
}

/** Seeds a chat's composer with a canvas request and focuses it; the user sends it. */
export function askInChat(threadId: ThreadId, prompt: string) {
  const store = useComposerDraftStore.getState();
  const current = store.draftsByThreadId?.[threadId]?.prompt?.trim();
  store.setPrompt(threadId, current ? `${current}\n\n${prompt}` : prompt);
  requestComposerFocus(threadId);
}

export function useCanvasWork(workId: string) {
  const connection = useCanvasLibrary();
  const query = useQuery({ ...canvasWorkQueryOptions(workId), enabled: connection.supported });
  return { connection, query };
}

export function CanvasStatus({
  connection,
  error,
}: {
  connection: ReturnType<typeof useCanvasLibrary>;
  error: boolean;
}) {
  const { t } = useTranslation();
  return (
    <p className="m-auto p-6 text-center text-ui text-muted-foreground" role="status">
      {error
        ? t("workspace:designLoadFailed")
        : !connection.negotiating && !connection.supported
          ? t("workspace:canvasHostUnavailable")
          : t("workspace:designLoading")}
    </p>
  );
}
