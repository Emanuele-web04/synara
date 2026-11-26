import { WS_CANVAS_LIBRARY_CAPABILITY, type CanvasStreamEvent } from "@synara/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { DESIGN_CANVAS_ON } from "~/betaFeatures";
import { answerCanvasRenderRequest } from "~/lib/canvasExport";
import { ensureNativeApi } from "~/nativeApi";
import { onWsServerCapabilitiesChange, readWsServerCapabilities } from "~/wsNativeApi";
import { addWsTransportStateListener, readLatestWsTransportState } from "~/wsTransportEvents";
import { loadCanvasAssets } from "./canvasAssets";
import { useCanvasActivityStore } from "./canvasStores";
import { handleCanvasChanged } from "./canvasWorkCache";

/** Agents cannot lay out HTML on the server; this window renders (or measures) and answers. */
async function answerRender(event: Extract<CanvasStreamEvent, { type: "render" }>) {
  const api = ensureNativeApi();
  try {
    const work = await api.canvas.get({ workId: event.workId });
    const page = work.pages.find((item) => item.id === event.pageId);
    if (!page) throw new Error("page not found");
    const assets = await loadCanvasAssets(work.id, work.assets);
    const result = await answerCanvasRenderRequest(event, page, assets);
    await api.canvas.submitRender({ requestId: event.requestId, result });
  } catch (cause) {
    await api.canvas
      .submitRender({
        requestId: event.requestId,
        result: { error: (cause instanceof Error ? cause.message : "render failed").slice(0, 500) },
      })
      .catch(() => {});
  }
}

/** Whether this host serves canvases; subscribing is the event bridge's job alone. */
export function useCanvasLibrary() {
  const [capabilities, setCapabilities] = useState(readWsServerCapabilities);
  const [transport, setTransport] = useState(readLatestWsTransportState);
  useEffect(() => onWsServerCapabilitiesChange(setCapabilities, { replayCurrent: true }), []);
  useEffect(() => addWsTransportStateListener(setTransport, { replayCurrent: true }), []);
  const supported =
    DESIGN_CANVAS_ON && capabilities?.includes(WS_CANVAS_LIBRARY_CAPABILITY) === true;
  return {
    supported,
    negotiating: DESIGN_CANVAS_ON && capabilities === null,
    disconnected: transport !== null && transport !== "open",
  };
}

/**
 * The app's one canvas subscription, mounted at the root (each workspace frame has its own
 * transport and QueryClient): it patches cached works, records agent activity and answers
 * agent screenshot requests whenever Synara is open.
 */
export function CanvasEventBridge() {
  const client = useQueryClient();
  const { supported } = useCanvasLibrary();
  useEffect(() => {
    if (!supported) return;
    return ensureNativeApi().canvas.onEvent((event) => {
      if (event.type === "activity") useCanvasActivityStore.getState().record(event);
      else if (event.type === "render") void answerRender(event);
      else handleCanvasChanged(client, event);
    });
  }, [client, supported]);
  return null;
}
