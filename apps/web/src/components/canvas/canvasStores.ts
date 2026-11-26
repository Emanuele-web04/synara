import type { CanvasStreamEvent, ThreadId } from "@synara/contracts";
import { useEffect, useState } from "react";
import { create } from "zustand";

/** One selected object on a page: a whole frame, or a layer inside it. */
export type CanvasSelectionItem =
  | { kind: "frame"; frameId: string }
  | { kind: "layer"; frameId: string; layerId: string };

export const selectionKey = (item: CanvasSelectionItem) =>
  item.kind === "frame" ? `frame:${item.frameId}` : `layer:${item.frameId}:${item.layerId}`;

export type CanvasTool = "move" | "hand" | "frame" | "rectangle" | "text" | "comment";

type PageSelection = { workId: string; pageId: string; items: readonly CanvasSelectionItem[] };
export type CanvasPanelRequest = {
  kind: "layers" | "collapse" | "rename";
  /** The selection key of the row to rename. */
  key?: string;
  nonce: number;
};

type CanvasEditorState = {
  /** The latest selection per work; the composer chip and inspector read it. */
  selection: Readonly<Record<string, PageSelection>>;
  tool: CanvasTool;
  setSelection: (workId: string, pageId: string, items: readonly CanvasSelectionItem[]) => void;
  setTool: (tool: CanvasTool) => void;
  /** Chats that should not show the chip for this exact selection (the user removed it). */
  dismissedChip: Readonly<Record<string, string>>;
  dismissChip: (threadId: ThreadId, signature: string) => void;
  /** A layer the layers panel points at; the canvas outlines it like a hover. */
  panelHover: CanvasSelectionItem | null;
  setPanelHover: (item: CanvasSelectionItem | null) => void;
  /** `.` / ⌘\\: the canvas alone, without its panels and tools. */
  uiHidden: boolean;
  toggleUi: () => void;
  /** ⇧C: comment pins hidden on the canvas. */
  commentsHidden: boolean;
  toggleComments: () => void;
  /**
   * A request the layers panel acts on: show it (⌥1), collapse every row (⌥L), or rename a
   * row inline (⌘R). The nonce makes the same request twice count twice.
   */
  panelRequest: CanvasPanelRequest | null;
  requestPanel: (request: Omit<CanvasPanelRequest, "nonce">) => void;
  /** Which work is open beside which chat (side pane or full layout), by mount count. */
  shownBeside: Readonly<Record<string, { workId: string; count: number }>>;
  showBeside: (threadId: ThreadId, workId: string) => () => void;
};

export const selectionSignature = (selection: PageSelection | undefined) =>
  selection
    ? `${selection.workId}/${selection.pageId}/${selection.items.map(selectionKey).join(",")}`
    : "";

export const useCanvasEditorStore = create<CanvasEditorState>((set) => ({
  selection: {},
  tool: "move",
  dismissedChip: {},
  setSelection: (workId, pageId, items) =>
    set((state) => {
      const previous = state.selection[workId];
      if (
        previous?.pageId === pageId &&
        previous.items.length === items.length &&
        previous.items.every((item, index) => selectionKey(item) === selectionKey(items[index]!))
      )
        return state;
      return { selection: { ...state.selection, [workId]: { workId, pageId, items } } };
    }),
  setTool: (tool) => set({ tool }),
  dismissChip: (threadId, signature) =>
    set((state) => ({ dismissedChip: { ...state.dismissedChip, [threadId]: signature } })),
  panelHover: null,
  setPanelHover: (panelHover) => set({ panelHover }),
  uiHidden: false,
  toggleUi: () => set((state) => ({ uiHidden: !state.uiHidden })),
  commentsHidden: false,
  toggleComments: () => set((state) => ({ commentsHidden: !state.commentsHidden })),
  panelRequest: null,
  requestPanel: (request) =>
    set((state) => ({
      panelRequest: { ...request, nonce: (state.panelRequest?.nonce ?? 0) + 1 },
    })),
  shownBeside: {},
  showBeside: (threadId, workId) => {
    set((state) => {
      const current = state.shownBeside[threadId];
      const count = current?.workId === workId ? current.count + 1 : 1;
      return { shownBeside: { ...state.shownBeside, [threadId]: { workId, count } } };
    });
    return () =>
      set((state) => {
        const current = state.shownBeside[threadId];
        if (current?.workId !== workId) return state;
        const next = { ...state.shownBeside };
        if (current.count > 1) next[threadId] = { workId, count: current.count - 1 };
        else delete next[threadId];
        return { shownBeside: next };
      });
  },
}));

