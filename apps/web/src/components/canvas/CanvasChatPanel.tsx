import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type CanvasWork,
  type ThreadId,
} from "@synara/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { getProviderInstanceOptions, useAppSettings } from "~/appSettings";
import {
  resolveNewThreadRuntimeMode,
  resolvePreferredComposerModelSelection,
  useComposerDraftStore,
} from "~/composerDraftStore";
import { useTranslation } from "~/i18n";
import { ensureHomeChatProject } from "~/lib/chatProjects";
import { createDraftThread } from "~/lib/draftThreadCreate";
import { ChevronDownIcon, PlusIcon } from "~/lib/icons";
import { ensureNativeApi } from "~/nativeApi";
import { selectRightDockState, useRightDockStore } from "~/rightDockStore";
import { canvasDockHostId } from "~/rightDockStore.logic";
import { useStore } from "~/store";
import { createSidebarThreadSummariesSelector } from "~/storeSelectors";
import { useWorkspacePathsStore } from "~/workspacePathsStore";
import { ComposerPickerMenuPopup } from "../chat/ComposerPickerMenuPopup";
import { SidechatDockPane } from "../chat/SidechatDockPane";
import { Button } from "../ui/button";
import { IconButton } from "../ui/icon-button";
import { Menu, MenuItem, MenuTrigger } from "../ui/menu";

/**
 * The full-size canvas keeps a real chat beside it. The chat is a normal durable thread; the
 * canvas only remembers which one is shown (in its dock state) and links it to the page.
 */
