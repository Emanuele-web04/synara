import type { ThreadId } from "@synara/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "~/i18n";
import { RotateCcwIcon } from "~/lib/icons";
import { ensureNativeApi } from "~/nativeApi";
import { Button } from "../ui/button";
import {
  Popover,
  PopoverDescription,
  PopoverPopup,
  PopoverTitle,
  PopoverTrigger,
} from "../ui/popover";
import { toastManager } from "../ui/toast";
import { CanvasFrameStrip } from "./CanvasFrameStrip";
import { useCanvasPreviewContext } from "./canvasAssets";
import { openCanvasPane, useCanvasWork } from "./canvasPane";
import { canvasQueryKey, canvasTurnActivityQueryKey, runCanvasWrite } from "./canvasWorkCache";

/** Restore names the frames it puts back while the list stays readable. */
const MAX_NAMED_FRAMES = 3;

/**
 * One card per agent turn and canvas: the frames it touched on the canvas backdrop, Open
 * (beside this chat) and Restore (put the frames back as they were before this turn).
 */
export function CanvasTurnCard({
  threadId,
  turnId,
  workId,
  workTitle,
  pageId,
}: {
  threadId: ThreadId;
  turnId: string | null;
  workId: string;
  workTitle: string;
  pageId: string;
}) {
  const { t, formatLocale } = useTranslation();
  const client = useQueryClient();
  const { connection, query } = useCanvasWork(workId);
  // The work's fonts and images, so the thumbnails draw text and fills as the canvas does.
  const previewContext = useCanvasPreviewContext(workId, query.data?.assets);
  const activityQuery = useQuery({
    queryKey: canvasTurnActivityQueryKey(threadId),
    queryFn: () => ensureNativeApi().canvas.turnActivity({ threadId }),
    enabled: connection.supported,
  });
  const [restoring, setRestoring] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const activity = activityQuery.data?.activities.find(
    (item) => item.workId === workId && item.turnId === turnId,
  );
  const page = query.data?.pages.find((item) => item.id === (activity?.pageId ?? pageId));
  const changedIds = new Set([
    ...(activity?.createdFrameIds ?? []),
    ...(activity?.updatedFrameIds ?? []),
  ]);
  const changedFrames = page?.frames.filter((item) => changedIds.has(item.id)) ?? [];
  const fallbackFrame =
    page?.frames.find((item) => item.id === activity?.firstFrameId) ?? page?.frames[0];
  const frames = changedFrames.length > 0 ? changedFrames : fallbackFrame ? [fallbackFrame] : [];
  const created = activity?.createdFrameIds.length ?? 0;
  const updated = activity?.updatedFrameIds.length ?? 0;
  const change =
    created && updated
      ? t("workspace:canvasTurnCreatedUpdated", { created, updated })
      : created
        ? t("workspace:canvasTurnCreated", { count: created })
        : updated
          ? t("workspace:canvasTurnUpdated", { count: updated })
          : null;
  const summary = activity?.restoredAt
    ? t("workspace:canvasTurnRestored")
    : [change, page?.title].filter(Boolean).join(" · ");
  const restoreDetail =
    changedFrames.length > 0 && changedFrames.length <= MAX_NAMED_FRAMES
      ? t("workspace:canvasRestoreTurnDetail", {
          count: changedFrames.length,
          frames: new Intl.ListFormat(formatLocale, { type: "conjunction" }).format(
            changedFrames.map((item) => item.title),
          ),
        })
      : t("workspace:canvasRestoreTurnConfirm");
  const open = () => openCanvasPane(threadId, workId, activity?.pageId ?? pageId);
  const restore = async () => {
    setConfirmOpen(false);
    if (!turnId || restoring) return;
    setRestoring(true);
    try {
      await runCanvasWrite(client, workId, () =>
        ensureNativeApi().canvas.restoreTurn({ workId, threadId, turnId }),
      );
      await client.invalidateQueries({
        queryKey: canvasQueryKey,
        predicate: (query) => query.queryKey[1] !== "work",
      });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: t("workspace:canvasOperationFailed"),
        description: cause instanceof Error ? cause.message : undefined,
      });
    } finally {
      setRestoring(false);
    }
  };
  return (
    <div
      className="group/turn-card flex w-full max-w-[300px] flex-col overflow-clip rounded-lg border border-border bg-card"
      data-canvas-turn-card={workId}
    >
      <CanvasFrameStrip
        frames={frames}
        context={previewContext}
        onOpenFrame={open}
        frameLabel={(frame) => t("workspace:canvasOpenWork", { title: frame.title })}
      />
      <div className="flex h-11 shrink-0 items-center gap-1.5 border-t border-border ps-3 pe-1.5 transition-colors group-hover/turn-card:bg-[var(--color-background-button-secondary-hover)]">
        <div className="flex min-w-0 flex-1 flex-col gap-px">
          <span className="truncate text-ui-sm leading-tight font-medium text-foreground">
            {activity?.workTitle ?? workTitle}
          </span>
          <span className="truncate text-ui-xs leading-tight text-muted-foreground">{summary}</span>
        </div>
        {activity?.restorable && !activity.restoredAt && turnId && (
          <Popover open={confirmOpen} onOpenChange={setConfirmOpen}>
            <PopoverTrigger
              disabled={restoring}
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={t("workspace:canvasRestoreTurn")}
                />
              }
            >
              <RotateCcwIcon className="size-3.5" />
            </PopoverTrigger>
            <PopoverPopup side="top" align="end" className="w-60">
              <div className="flex flex-col gap-2">
                <div className="flex flex-col gap-0.5">
                  <PopoverTitle className="text-ui-sm leading-tight font-semibold">
                    {t("workspace:canvasRestoreTurnTitle")}
                  </PopoverTitle>
                  <PopoverDescription className="text-ui-xs leading-snug">
                    {restoreDetail}
                  </PopoverDescription>
                </div>
                <div className="flex justify-end gap-1">
                  <Button size="xs" variant="subtle" onClick={() => setConfirmOpen(false)}>
                    {t("workspace:canvasCancel")}
                  </Button>
                  <Button size="xs" disabled={restoring} onClick={() => void restore()}>
                    {t("workspace:canvasRestore")}
                  </Button>
                </div>
              </div>
            </PopoverPopup>
          </Popover>
        )}
        <Button size="xs" onClick={open}>
          {t("workspace:canvasOpen")}
        </Button>
      </div>
    </div>
  );
}