type Activity = { threadId: ThreadId; expiresAt: number };
type ActivityEvent = Extract<CanvasStreamEvent, { type: "activity" }>;
export type CanvasAgentActivityKind = NonNullable<ActivityEvent["kind"]>;
/** The latest thing an agent did to one layer (or, under FRAME_ACTIVITY_KEY, a whole frame). */
export type CanvasLayerActivity = {
  threadId: ThreadId;
  kind: CanvasAgentActivityKind;
  /** When this client received it (ms), so a reveal can start from the arrival. */
  at: number;
  expiresAt: number;
};
/** The `layers` key for activity on a frame as a whole (layer IDs are never empty). */
export const FRAME_ACTIVITY_KEY = "";
type ActivityState = {
  /** Frames an agent wrote, edited or deleted in: the frame outline and label badge. */
  frames: Readonly<Record<string, Readonly<Record<string, Activity>>>>;
  /** Per page and frame, the latest activity of every kind (reads included) per layer ID. */
  layers: Readonly<
    Record<string, Readonly<Record<string, Readonly<Record<string, CanvasLayerActivity>>>>>
  >;
  record: (event: ActivityEvent) => void;
};

export const canvasActivityKey = (workId: string, pageId: string) => `${workId}/${pageId}`;
const frameKey = canvasActivityKey;

const live = <A extends { expiresAt: number; threadId: ThreadId }>(
  entries: Readonly<Record<string, A>> | undefined,
  now: number,
  endedThread: ThreadId | null,
) =>
  Object.fromEntries(
    Object.entries(entries ?? {}).filter(
      ([, entry]) => entry.expiresAt > now && entry.threadId !== endedThread,
    ),
  );

/**
 * Ephemeral agent activity, fed by the canvas event stream: which frames show the "agent
 * working" outline, and what an agent last read, wrote, edited or deleted per layer. An
 * `ended` event (the agent's turn is over) drops that thread's activity on the page.
 */
export const useCanvasActivityStore = create<ActivityState>((set) => ({
  frames: {},
  layers: {},
  record: (event) =>
    set((state) => {
      const key = frameKey(event.workId, event.pageId);
      const now = Date.now();
      const ended = event.ended ? event.threadId : null;
      // Expired entries go whenever the page changes, so the store stays small.
      const previous = state.frames[key];
      const page: Record<string, Activity> = live(previous, now, ended);
      const pageLayers: Record<string, Record<string, CanvasLayerActivity>> = {};
      for (const [frameId, entries] of Object.entries(state.layers[key] ?? {})) {
        const kept = live(entries, now, ended);
        if (Object.keys(kept).length > 0) pageLayers[frameId] = kept;
      }
      if (!ended) {
        const expiresAt = Date.parse(event.expiresAt);
        const kind = event.kind ?? "write";
        // Reads never light the outline; it stays what it always showed: writes.
        if (kind !== "read")
          for (const frameId of event.frameIds)
            page[frameId] = { threadId: event.threadId, expiresAt };
        for (const frameId of event.frameIds) {
          const entry = { threadId: event.threadId, kind, at: now, expiresAt };
          const ids = event.layerIds?.[frameId];
          const frame = { ...pageLayers[frameId] };
          for (const id of ids?.length ? ids : [FRAME_ACTIVITY_KEY]) frame[id] = entry;
          pageLayers[frameId] = frame;
        }
      }
      // A read that changes no outline keeps the frames object, so the canvas does not re-render.
      const outlineUnchanged =
        previous !== undefined &&
        (ended !== null || event.kind === "read") &&
        Object.keys(page).length === Object.keys(previous).length;
      return {
        frames: outlineUnchanged ? state.frames : { ...state.frames, [key]: page },
        layers: { ...state.layers, [key]: pageLayers },
      };
    }),
}));

/** A canvas an agent is working on, to show in a side pane beside the chat that writes it. */
export type CanvasPaneOpenRequest = { threadId: ThreadId; workId: string; pageId: string };

/** Per thread, the works whose pane was already asked for during that thread's current turn. */
export type CanvasPaneSurfaced = Readonly<Record<string, readonly string[]>>;

/**
 * Whether an activity event asks for the canvas pane beside its chat. Like the device pane, it
 * is asked for once: the first write, edit or delete on a work in a turn surfaces it, and nothing
 * more that turn does, so a pane the user closes stays closed until the next turn. Reads never
 * ask. The `ended` event of a turn starts the count again for that chat.
 */
