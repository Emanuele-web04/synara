import type { CanvasWork, DesignFrame, ThreadId } from "@synara/contracts";
import { DESIGN_LAYER_ATTRIBUTE } from "@synara/shared/designCanvasLayers";
import { useQuery } from "@tanstack/react-query";
import {
  type FocusEvent,
  type PointerEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { DESIGN_CANVAS_ON } from "~/betaFeatures";
import { useTranslation } from "~/i18n";
import type { DesignRenderContext } from "~/lib/designCanvas";
import { CanvasIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import { useCanvasPreviewContext } from "./canvasAssets";
import { selectionSignature, useCanvasEditorStore } from "./canvasStores";
import { AttachmentCard } from "../chat/AttachmentCard";
import { Tooltip, TooltipPopup } from "../ui/tooltip";
import { CanvasFramePreview } from "./editor/CanvasFramePreview";
import { indexLayers, layerLabel } from "./editor/canvasSelection";
import { canvasWorkQueryOptions } from "./canvasWorkCache";

/** A selected frame (`layerId` null) or a layer inside it, as the composer tile shows it. */
export type CanvasSelectionPreview = { frame: DesignFrame; layerId: string | null };

export type CanvasSelectionCardData = {
  /** The first selected objects, up to three, for the tile. */
  previews: readonly CanvasSelectionPreview[];
  /** The work's fonts and images, so the tile draws the selection as the canvas does. */
  previewContext: DesignRenderContext;
  title: string;
  subtitle: string;
  remove: () => void;
};

const MAX_TILE_PREVIEWS = 3;

/**
 * What is selected on the canvas open beside this chat, as a composer attachment. The
 * selection reaches the agent through the server's per-turn canvas context, as identifiers
 * only, so the message stays clean. The composer treats it like any other attachment.
 */
export function useCanvasSelectionCard(threadId: ThreadId): CanvasSelectionCardData | null {
  const { t } = useTranslation();
  const beside = useCanvasEditorStore((state) => state.shownBeside[threadId]);
  const selection = useCanvasEditorStore((state) =>
    beside ? state.selection[beside.workId] : undefined,
  );
  const dismissed = useCanvasEditorStore((state) => state.dismissedChip[threadId]);
  const dismiss = useCanvasEditorStore((state) => state.dismissChip);
  // Reads the work the open canvas already loaded; never fetches on its own.
  const { data: work } = useQuery<CanvasWork>({
    ...canvasWorkQueryOptions(beside?.workId ?? ""),
    enabled: false,
  });
  const previewContext = useCanvasPreviewContext(beside?.workId ?? "", work?.assets);
  const signature = selectionSignature(selection);
  const active = Boolean(selection && selection.items.length > 0 && dismissed !== signature);
  const card = useMemo(() => {
    if (!DESIGN_CANVAS_ON || !active || !selection || !work) return null;
    const page = work.pages.find((item) => item.id === selection.pageId);
    const first = selection.items[0]!;
    const frame = page?.frames.find((item) => item.id === first.frameId);
    if (!frame) return null;
    const name =
      first.kind === "frame" ? frame.title : layerLabel(indexLayers(frame.layers), first.layerId);
    const previews = selection.items.slice(0, MAX_TILE_PREVIEWS).flatMap((item) => {
      const itemFrame = page?.frames.find((candidate) => candidate.id === item.frameId);
      return itemFrame
        ? [{ frame: itemFrame, layerId: item.kind === "layer" ? item.layerId : null }]
        : [];
    });
    return {
      previews,
      previewContext,
      remove: () => dismiss(threadId, signature),
      title:
        selection.items.length > 1
          ? t("workspace:canvasSelectionMany", { name, count: selection.items.length - 1 })
          : name,
      subtitle:
        first.kind === "frame"
          ? t("workspace:canvasSelectionFrameSubtitle", { canvas: work.title })
          : t("workspace:canvasSelectionLayerSubtitle", { frame: frame.title }),
    };
  }, [active, dismiss, previewContext, selection, signature, t, threadId, work]);
  // Keep the server's copy in step so the next turn carries exactly what the chip shows.
  const lastWork = useRef<{ workId: string; pageId: string } | null>(null);
  useEffect(() => {
    if (!beside) {
      const last = lastWork.current;
      lastWork.current = null;
      if (last)
        void ensureNativeApi()
          .canvas.setChatSelection({ threadId, ...last, items: [] })
          .catch(() => {});
      return;
    }
    lastWork.current = {
      workId: beside.workId,
      pageId: selection?.pageId ?? work?.pages[0]?.id ?? "page-main",
    };
    const timer = setTimeout(() => {
      void ensureNativeApi()
        .canvas.setChatSelection({
          threadId,
          workId: beside.workId,
          pageId: selection?.pageId ?? work?.pages[0]?.id ?? "page-main",
          items:
            active && selection
              ? selection.items.slice(0, 50).map((item) => ({
                  frameId: item.frameId,
                  layerId: item.kind === "layer" ? item.layerId : null,
                }))
              : [],
        })
        .catch(() => {});
    }, 40);
    return () => clearTimeout(timer);
  }, [active, beside, selection, threadId, work]);
  return card;
}

/** The remove button is the only button in the card. */
const isRemoveButton = (target: EventTarget) =>
  target instanceof Element && target.closest("button") !== null;

export function CanvasSelectionCard({ card }: { card: CanvasSelectionCardData }) {
  const { t } = useTranslation();
  const anchor = useRef<HTMLSpanElement>(null);
  // The remove button names what it does on hover, like Synara's other icon controls.
  const [removeHint, setRemoveHint] = useState(false);
  const removeLabel = t("workspace:canvasSelectionRemove");
  return (
    <Tooltip open={removeHint} onOpenChange={(open) => !open && setRemoveHint(false)}>
      <AttachmentCard
        ref={anchor}
        size="md"
        className="w-72 transition-colors hover:bg-[var(--color-background-button-secondary-hover)]"
        data-canvas-selection-chip=""
        onPointerOver={(event: PointerEvent) => setRemoveHint(isRemoveButton(event.target))}
        onPointerLeave={() => setRemoveHint(false)}
        onFocus={(event: FocusEvent) =>
          setRemoveHint(isRemoveButton(event.target) && event.target.matches(":focus-visible"))
        }
        onBlur={() => setRemoveHint(false)}
        icon={<SelectionTile previews={card.previews} context={card.previewContext} />}
        title={card.title}
        subtitle={
          <span className="flex min-w-0 items-center gap-1">
            <CanvasIcon className="size-3 shrink-0" />
            <span className="truncate">{card.subtitle}</span>
          </span>
        }
        onRemove={card.remove}
        removeLabel={removeLabel}
      />
      <TooltipPopup anchor={anchor} side="top" align="end" sideOffset={6}>
        {removeLabel}
      </TooltipPopup>
    </Tooltip>
  );
}

/** One object fills the tile; several stack like cards, the first at the back. */
function SelectionTile({
  previews,
  context,
}: {
  previews: readonly CanvasSelectionPreview[];
  context: DesignRenderContext;
}) {
  const [first] = previews;
  if (!first) return <CanvasIcon className="size-5" aria-hidden />;
  if (previews.length === 1)
    return (
      <span
        className="flex size-full items-center justify-center overflow-hidden rounded-[inherit]"
        aria-hidden
      >
        <SelectionPreview
          preview={first}
          context={context}
          size={40}
          fit={first.layerId ? 32 : 38}
        />
      </span>
    );
  return (
    <span className="relative block h-8 w-[34px]" aria-hidden>
      {previews.map((preview, index) => (
        <span
          key={`${preview.frame.id}:${preview.layerId ?? ""}`}
          className="absolute flex size-6 items-center justify-center overflow-hidden rounded-sm border border-foreground/8 bg-card"
          style={{ left: index * 5, top: index * 4 }}
        >
          <SelectionPreview preview={preview} context={context} size={22} fit={18} />
        </span>
      ))}
    </span>
  );
}

type Box = { x: number; y: number; width: number; height: number };

const sameBox = (a: Box, b: Box) =>
  Math.abs(a.x - b.x) < 0.5 &&
  Math.abs(a.y - b.y) < 0.5 &&
  Math.abs(a.width - b.width) < 0.5 &&
  Math.abs(a.height - b.height) < 0.5;

/**
 * A frame fitted whole, or a layer zoomed to fill a `size` square (fitted within `fit`) with
 * the frame around it cropped. The layer's box is measured from the rendered preview, since
 * flow layout only exists once the frame is in the DOM.
 */
function SelectionPreview({
  preview,
  context,
  size,
  fit,
}: {
  preview: CanvasSelectionPreview;
  context: DesignRenderContext;
  size: number;
  fit: number;
}) {
  const { frame, layerId } = preview;
  const rendered = useMemo(() => ({ ...frame, style: frame.style ?? "" }), [frame]);
  const scaled = useRef<HTMLSpanElement>(null);
  const [layerBox, setLayerBox] = useState<Box | null>(null);
  // Runs after the preview's own layout effect has rendered the frame into its shadow root, and
  // again once the composer is laid out (it can mount hidden, behind the canvas Layers tab).
  useLayoutEffect(() => {
    const host = scaled.current?.firstElementChild;
    if (!host || !layerId) {
      setLayerBox(null);
      return;
    }
    const measure = () => {
      const hostRect = host.getBoundingClientRect();
      if (hostRect.width <= 0) return;
      const rect = host.shadowRoot
        ?.querySelector(`[${DESIGN_LAYER_ATTRIBUTE}="${CSS.escape(layerId)}"]`)
        ?.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) {
        setLayerBox(null);
        return;
      }
      const unit = hostRect.width / frame.width;
      const next = {
        x: (rect.left - hostRect.left) / unit,
        y: (rect.top - hostRect.top) / unit,
        width: rect.width / unit,
        height: rect.height / unit,
      };
      setLayerBox((current) => (current && sameBox(current, next) ? current : next));
    };
    measure();
    // Layout size only: the zoom transform never retriggers it.
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
    // The work's fonts change the text's layout: measure again once they apply.
  }, [context, frame.width, layerId, rendered]);
  // One element tree for both shapes, so measuring the layer never remounts the preview.
  const box = layerBox ?? { x: 0, y: 0, width: frame.width, height: frame.height };
  const scale = Math.min(fit / box.width, fit / box.height, layerBox ? 2 : Infinity);
  const x = layerBox ? size / 2 - (box.x + box.width / 2) * scale : 0;
  const y = layerBox ? size / 2 - (box.y + box.height / 2) * scale : 0;
  return (
    <span
      className={cn(
        "relative block shrink-0 overflow-hidden",
        !layerBox && "rounded-sm ring-1 ring-foreground/10",
      )}
      style={
        layerBox
          ? { width: size, height: size }
          : { width: frame.width * scale, height: frame.height * scale }
      }
    >
      <span
        ref={scaled}
        className="absolute top-0 left-0 block origin-top-left"
        style={{ transform: `translate(${x}px, ${y}px) scale(${scale})` }}
      >
        <CanvasFramePreview frame={rendered} context={context} />
      </span>
    </span>
  );
}
