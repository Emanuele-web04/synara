import { ThreadId, type CanvasStreamEvent } from "@synara/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  FRAME_ACTIVITY_KEY,
  canvasActivityKey,
  canvasLayerActivity,
  useCanvasActivityStore,
} from "./canvasStores";

type ActivityEvent = Extract<CanvasStreamEvent, { type: "activity" }>;
const agent = ThreadId.makeUnsafe("agent");
const other = ThreadId.makeUnsafe("other");
const NOW = Date.UTC(2026, 10, 10, 12);
const activity = (overrides: Partial<ActivityEvent> = {}): ActivityEvent => ({
  type: "activity",
  workId: "work",
  pageId: "page",
  frameIds: ["home"],
  threadId: agent,
  expiresAt: new Date(NOW + 40_000).toISOString(),
  ...overrides,
});
const store = () => useCanvasActivityStore.getState();
const layers = () => canvasLayerActivity(store(), "work", "page", "home");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  useCanvasActivityStore.setState({ frames: {}, layers: {} });
});
afterEach(() => vi.useRealTimers());

it("keeps the frame outline for writes only and holds every kind per layer", () => {
  store().record(activity({ kind: "read", layerIds: { home: ["title", "button"] } }));
  // A read never lights the outline, so the canvas shows exactly what it did before.
  expect(store().frames[canvasActivityKey("work", "page")]).toEqual({});
  expect([...layers().entries()]).toEqual([
    ["title", { threadId: agent, kind: "read", at: NOW, expiresAt: NOW + 40_000 }],
    ["button", { threadId: agent, kind: "read", at: NOW, expiresAt: NOW + 40_000 }],
  ]);
  const outline = store().frames;
  store().record(activity({ kind: "read" }));
  expect(store().frames).toBe(outline);

  vi.setSystemTime(NOW + 1_000);
  store().record(activity({ kind: "edit", layerIds: { home: ["button"] } }));
  expect(store().frames[canvasActivityKey("work", "page")]).toEqual({
    home: { threadId: agent, expiresAt: NOW + 40_000 },
  });
  expect(layers().get("button")).toMatchObject({ kind: "edit", at: NOW + 1_000 });
  expect(layers().get("title")).toMatchObject({ kind: "read" });
  expect(layers().get(FRAME_ACTIVITY_KEY)).toMatchObject({ kind: "read" });
  // Events from older servers carry no kind: they are writes on the whole frame.
  store().record(activity({ frameIds: ["detail"] }));
  expect(store().frames[canvasActivityKey("work", "page")]?.detail).toBeDefined();
  expect(
    canvasLayerActivity(store(), "work", "page", "detail").get(FRAME_ACTIVITY_KEY),
  ).toMatchObject({ kind: "write" });
});

it("drops a thread's activity on the page when its turn ends, and expired entries", () => {
  store().record(activity({ kind: "write", layerIds: { home: ["card"] } }));
  store().record(activity({ kind: "edit", threadId: other, layerIds: { home: ["other"] } }));
  store().record(activity({ frameIds: [], ended: true, expiresAt: new Date(NOW).toISOString() }));
  expect(Object.keys(store().frames[canvasActivityKey("work", "page")]!)).toEqual(["home"]);
  expect(store().frames[canvasActivityKey("work", "page")]!.home!.threadId).toBe(other);
  expect([...layers().keys()]).toEqual(["other"]);

  vi.setSystemTime(NOW + 41_000);
  expect(layers().size).toBe(0);
  store().record(activity({ pageId: "second", kind: "read" }));
  store().record(activity({ kind: "read", frameIds: ["detail"] }));
  expect(store().layers[canvasActivityKey("work", "page")]).toEqual({
    detail: { [FRAME_ACTIVITY_KEY]: expect.objectContaining({ kind: "read" }) },
  });
});
