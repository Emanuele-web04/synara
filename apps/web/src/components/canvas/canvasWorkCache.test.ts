import type { CanvasChangedEvent, CanvasWork, DesignFrame } from "@synara/contracts";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ canvas: { get: vi.fn() } }));
vi.mock("~/nativeApi", () => ({ ensureNativeApi: () => native }));

import {
  canvasWorkQueryKey,
  canvasWorkQueryOptions,
  handleCanvasChanged,
  runCanvasWrite,
  storeCanvasWork,
} from "./canvasWorkCache";

const at = (second: number) => new Date(Date.UTC(2026, 10, 10, 0, 0, second)).toISOString();

const frame = (id: string, revision = 1): DesignFrame => ({
  id,
  title: id,
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  revision,
  layers: {
    roots: [`${id}-box`],
    nodes: [
      {
        id: `${id}-box`,
        type: "element",
        tag: "div",
        attributes: { style: "color:#000000" },
        children: [`${id}-text`],
      },
      { id: `${id}-text`, type: "text", text: "Hello" },
    ],
  },
});

const work = (id: string, updatedAt: string, frames = [frame("a"), frame("b")]): CanvasWork => ({
  version: 3,
  kind: "work",
  id,
  title: id,
  folderId: null,
  projectId: null,
  createdAt: at(0),
  updatedAt,
  archivedAt: null,
  pages: [{ id: "page", title: "Page", viewport: { x: 0, y: 0, zoom: 1 }, frames, comments: [] }],
  chats: [],
});

/** Agent restyles frame `a`'s box: revision 1 → 2, committed at `updatedAt`. */
const restyle = (
  workId: string,
  previousUpdatedAt: string,
  updatedAt: string,
  revision = 2,
): CanvasChangedEvent => ({
  type: "changed",
  scope: "work",
  workId,
  pageId: "page",
  frameId: "a",
  revision,
  mutationId: `m${revision}`,
  updatedAt,
  previousUpdatedAt,
  delta: {
    operations: [
      { type: "set_attributes", nodeId: "a-box", attributes: { style: "color:#ff0000" } },
    ],
    lastLayerEdit: { mutationId: `m${revision}`, fingerprint: "f", createdNodeIds: [] },
  },
});

let client: QueryClient;
const observers: (() => void)[] = [];
/** A mounted work, as an open canvas holds it: its query is active, so invalidation refetches. */
function mount(id: string, cached: CanvasWork) {
  client.setQueryData(canvasWorkQueryKey(id), cached);
  const observer = new QueryObserver(client, {
    ...canvasWorkQueryOptions(id),
    staleTime: Infinity,
  });
  observers.push(observer.subscribe(() => {}));
}
const cachedWork = (id: string) => client.getQueryData<CanvasWork>(canvasWorkQueryKey(id))!;
const frameOf = (value: CanvasWork, id: string) =>
  value.pages[0]!.frames.find((item) => item.id === id)!;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  native.canvas.get.mockReset();
});
afterEach(() => {
  observers.splice(0).forEach((unsubscribe) => unsubscribe());
  client.clear();
  vi.useRealTimers();
});

