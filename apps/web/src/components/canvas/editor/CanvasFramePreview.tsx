import type { CanvasFramePreview as Preview } from "@synara/contracts";
import { memo, useLayoutEffect, useRef } from "react";
import { renderDesignFrame, type DesignRenderContext } from "~/lib/designCanvas";

/** Without the work's assets: images render as absent, families as the browser has them. */
const PREVIEW_CONTEXT: DesignRenderContext = {
  assetUrl: () => null,
  fonts: new Map<string, string>(),
};

/**
 * A static thumbnail of a frame, through the same sanitized renderer as the canvas. Pass the
 * work's `context` (its font names and image URLs, see `useCanvasPreviewContext`) so text and
 * images match the frame on the canvas.
 */
export const CanvasFramePreview = memo(function CanvasFramePreview({
  frame,
  context = PREVIEW_CONTEXT,
}: {
  frame: Preview;
  context?: DesignRenderContext;
}) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = host.current!;
    const shadow = element.shadowRoot ?? element.attachShadow({ mode: "open" });
    renderDesignFrame(shadow, frame, context);
  }, [context, frame]);
  return <div ref={host} inert style={{ width: frame.width, height: frame.height }} />;
});