export function canvasPaneRequestFor(
  event: ActivityEvent,
  surfaced: CanvasPaneSurfaced,
): { request: CanvasPaneOpenRequest | null; surfaced: CanvasPaneSurfaced } {
  if (event.ended) {
    if (!(event.threadId in surfaced)) return { request: null, surfaced };
    const { [event.threadId]: _ended, ...rest } = surfaced;
    return { request: null, surfaced: rest };
  }
  const works = surfaced[event.threadId] ?? [];
  if ((event.kind ?? "write") === "read" || works.includes(event.workId))
    return { request: null, surfaced };
  return {
    request: { threadId: event.threadId, workId: event.workId, pageId: event.pageId },
    surfaced: { ...surfaced, [event.threadId]: [...works, event.workId] },
  };
}

type CanvasPaneRequestState = {
  surfaced: CanvasPaneSurfaced;
  /** Requests no chat surface has taken yet; one per chat and work, the latest page kept. */
  pending: readonly CanvasPaneOpenRequest[];
  noteActivity: (event: ActivityEvent) => void;
  /** Hands the pending requests over, once: remounting or closing a pane never replays them. */
  take: () => CanvasPaneOpenRequest[];
};

/** Agent canvas work waiting to be shown beside its chat (see canvasPaneRequestFor). */
export const useCanvasPaneRequestStore = create<CanvasPaneRequestState>((set, get) => ({
  surfaced: {},
  pending: [],
  noteActivity: (event) =>
    set((state) => {
      const next = canvasPaneRequestFor(event, state.surfaced);
      if (next.surfaced === state.surfaced) return {};
      const request = next.request;
      return {
        surfaced: next.surfaced,
        pending: request
          ? [
              ...state.pending.filter(
                (entry) => entry.threadId !== request.threadId || entry.workId !== request.workId,
              ),
              request,
            ]
          : state.pending,
      };
    }),
  take: () => {
    const taken = [...get().pending];
    if (taken.length) set({ pending: [] });
    return taken;
  },
}));

/** One frame's live layer activity (FRAME_ACTIVITY_KEY for the frame itself) at `now`. */
export function canvasLayerActivity(
  state: Pick<ActivityState, "layers">,
  workId: string,
  pageId: string,
  frameId: string,
  now = Date.now(),
): ReadonlyMap<string, CanvasLayerActivity> {
  return new Map(
    Object.entries(state.layers[frameKey(workId, pageId)]?.[frameId] ?? {}).filter(
      ([, entry]) => entry.expiresAt > now,
    ),
  );
}

/** Frame IDs with a live agent badge on this page; re-evaluates as badges expire. */
export function useActiveAgentFrames(workId: string, pageId: string | undefined) {
  const page = useCanvasActivityStore((state) =>
    pageId ? state.frames[frameKey(workId, pageId)] : undefined,
  );
  const [now, setNow] = useState(() => Date.now());
  const next = page
    ? Math.min(
        ...Object.values(page)
          .map((activity) => activity.expiresAt)
          .filter((expiresAt) => expiresAt > now),
      )
    : Infinity;
  useEffect(() => {
    if (!Number.isFinite(next)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, next - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [next]);
  return new Set(
    Object.entries(page ?? {})
      .filter(([, activity]) => activity.expiresAt > now)
      .map(([frameId]) => frameId),
  );
}

/**
 * Pages of a work with a live agent outline on any frame (the pages list shows an indicator
 * indicator for them); re-evaluates as the outlines expire.
 */
export function useActiveAgentPages(workId: string): ReadonlySet<string> {
  const frames = useCanvasActivityStore((state) => state.frames);
  const [now, setNow] = useState(() => Date.now());
  const prefix = `${workId}/`;
  const live = Object.entries(frames).filter(([key]) => key.startsWith(prefix));
  const expiries = live.flatMap(([, page]) =>
    Object.values(page)
      .map((activity) => activity.expiresAt)
      .filter((expiresAt) => expiresAt > now),
  );
  const next = expiries.length ? Math.min(...expiries) : Infinity;
  useEffect(() => {
    if (!Number.isFinite(next)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, next - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [next]);
  return new Set(
    live
      .filter(([, page]) => Object.values(page).some((activity) => activity.expiresAt > now))
      .map(([key]) => key.slice(prefix.length)),
  );
}