describe("canvas work cache", () => {
  it("applies an in-order delta without a fetch, keeping untouched frames", () => {
    mount("w", work("w", at(1)));
    const untouched = frameOf(cachedWork("w"), "b");
    handleCanvasChanged(client, restyle("w", at(1), at(2)));
    const next = cachedWork("w");
    expect(next.updatedAt).toBe(at(2));
    expect(frameOf(next, "a").revision).toBe(2);
    expect(frameOf(next, "a").layers.nodes[0]).toMatchObject({
      attributes: { style: "color:#ff0000" },
    });
    expect(frameOf(next, "b")).toBe(untouched);
    expect(native.canvas.get).not.toHaveBeenCalled();
  });

  it("patches agent duplicate and replace_html deltas in place, without parsing HTML", () => {
    mount("w", work("w", at(1)));
    const box = frameOf(cachedWork("w"), "a").layers.nodes[0]!;
    // What the server sends for `duplicate a-box` then `replace_html a-text`: inserted layers
    // with their new IDs, then the delete of the replaced one.
    handleCanvasChanged(client, {
      type: "changed",
      scope: "work",
      workId: "w",
      pageId: "page",
      frameId: "a",
      revision: 2,
      mutationId: "agent",
      updatedAt: at(2),
      previousUpdatedAt: at(1),
      delta: {
        operations: [
          {
            type: "insert_layers",
            parentId: null,
            layers: {
              roots: ["copy-box"],
              nodes: [
                {
                  id: "copy-box",
                  type: "element",
                  tag: "div",
                  attributes: { style: "color:#000000" },
                  children: ["copy-text"],
                },
                { id: "copy-text", type: "text", text: "Hello" },
              ],
            },
          },
          {
            type: "insert_layers",
            parentId: "a-box",
            beforeId: "a-text",
            layers: {
              roots: ["strong"],
              nodes: [
                { id: "strong", type: "element", tag: "strong", attributes: {}, children: ["t2"] },
                { id: "t2", type: "text", text: "Hi" },
              ],
            },
          },
          { type: "delete", nodeId: "a-text" },
        ],
        lastLayerEdit: {
          mutationId: "agent",
          fingerprint: "f",
          createdNodeIds: ["copy-box", "copy-text", "strong", "t2"],
          duplicates: [
            {
              sourceId: "a-box",
              newId: "copy-box",
              idMap: { "a-box": "copy-box", "a-text": "copy-text" },
            },
          ],
        },
      },
    });
    const patched = frameOf(cachedWork("w"), "a");
    expect(native.canvas.get).not.toHaveBeenCalled();
    expect(patched.revision).toBe(2);
    expect(patched.layers.roots).toEqual(["a-box", "copy-box"]);
    expect(patched.layers.nodes.map((node) => node.id)).toEqual([
      "a-box",
      "copy-box",
      "copy-text",
      "strong",
      "t2",
    ]);
    expect(patched.layers.nodes[0]).toMatchObject({ children: ["strong"] });
    expect(patched.layers.nodes[0]).not.toBe(box);
    expect(patched.lastLayerEdit?.duplicates?.[0]?.newId).toBe("copy-box");
  });

  it("recovers a missed event by refetching that one work only", async () => {
    mount("w", work("w", at(1)));
    mount("other", work("other", at(1)));
    const current = work("w", at(3), [frame("a", 3), frame("b")]);
    native.canvas.get.mockResolvedValue(current);
    // The event for revision 2 was lost: revision 3 does not follow the cached revision 1.
    handleCanvasChanged(client, restyle("w", at(2), at(3), 3));
    await vi.waitFor(() => expect(cachedWork("w").updatedAt).toBe(at(3)));
    expect(native.canvas.get.mock.calls).toEqual([[{ workId: "w" }]]);
    expect(frameOf(cachedWork("w"), "a").revision).toBe(3);
    expect(cachedWork("other").updatedAt).toBe(at(1));
  });

  it("refetches when the cached frame is not at the previous revision", async () => {
    mount("w", work("w", at(1), [frame("a", 2), frame("b")]));
    native.canvas.get.mockResolvedValue(work("w", at(2), [frame("a", 2), frame("b")]));
    handleCanvasChanged(client, restyle("w", at(1), at(2)));
    await vi.waitFor(() => expect(native.canvas.get).toHaveBeenCalledTimes(1));
  });

  it("recognises the echo of this client's own write and replays later events after it", async () => {
    mount("w", work("w", at(1)));
    let resolve!: (saved: CanvasWork) => void;
    const saved = work("w", at(2), [frame("a", 2), frame("b")]);
    const write = runCanvasWrite(
      client,
      "w",
      () => new Promise<CanvasWork>((done) => (resolve = done)),
    );
    // The echo arrives before the response, then an agent edit on top of it.
    handleCanvasChanged(client, { type: "changed", scope: "work", workId: "w", updatedAt: at(2) });
    handleCanvasChanged(client, restyle("w", at(2), at(3), 3));
    expect(cachedWork("w").updatedAt).toBe(at(1));
    resolve(saved);
    await write;
    expect(cachedWork("w").updatedAt).toBe(at(3));
    expect(frameOf(cachedWork("w"), "a").revision).toBe(3);
    expect(native.canvas.get).not.toHaveBeenCalled();
  });

  it("never replaces a newer work with an older response", () => {
    mount("w", work("w", at(5)));
    storeCanvasWork(client, work("w", at(4), []));
    expect(cachedWork("w").updatedAt).toBe(at(5));
    expect(cachedWork("w").pages[0]!.frames).toHaveLength(2);
  });

  it("invalidates only summaries for library changes", async () => {
    mount("w", work("w", at(1)));
    const list = new QueryObserver(client, {
      queryKey: ["canvas-library", "list", {}],
      queryFn: () => ({ works: [] }),
      staleTime: Infinity,
    });
    observers.push(list.subscribe(() => {}));
    await vi.waitFor(() =>
      expect(client.getQueryData(["canvas-library", "list", {}])).toBeTruthy(),
    );
    handleCanvasChanged(client, { type: "changed", scope: "library" });
    vi.advanceTimersByTime(150);
    expect(client.getQueryState(["canvas-library", "list", {}])?.isInvalidated).toBe(true);
    expect(client.getQueryState(canvasWorkQueryKey("w"))?.isInvalidated).toBe(false);
    expect(native.canvas.get).not.toHaveBeenCalled();
  });
});
