// FILE: SplitPaneLayout.tsx
// Purpose: Keeps chat panes mounted in a flat layout and owns split-divider resizing.
// Layer: Chat surface layout

import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  findSplitNodeById,
  layoutSplitPanes,
  replacePaneInTree,
  type PaneRect,
} from "../../splitView.logic";
import { type LeafPane, type Pane, type PaneId, type SplitDirection } from "../../splitViewStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  attachPanelPointerOverlaySession,
  createPanelResizeOverlay,
  removePanelResizeOverlay,
} from "../../lib/panelResize";
import { cn } from "~/lib/utils";

const SPLIT_RATIO_MIN = 0.25;
const SPLIT_RATIO_MAX = 0.75;

function clampSplitRatio(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, value));
}

function SplitDivider(props: {
  splitNodeId: PaneId;
  direction: SplitDirection;
  ratio: number;
  onPreviewRatio: (nodeId: PaneId, ratio: number) => void;
  onFinishResize: (nodeId: PaneId, ratio: number | null) => void;
}) {
  const { splitNodeId, direction } = props;
  const previewRatio = useStableCallback(props.onPreviewRatio);
  const finishResize = useStableCallback(props.onFinishResize);
  const abortResizeRef = useRef<(() => void) | null>(null);
  useEffect(() => () => abortResizeRef.current?.(), []);
  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    abortResizeRef.current?.();
    const target = event.currentTarget;
    const parent = target.parentElement as HTMLElement | null;
    if (!parent) return;
    event.preventDefault();
    const rect = parent.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const computeRatio = (clientX: number, clientY: number) =>
      clampSplitRatio(
        direction === "horizontal"
          ? (clientX - rect.left) / rect.width
          : (clientY - rect.top) / rect.height,
      );

    let latestRatio = props.ratio;
    let frameId = 0;
    const previousBodyCursor = document.body.style.cursor;
    const previousBodyUserSelect = document.body.style.userSelect;
    const cursor = direction === "horizontal" ? "col-resize" : "row-resize";
    const overlay = createPanelResizeOverlay(cursor);
    let detachPointerSession = () => {};

    const applyResize = () => {
      frameId = 0;
      previewRatio(splitNodeId, latestRatio);
    };
    const onPointerMove = (moveEvent: PointerEvent) => {
      latestRatio = computeRatio(moveEvent.clientX, moveEvent.clientY);
      if (frameId === 0) frameId = window.requestAnimationFrame(applyResize);
    };
    const finish = (ratio: number | null) => {
      if (frameId !== 0) window.cancelAnimationFrame(frameId);
      detachPointerSession();
      removePanelResizeOverlay(overlay);
      document.body.style.userSelect = previousBodyUserSelect;
      document.body.style.cursor = previousBodyCursor;
      abortResizeRef.current = null;
      finishResize(splitNodeId, ratio);
    };

    abortResizeRef.current = () => finish(null);
    document.body.style.userSelect = "none";
    document.body.style.cursor = cursor;
    detachPointerSession = attachPanelPointerOverlaySession(overlay, {
      onMove: onPointerMove,
      onRelease: () => finish(latestRatio),
      onAbort: () => finish(null),
    });
  };

  return (
    <div
      data-split-divider="true"
      data-split-node-id={splitNodeId}
      data-split-direction={direction}
      className={cn(
        "pointer-events-auto absolute z-10 bg-border/70",
        direction === "horizontal"
          ? "inset-y-0 w-px cursor-col-resize before:absolute before:inset-y-0 before:-left-1 before:w-2 before:bg-transparent"
          : "inset-x-0 h-px cursor-row-resize before:absolute before:inset-x-0 before:-top-1 before:h-2 before:bg-transparent",
      )}
      style={
        direction === "horizontal"
          ? { left: `${props.ratio * 100}%` }
          : { top: `${props.ratio * 100}%` }
      }
      onPointerDown={handlePointerDown}
    />
  );
}

function paneRectStyle(rect: PaneRect): CSSProperties {
  return {
    left: `${rect.left * 100}%`,
    top: `${rect.top * 100}%`,
    width: `${rect.width * 100}%`,
    height: `${rect.height * 100}%`,
  };
}

// Every leaf is a sibling keyed by its pane id and placed by absolute box, so adding, moving,
// or closing a pane keeps the others mounted; nesting the tree would change their parent and
// remount their chats (see layoutSplitPanes). Each split node gets a frame over its own box
// that holds the divider, which reads that frame to turn a drag into a ratio.
export function SplitPaneLayout(props: {
  pane: Pane;
  renderLeaf: (input: { leaf: LeafPane }) => ReactNode;
  onSetRatio: (nodeId: PaneId, ratio: number) => void;
}) {
  const [preview, setPreview] = useState<{ pane: Pane; nodeId: PaneId; ratio: number } | null>(
    null,
  );
  const committedLayout = useMemo(() => layoutSplitPanes(props.pane), [props.pane]);
  // Keep chat content stable while only its containing boxes resize.
  const contentByPaneId = useMemo(
    () => new Map(committedLayout.leaves.map(({ leaf }) => [leaf.id, props.renderLeaf({ leaf })])),
    [committedLayout, props.renderLeaf],
  );
  const layout = useMemo(() => {
    const node =
      preview?.pane === props.pane ? findSplitNodeById(props.pane, preview.nodeId) : null;
    return node && preview
      ? layoutSplitPanes(replacePaneInTree(props.pane, node.id, { ...node, ratio: preview.ratio }))
      : committedLayout;
  }, [props.pane, preview, committedLayout]);
  return (
    <div data-split-container="true" className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
      {layout.leaves.map(({ leaf, rect }) => (
        <div
          key={leaf.id}
          className="absolute flex min-h-0 min-w-0 overflow-hidden"
          style={{
            ...paneRectStyle(rect),
            // A leading edge inside the surface is a divider's line; leave it that pixel.
            paddingLeft: rect.left > 0 ? 1 : 0,
            paddingTop: rect.top > 0 ? 1 : 0,
          }}
        >
          {contentByPaneId.get(leaf.id)}
        </div>
      ))}
      {layout.splits.map(({ node, rect }) => (
        <div key={node.id} className="pointer-events-none absolute" style={paneRectStyle(rect)}>
          <SplitDivider
            splitNodeId={node.id}
            direction={node.direction}
            ratio={node.ratio}
            onPreviewRatio={(nodeId, ratio) => setPreview({ pane: props.pane, nodeId, ratio })}
            onFinishResize={(nodeId, ratio) => {
              setPreview(null);
              if (ratio !== null) props.onSetRatio(nodeId, ratio);
            }}
          />
        </div>
      ))}
    </div>
  );
}