export function CanvasChatPanel({
  work,
  pageId,
  readOnly,
  preferredThreadId,
  onActiveThreadChange,
}: {
  work: CanvasWork;
  pageId: string;
  readOnly: boolean;
  preferredThreadId: ThreadId | undefined;
  onActiveThreadChange: (threadId: ThreadId | null) => void;
}) {
  const { t } = useTranslation();
  const { settings } = useAppSettings();
  const hostId = canvasDockHostId(work.id);
  const dock = useRightDockStore(useMemo(() => selectRightDockState(hostId), [hostId]));
  const summaries = useStore(useMemo(() => createSidebarThreadSummariesSelector(), []));
  const hydrated = useStore((state) => state.threadsHydrated);
  const drafts = useComposerDraftStore((state) => state.draftThreadsByThreadId);
  const existing = useMemo(
    () =>
      new Set<ThreadId>([
        ...summaries.map((thread) => thread.id),
        ...(Object.keys(drafts) as ThreadId[]),
      ]),
    [drafts, summaries],
  );
  const linked = work.chats
    .filter((chat) => existing.has(chat.threadId))
    .toSorted((a, b) => b.usedAt.localeCompare(a.usedAt));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const creating = useRef(false);
  const initialized = useRef(false);
  const pane = dock.panes.find((item) => item.kind === "sidechat") ?? null;
  const activeThread = pane?.threadId ?? null;
  const activeExists = activeThread !== null && existing.has(activeThread);
  useEffect(
    () => onActiveThreadChange(activeExists ? activeThread : null),
    [activeExists, activeThread, onActiveThreadChange],
  );
  const selectChat = (threadId: ThreadId) => {
    const state = useRightDockStore.getState();
    state.setSidechatPaneThread(hostId, threadId);
    state.setDockOpen(hostId, true);
  };
  const create = async () => {
    if (creating.current || readOnly) return;
    creating.current = true;
    setBusy(true);
    setError(null);
    try {
      const state = useStore.getState();
      const associated = state.projects.find((project) => project.id === work.projectId);
      const projectId =
        associated?.id ?? (await ensureHomeChatProject(useWorkspacePathsStore.getState()));
      if (!projectId) throw new Error(t("workspace:canvasChatUnavailable"));
      const draft = useComposerDraftStore.getState();
      const modelSelection = resolvePreferredComposerModelSelection({
        draft: {
          modelSelectionByProvider: draft.stickyModelSelectionByProvider,
          activeProvider: draft.stickyActiveProvider,
        },
        threadModelSelection: null,
        projectModelSelection: associated?.defaultModelSelection ?? null,
        defaultProvider: settings.defaultProvider,
        resolveProviderForInstanceId: (id) =>
          getProviderInstanceOptions(settings).find((instance) => instance.instanceId === id)
            ?.provider,
      });
      const threadId = createDraftThread({
        projectId,
        prompt: "",
        modelSelection,
        runtimeMode: resolveNewThreadRuntimeMode(),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        envMode: "local",
      });
      selectChat(threadId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("workspace:canvasChatUnavailable"));
    } finally {
      creating.current = false;
      setBusy(false);
    }
  };
  const createRef = useRef(create);
  createRef.current = create;
  useEffect(() => {
    if (!hydrated || initialized.current || readOnly) return;
    initialized.current = true;
    if (preferredThreadId && existing.has(preferredThreadId)) return selectChat(preferredThreadId);
    if (activeExists) return;
    const latest = linked[0]?.threadId;
    if (latest) selectChat(latest);
    else void createRef.current();
  });
  const [ready, setReady] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!activeThread || readOnly || !activeExists) return;
    let stale = false;
    setReady(null);
    setError(null);
    void ensureNativeApi()
      .canvas.bindChat({ workId: work.id, pageId, threadId: activeThread })
      .then(() => {
        if (!stale) setReady(`${activeThread}:${pageId}`);
      })
      .catch((cause: unknown) => {
        if (!stale)
          setError(cause instanceof Error ? cause.message : t("workspace:canvasChatUnavailable"));
      });
    return () => {
      stale = true;
    };
    // Agent edits change the work's chats and updatedAt; they must not rebind.
  }, [activeExists, activeThread, pageId, readOnly, retry, work.id, t]);

  if (readOnly)
    return (
      <p className="m-auto p-6 text-center text-ui-sm text-muted-foreground">
        {t("workspace:canvasArchivedChatHint")}
      </p>
    );
  const title = (id: ThreadId) =>
    summaries.find((thread) => thread.id === id)?.title || t("workspace:canvasNewChat");
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The 32px panel header: the chat switcher and a "+" for a new chat. */}
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border ps-1.5 pe-2">
        <Menu>
          <MenuTrigger render={<Button variant="ghost" size="xs" className="min-w-0" />}>
            <span className="truncate">
              {activeThread ? title(activeThread) : t("workspace:canvasChats")}
            </span>
            <ChevronDownIcon className="size-3" />
          </MenuTrigger>
          <ComposerPickerMenuPopup align="start">
            {linked.length === 0 && <MenuItem disabled>{t("workspace:canvasNoChats")}</MenuItem>}
            {linked.map((chat) => (
              <MenuItem key={chat.threadId} onClick={() => selectChat(chat.threadId)}>
                {title(chat.threadId)}
              </MenuItem>
            ))}
          </ComposerPickerMenuPopup>
        </Menu>
        <IconButton
          className="ms-auto -me-1"
          disabled={busy}
          label={t("workspace:canvasNewChat")}
          tooltip={t("workspace:canvasNewChat")}
          onClick={() => void create()}
        >
          <PlusIcon />
        </IconButton>
      </div>
      {error ? (
        <div className="space-y-3 p-4 text-ui-sm text-destructive" role="alert">
          <p>{error}</p>
          <Button variant="outline" size="sm" onClick={() => setRetry((value) => value + 1)}>
            {t("workspace:designRetry")}
          </Button>
        </div>
      ) : pane && ready === `${pane.threadId}:${pageId}` ? (
        <SidechatDockPane
          pane={pane}
          runtimeMode="live"
          isFocusedPane
          threadExists={pane.threadId !== null && existing.has(pane.threadId)}
        />
      ) : (
        <p className="p-4 text-ui-sm text-muted-foreground" role="status">
          {t("workspace:designLoading")}
        </p>
      )}
    </div>
  );
}
