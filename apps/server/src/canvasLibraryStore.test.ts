import { createHash, randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CanvasPageChangeInput,
  ProjectId,
  ThreadId,
  type CanvasAssetUpload,
  type CanvasChangedEvent,
  type CanvasCommentAuthor,
  type CanvasCommentChangeInput,
  type CanvasCommentThread,
  type CanvasEditLayersInput,
  type CanvasStreamEvent,
  type CanvasWork,
  type DesignFrame,
  type DesignFramePutInput,
} from "@synara/contracts";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyDesignLayerEdits, serializeDesignLayers } from "@synara/shared/designCanvasLayers";
import { canvasPageList } from "@synara/shared/designCanvasPages";

// Pass-through spies: tests below count what a commit writes to disk.
vi.mock("./atomicWrite", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./atomicWrite")>();
  return {
    ...actual,
    writeFileStringAtomically: vi.fn(actual.writeFileStringAtomically),
    createFileStringExclusively: vi.fn(actual.createFileStringExclusively),
  };
});

import { createFileStringExclusively, writeFileStringAtomically } from "./atomicWrite";
import { makeCanvasLibraryStore } from "./canvasLibraryStore";
import { putDesignFrame } from "./designCanvasFrames";

type Store = ReturnType<typeof makeCanvasLibraryStore>;

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), "synara-library-"));
  directories.push(directory);
  return { directory, store: makeCanvasLibraryStore(directory) };
}
/** A store over a copy of the state, with a cold index, as after an app restart. */
async function reopen(directory: string) {
  const cold = await setup();
  await cp(path.join(directory, "design-canvases"), path.join(cold.directory, "design-canvases"), {
    recursive: true,
  });
  return cold;
}
const fileFor = (directory: string, id: string) =>
  path.join(
    directory,
    "design-canvases",
    "library",
    `${createHash("sha256").update(id).digest("hex")}.json`,
  );
const assetDirectory = (directory: string) => path.join(directory, "design-canvases", "assets");
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const upload = (id: string, bytes: Buffer): CanvasAssetUpload => ({
  id,
  name: id,
  mimeType: "image/png",
  sizeBytes: bytes.length,
  data: bytes.toString("base64"),
  width: 1,
  height: 1,
});

const frameInput = (
  id: string,
  overrides: Partial<DesignFramePutInput> = {},
): DesignFramePutInput => ({
  id,
  title: id,
  html: '<main><h1>Hello</h1><p>Keep me</p><div class="target"></div></main>',
  css: "h1{color:green}",
  width: 400,
  height: 600,
  expectedRevision: 0,
  ...overrides,
});
const pageOf = (work: CanvasWork, pageId = "page-main") =>
  work.pages.find((page) => page.id === pageId)!;
const frameOf = (work: CanvasWork, frameId: string, pageId = "page-main") =>
  pageOf(work, pageId).frames.find((frame) => frame.id === frameId)!;
const textNode = (frame: DesignFrame, text: string) =>
  frame.layers.nodes.find((node) => node.type === "text" && node.text === text)!;
const elementNode = (frame: DesignFrame, tag: string) =>
  frame.layers.nodes.find((node) => node.type === "element" && node.tag === tag)!;
const withoutReadOnly = ({ readOnly: _readOnly, ...work }: CanvasWork) => work;

async function workWithFrames(store: Store, ...frameIds: string[]) {
  await store.create({ id: "work", title: "Work" });
  for (const id of frameIds)
    await store.putFrame({ workId: "work", pageId: "page-main", frame: frameInput(id) });
  return store.get("work");
}

describe("works and persistence", () => {
  it("creates, lists, reads and reopens version 3 works with frame previews", async () => {
    const { store, directory } = await setup();
    const thread = ThreadId.makeUnsafe("chat-one");
    const created = await store.create(
      { id: "work", title: "Work", projectId: ProjectId.makeUnsafe("project") },
      undefined,
      thread,
    );
    expect(created).toMatchObject({
      version: 3,
      kind: "work",
      folderId: null,
      projectId: "project",
      archivedAt: null,
      pages: [{ id: "page-main", title: "Page 1", frames: [], comments: [] }],
      chats: [{ threadId: thread, pageId: "page-main" }],
    });
    const put = await store.putFrame({
      workId: "work",
      pageId: "page-main",
      frame: frameInput("home"),
    });
    expect(put).toMatchObject({
      frame: { id: "home", revision: 1 },
      createdNodeIds: [],
      dropped: [],
    });

    const listed = await store.list();
    expect(listed).toMatchObject({ total: 1, folders: [], unavailableIds: [] });
    expect(listed.works[0]).toMatchObject({
      id: "work",
      pageCount: 1,
      frameCount: 1,
      preview: { width: 400, height: 600, style: "" },
    });
    // Previews carry the layer model; the web renders them through the sanitized renderer.
    expect(serializeDesignLayers(listed.works[0]!.preview!.layers, false)).toContain(
      '<h1 style="color:green">Hello</h1>',
    );
    expect((await store.list({ projectId: ProjectId.makeUnsafe("other") })).total).toBe(0);
    expect((await store.list({ threadId: thread })).total).toBe(1);
    expect((await store.list({ search: "WOR" })).total).toBe(1);
    expect(await store.resolveChat(thread)).toMatchObject({ workId: "work", pageId: "page-main" });

    const persisted = JSON.parse(await readFile(fileFor(directory, "work"), "utf8"));
    expect(persisted.version).toBe(3);
    expect(persisted).not.toHaveProperty("readOnly");
    expect(Object.keys(persisted.pages[0].frames[0]).toSorted()).toEqual([
      "height",
      "id",
      "lastLayerEdit",
      "layers",
      "revision",
      "title",
      "width",
      "x",
      "y",
    ]);

    const work = await store.get("work");
    expect(work.readOnly).toBe(false);
    const cold = await reopen(directory);
    expect(await cold.store.get("work")).toEqual(work);
    expect(withoutReadOnly(work)).toEqual(put.work);
  });

  it("keeps IDs case-sensitive, accepts Windows-reserved names and refuses reused IDs", async () => {
    const { store } = await setup();
    await store.create({ id: "Login", title: "Login" });
    await store.create({ id: "login", title: "Different case" });
    await store.create({ id: "CON", title: "Windows reserved word is a safe ID" });
    expect((await store.get("Login")).title).toBe("Login");
    expect((await store.get("login")).title).toBe("Different case");
    expect((await store.get("CON")).title).toContain("Windows");
    await expect(store.create({ id: "login", title: "Again" })).rejects.toThrow("already used");
    await expect(store.get("missing")).rejects.toThrow();
    await expect(store.get("bad id!")).rejects.toThrow();
  });

  it("manages folder lifecycle, refuses cycles and makes archived works read-only", async () => {
    const { store } = await setup();
    await store.createFolder({ id: "outer", title: "Outer" });
    await store.createFolder({ id: "inner", title: "Inner", folderId: "outer" });
    expect(
      await store.createFolder({ id: "inner", title: "Inner", folderId: "outer" }),
    ).toMatchObject({ id: "inner", kind: "folder", version: 2 });
    await expect(store.createFolder({ id: "inner", title: "Renamed" })).rejects.toThrow(
      "already used",
    );
    await expect(store.update({ id: "outer", folderId: "outer" })).rejects.toThrow("inside itself");
    await expect(store.update({ id: "outer", folderId: "inner" })).rejects.toThrow("inside itself");
    await expect(store.create({ id: "lost", title: "Lost", folderId: "missing" })).rejects.toThrow(
      "unavailable",
    );
    await store.create({ id: "nested", title: "Nested", folderId: "inner" });
    await store.create({ id: "root", title: "Root" });

    await store.update({ id: "outer", archived: true });
    expect((await store.get("nested")).readOnly).toBe(true);
    expect((await store.list()).works.map((work) => work.id)).toEqual(["root"]);
    expect((await store.list()).folders).toEqual([]);
    expect((await store.list({ archived: true })).works.map((work) => work.id)).toEqual(["nested"]);
    expect(
      (await store.list({ archived: true })).folders.map((folder) => folder.id).toSorted(),
    ).toEqual(["inner", "outer"]);
    await expect(
      store.layout({ workId: "nested", pageId: "page-main", viewport: { x: 0, y: 0, zoom: 1 } }),
    ).rejects.toThrow("Restore this canvas from Archive");
    await expect(store.create({ id: "late", title: "Late", folderId: "inner" })).rejects.toThrow(
      "unavailable",
    );
    const copy = await store.duplicate({ workId: "nested", id: "copy", title: "Copy" });
    expect(copy).toMatchObject({ folderId: null, archivedAt: null });

    await store.update({ id: "outer", archived: false });
    const moved = await store.layout({
      workId: "nested",
      pageId: "page-main",
      viewport: { x: 5, y: 6, zoom: 2 },
    });
    expect(pageOf(moved).viewport).toEqual({ x: 5, y: 6, zoom: 2 });
  });

  it("never falls back over a corrupt or pre-redesign document", async () => {
    const { directory, store } = await setup();
    await store.create({ id: "work", title: "Work" });
    await mkdir(path.dirname(fileFor(directory, "legacy")), { recursive: true });
    const legacy = JSON.stringify({
      version: 1,
      kind: "work",
      id: "legacy",
      title: "Legacy",
      folderId: null,
      projectId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: null,
      pages: [
        {
          id: "page-main",
          title: "Page 1",
          viewport: { x: 0, y: 0, zoom: 1 },
          frames: [],
          notes: [],
        },
      ],
      chats: [],
    });
    await writeFile(fileFor(directory, "legacy"), legacy);
    await writeFile(fileFor(directory, "work"), "damaged newer data");

    const cold = await reopen(directory);
    const listed = await cold.store.list();
    expect(listed.works).toEqual([]);
    expect(listed.unavailableIds.toSorted()).toEqual(
      ["legacy", "work"].map((id) => createHash("sha256").update(id).digest("hex")).toSorted(),
    );
    await expect(cold.store.get("work")).rejects.toThrow();
    await expect(cold.store.get("legacy")).rejects.toThrow();
    await expect(cold.store.create({ id: "work", title: "must not replace" })).rejects.toThrow(
      "unreadable",
    );
    await expect(
      cold.store.createFolder({ id: "legacy", title: "must not replace" }),
    ).rejects.toThrow("unreadable");
    expect(await readFile(fileFor(cold.directory, "work"), "utf8")).toBe("damaged newer data");
    expect(await readFile(fileFor(cold.directory, "legacy"), "utf8")).toBe(legacy);
  });

  it("changes pages, rebinds chats from deleted pages and duplicates without comments or receipts", async () => {
    const { store } = await setup();
    const thread = ThreadId.makeUnsafe("chat-pages");
    await workWithFrames(store, "home");
    await store.changeComments(
      {
        workId: "work",
        pageId: "page-main",
        operation: {
          type: "create",
          threadId: "t1",
          messageId: "m1",
          frameId: "home",
          layerId: null,
          x: 1,
          y: 1,
          text: "Note",
        },
      },
      { kind: "user" },
    );
    await store.changePages({
      workId: "work",
      operation: { type: "create", id: "second", title: "Second" },
    });
    await store.changePages({
      workId: "work",
      operation: { type: "create", id: "second", title: "Ignored" },
    });
    await store.changePages({
      workId: "work",
      operation: { type: "rename", id: "second", title: "Review" },
    });
    await store.changePages({
      workId: "work",
      operation: { type: "move", id: "second", beforeId: "page-main" },
    });
    let work = await store.get("work");
    expect(work.pages.map((item) => [item.id, item.title])).toEqual([
      ["second", "Review"],
      ["page-main", "Page 1"],
    ]);
    await store.bindChat({ workId: "work", pageId: "second", threadId: thread });
    await store.changePages({ workId: "work", operation: { type: "delete", id: "second" } });
    await store.changePages({ workId: "work", operation: { type: "delete", id: "second" } });
    expect(await store.resolveChat(thread)).toMatchObject({ workId: "work", pageId: "page-main" });
    await expect(
      store.changePages({ workId: "work", operation: { type: "delete", id: "page-main" } }),
    ).rejects.toThrow("at least one page");
    await expect(
      store.changePages({ workId: "work", operation: { type: "rename", id: "gone", title: "X" } }),
    ).rejects.toThrow("page not found");

    work = await store.get("work");
    const copy = await store.duplicate({ workId: "work", id: "copy", title: "Independent copy" });
    expect(copy.chats).toEqual([]);
    expect(copy.pages[0]!.id).not.toBe("page-main");
    expect(copy.pages[0]!.comments).toEqual([]);
    const copied = copy.pages[0]!.frames[0]!;
    expect(copied).not.toHaveProperty("lastLayerEdit");
    expect(copied.layers).toEqual(frameOf(work, "home").layers);
    expect(pageOf(await store.get("work")).comments).toHaveLength(1);
  });

  it("stores assets idempotently as content-addressed files and refuses different bytes under a used ID", async () => {
    const { store, directory } = await setup();
    await store.create({ id: "work", title: "Work" });
    const bytes = Buffer.from("iVBORw==", "base64");
    const asset = upload("pixel", bytes);
    await store.putAssets("work", [asset]);
    await store.putAssets("work", [asset]);
    const { data: _data, ...metadata } = asset;
    expect((await store.get("work")).assets).toEqual([{ ...metadata, sha256: sha256(bytes) }]);
    expect(await readFile(path.join(assetDirectory(directory), sha256(bytes)))).toEqual(bytes);
    expect(await store.getAsset("work", "pixel")).toEqual({
      assetId: "pixel",
      sha256: sha256(bytes),
      mimeType: "image/png",
      data: "iVBORw==",
    });
    await expect(store.getAsset("work", "missing")).rejects.toThrow("asset not found");
    await expect(store.putAssets("work", [{ ...asset, data: "AAAAAA==" }])).rejects.toThrow(
      "Asset ID already exists",
    );
    // A second work with the same bytes shares the file; a duplicate copies no bytes.
    await store.create({ id: "other", title: "Other" });
    await store.putAssets("other", [upload("again", bytes)]);
    await store.duplicate({ workId: "work", id: "copy", title: "Copy" });
    expect(await readdir(assetDirectory(directory))).toEqual([sha256(bytes)]);
    expect((await store.getAsset("copy", "pixel")).data).toBe("iVBORw==");
  });

  it("reads version 2 works and writes version 3 with asset files on the next change", async () => {
    const { directory } = await setup();
    const bytes = randomBytes(4096);
    const frame = putDesignFrame([], frameInput("home")).frame;
    const legacy = {
      version: 2,
      kind: "work",
      id: "legacy",
      title: "Legacy",
      folderId: null,
      projectId: null,
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
      archivedAt: null,
      assets: [upload("logo", bytes)],
      pages: [
        {
          id: "page-main",
          title: "Page 1",
          viewport: { x: 0, y: 0, zoom: 1 },
          frames: [frame],
          comments: [],
        },
      ],
      chats: [],
    };
    await mkdir(path.dirname(fileFor(directory, "legacy")), { recursive: true });
    await writeFile(fileFor(directory, "legacy"), JSON.stringify(legacy));

    // Reading upgrades in memory only: version 3 metadata, bytes still served from the file.
    const { store } = await reopen(directory);
    expect((await store.list()).works.map((work) => work.id)).toEqual(["legacy"]);
    const read = await store.get("legacy");
    expect(read.version).toBe(3);
    expect(read.assets).toEqual([
      {
        id: "logo",
        name: "logo",
        mimeType: "image/png",
        sizeBytes: 4096,
        width: 1,
        height: 1,
        sha256: sha256(bytes),
      },
    ]);
    expect(pageOf(read).frames).toEqual([frame]);
    expect((await store.getAsset("legacy", "logo")).data).toBe(bytes.toString("base64"));
    const reopened = await reopen(directory);
    expect(JSON.parse(await readFile(fileFor(reopened.directory, "legacy"), "utf8")).version).toBe(
      2,
    );

    // The next change moves the bytes into their file and writes version 3.
    await reopened.store.layout({
      workId: "legacy",
      pageId: "page-main",
      frames: [{ id: "home", x: 10 }],
    });
    const persisted = JSON.parse(await readFile(fileFor(reopened.directory, "legacy"), "utf8"));
    expect(persisted.version).toBe(3);
    expect(persisted.assets).toEqual(read.assets);
    expect(JSON.stringify(persisted)).not.toContain(bytes.toString("base64").slice(0, 64));
    expect(await readFile(path.join(assetDirectory(reopened.directory), sha256(bytes)))).toEqual(
      bytes,
    );
    const cold = await reopen(reopened.directory);
    expect((await cold.store.get("legacy")).assets).toEqual(read.assets);
    expect((await cold.store.getAsset("legacy", "logo")).data).toBe(bytes.toString("base64"));
  });
});

/** One page list change on the work every test here calls "work". */
const pages = (store: Store, operation: CanvasPageChangeInput["operation"]) =>
  store.changePages({ workId: "work", operation });

describe("page list: dividers, icons and the cover frame", () => {
  const listOf = (work: CanvasWork) =>
    canvasPageList(work).map((item) => (item.kind === "page" ? item.id : `—${item.id}`));
  const changedEvents = (store: Store) => {
    const events: CanvasChangedEvent[] = [];
    const unsubscribe = store.subscribe((event) => {
      if (event.type === "changed") events.push(event);
    });
    return { events, unsubscribe };
  };

  it("adds, reorders, re-anchors and deletes dividers without ever listing them as pages", async () => {
    const { store, directory } = await setup();
    await store.create({ id: "work", title: "Work" });
    await pages(store, { type: "create", id: "two", title: "Two" });
    const { events, unsubscribe } = changedEvents(store);
    await pages(store, { type: "add_divider", id: "d1", beforeId: "two" });
    // A retried add is a no-op; the ID of a page or divider cannot be reused by the other kind.
    await pages(store, { type: "add_divider", id: "d1", beforeId: null });
    await expect(pages(store, { type: "add_divider", id: "two", beforeId: null })).rejects.toThrow(
      "already used",
    );
    await expect(pages(store, { type: "create", id: "d1", title: "Clash" })).rejects.toThrow(
      "already used",
    );
    await pages(store, { type: "add_divider", id: "d2", beforeId: null });
    let work = await store.get("work");
    expect(listOf(work)).toEqual(["page-main", "—d1", "two", "—d2"]);
    expect(work.pages.map((page) => page.id)).toEqual(["page-main", "two"]);
    expect(work.dividers).toEqual([
      { id: "d1", beforePageId: "two" },
      { id: "d2", beforePageId: null },
    ]);
    // Scoped events: each change names the work, never the whole library.
    expect(events.every((event) => event.scope === "work" && event.workId === "work")).toBe(true);
    unsubscribe();

    // A new page goes last, under a trailing divider (it starts a new group).
    await pages(store, { type: "create", id: "three", title: "Three" });
    // Pages and dividers move together through one list.
    await pages(store, { type: "move", id: "d2", beforeId: "page-main" });
    await pages(store, { type: "move", id: "two", beforeId: null });
    work = await store.get("work");
    expect(listOf(work)).toEqual(["—d2", "page-main", "—d1", "three", "two"]);
    await expect(pages(store, { type: "move", id: "d9", beforeId: null })).rejects.toThrow(
      "page not found",
    );
    await expect(pages(store, { type: "move", id: "d1", beforeId: "gone" })).rejects.toThrow(
      "Destination page not found",
    );
    // Deleting the page under a divider keeps the divider above the page that follows.
    await pages(store, { type: "delete", id: "three" });
    expect(listOf(await store.get("work"))).toEqual(["—d2", "page-main", "—d1", "two"]);
    // Dividers are not pages: no page operation reaches them, and they leave by their own.
    await expect(pages(store, { type: "rename", id: "d1", title: "X" })).rejects.toThrow(
      "page not found",
    );
    await expect(pages(store, { type: "delete", id: "d1" })).rejects.toThrow("page not found");
    await expect(pages(store, { type: "set_icon", id: "d1", icon: "pen" })).rejects.toThrow(
      "page not found",
    );
    await expect(pages(store, { type: "delete_divider", id: "two" })).rejects.toThrow(
      "divider not found",
    );
    await pages(store, { type: "delete_divider", id: "d1" });
    await pages(store, { type: "delete_divider", id: "d1" });
    expect(listOf(await store.get("work"))).toEqual(["—d2", "page-main", "two"]);
    await pages(store, { type: "delete_divider", id: "d2" });
    const persisted = JSON.parse(await readFile(fileFor(directory, "work"), "utf8"));
    // With none left the field is gone, as in a file written before dividers existed.
    expect(persisted).not.toHaveProperty("dividers");
    for (let index = 0; index < 32; index++)
      await pages(store, { type: "add_divider", id: `many${index}`, beforeId: null });
    await expect(
      pages(store, { type: "add_divider", id: "one-more", beforeId: null }),
    ).rejects.toThrow("at most 32 dividers");
  });

  it("sets and clears page icons, refuses unknown ones and keeps newer stored keys readable", async () => {
    const { store, directory } = await setup();
    await store.create({ id: "work", title: "Work" });
    await pages(store, { type: "set_icon", id: "page-main", icon: "swatch" });
    expect(pageOf(await store.get("work")).icon).toBe("swatch");
    await pages(store, { type: "set_icon", id: "page-main", icon: null });
    expect(pageOf(await store.get("work"))).not.toHaveProperty("icon");
    await expect(pages(store, { type: "set_icon", id: "gone", icon: "pen" })).rejects.toThrow(
      "page not found",
    );
    expect(() =>
      Schema.decodeUnknownSync(CanvasPageChangeInput)({
        workId: "work",
        operation: { type: "set_icon", id: "page-main", icon: "rocket-ship" },
      }),
    ).toThrow();
    // A key only a newer client knows still loads; the web shows the default icon for it.
    const file = JSON.parse(await readFile(fileFor(directory, "work"), "utf8"));
    file.pages[0].icon = "future-icon";
    await writeFile(fileFor(directory, "work"), JSON.stringify(file));
    const cold = await reopen(directory);
    expect(pageOf(await cold.store.get("work")).icon).toBe("future-icon");
  });

  it("sets and clears a page's canvas colour; files written without one load unchanged", async () => {
    const { store, directory } = await setup();
    await store.create({ id: "work", title: "Work" });
    // A file from before page colours: no `color` anywhere, and it reads back without one.
    const before = await readFile(fileFor(directory, "work"), "utf8");
    expect(before).not.toContain('"color"');
    const fresh = await reopen(directory);
    expect(pageOf(await fresh.store.get("work"))).not.toHaveProperty("color");
    await pages(store, { type: "set_color", id: "page-main", color: "#282828" });
    expect(pageOf(await store.get("work")).color).toBe("#282828");
    await pages(store, { type: "set_color", id: "page-main", color: "#eeeeee80" });
    const cold = await reopen(directory);
    expect(pageOf(await cold.store.get("work")).color).toBe("#eeeeee80");
    await pages(store, { type: "set_color", id: "page-main", color: null });
    expect(pageOf(await store.get("work"))).not.toHaveProperty("color");
    const persisted = JSON.parse(await readFile(fileFor(directory, "work"), "utf8"));
    expect(persisted.pages[0]).not.toHaveProperty("color");
    await expect(pages(store, { type: "set_color", id: "gone", color: "#000000" })).rejects.toThrow(
      "page not found",
    );
    // Only lowercase #rrggbb or #rrggbbaa: anything else never reaches the store.
    for (const color of ["red", "#FFF", "#ABCDEF", "url(x)", "#1234567"])
      expect(() =>
        Schema.decodeUnknownSync(CanvasPageChangeInput)({
          workId: "work",
          operation: { type: "set_color", id: "page-main", color },
        }),
      ).toThrow();
  });

  it("uses the cover frame as the thumbnail, falls back to the first frame and follows duplicates", async () => {
    const { store } = await setup();
    await workWithFrames(store, "first", "second");
    await pages(store, { type: "create", id: "two", title: "Two" });
    await store.putFrame({ workId: "work", pageId: "two", frame: frameInput("elsewhere") });
    const preview = async () => (await store.list()).works[0]!.preview!;
    const tall = { width: 400, height: 600 };
    expect(await preview()).toMatchObject(tall);
    // Different sizes tell the frames apart in the summary.
    await store.layout({
      workId: "work",
      pageId: "two",
      frames: [{ id: "elsewhere", width: 321 }],
    });

    const { events, unsubscribe } = changedEvents(store);
    const covered = await store.update({
      id: "work",
      cover: { pageId: "two", frameId: "elsewhere" },
    });
    expect(covered).toMatchObject({ cover: { pageId: "two", frameId: "elsewhere" } });
    expect(events).toMatchObject([{ scope: "work", workId: "work" }]);
    unsubscribe();
    expect((await preview()).width).toBe(321);
    await expect(
      store.update({ id: "work", cover: { pageId: "two", frameId: "missing" } }),
    ).rejects.toThrow("view not found");
    await expect(
      store.update({ id: "work", cover: { pageId: "missing", frameId: "first" } }),
    ).rejects.toThrow("page not found");

    // The copy's cover follows its new page IDs.
    const copy = await store.duplicate({ workId: "work", id: "copy", title: "Copy" });
    expect(copy.cover).toEqual({ pageId: copy.pages[1]!.id, frameId: "elsewhere" });
    expect(copy.pages[1]!.id).not.toBe("two");

    // A deleted cover frame falls back to the first frame; undoing the delete brings it back.
    const removed = frameOf(await store.get("work"), "elsewhere", "two");
    await store.layout({
      workId: "work",
      pageId: "two",
      frames: [{ id: "elsewhere", remove: true }],
    });
    expect((await store.get("work")).cover).toEqual({ pageId: "two", frameId: "elsewhere" });
    expect(await preview()).toMatchObject(tall);
    await store.restoreFrames({
      workId: "work",
      pageId: "two",
      frames: [removed],
      removeFrameIds: [],
    });
    expect((await preview()).width).toBe(321);

    // Clearing goes back to the first frame; deleting the cover's page drops the cover.
    await store.update({ id: "work", cover: null });
    expect(await store.get("work")).not.toHaveProperty("cover");
    expect(await preview()).toMatchObject(tall);
    await store.update({ id: "work", cover: { pageId: "two", frameId: "elsewhere" } });
    await pages(store, { type: "delete", id: "two" });
    expect(await store.get("work")).not.toHaveProperty("cover");

    await store.update({ id: "work", archived: true });
    await expect(
      store.update({ id: "work", cover: { pageId: "page-main", frameId: "second" } }),
    ).rejects.toThrow("Restore this canvas from Archive");
  });

  it("lists the fonts and images the thumbnail's frame uses beside its preview", async () => {
    const { store } = await setup();
    await store.create({ id: "work", title: "Work" });
    const bytes = Buffer.from("d09GMgABAAA=", "base64");
    const font = (id: string, family: string): CanvasAssetUpload => ({
      id,
      name: family,
      mimeType: "font/woff2",
      sizeBytes: bytes.length,
      data: bytes.toString("base64"),
      font: { family, weight: "400", style: "normal" },
    });
    await store.putAssets("work", [
      font("inter", "Inter"),
      font("cardo", "Cardo"),
      upload("hero", Buffer.from("iVBORw==", "base64")),
      upload("unused", Buffer.from("iVBORw0=", "base64")),
    ]);
    await store.putFrame({
      workId: "work",
      pageId: "page-main",
      frame: frameInput("card", {
        html: '<h1 style="font-family:Inter, sans-serif">Hi</h1><img src="synara-asset:hero">',
      }),
    });
    const listed = (await store.list()).works[0]!;
    expect(listed.previewAssets?.map((asset) => asset.id).toSorted()).toEqual(["hero", "inter"]);
    // A work whose thumbnail uses no assets lists none.
    await store.create({ id: "plain", title: "Plain" });
    await store.putFrame({ workId: "plain", pageId: "page-main", frame: frameInput("card") });
    expect((await store.list()).works.find((work) => work.id === "plain")).not.toHaveProperty(
      "previewAssets",
    );
  });

  it("loads version 3 works without the new fields and duplicates divider anchors", async () => {
    const { store, directory } = await setup();
    await workWithFrames(store, "home");
    const before = JSON.parse(await readFile(fileFor(directory, "work"), "utf8"));
    // A file from before this change: no dividers, icons or cover anywhere.
    expect(before).not.toHaveProperty("dividers");
    expect(before).not.toHaveProperty("cover");
    expect(before.pages[0]).not.toHaveProperty("icon");
    const cold = await reopen(directory);
    const read = await cold.store.get("work");
    expect(canvasPageList(read).map((item) => item.kind)).toEqual(["page"]);
    expect((await cold.store.list()).works[0]!.preview).toMatchObject({ width: 400 });

    // A divider naming a page that is gone lists last instead of breaking the work.
    before.dividers = [{ id: "stale", beforePageId: "gone" }];
    await writeFile(fileFor(directory, "work"), JSON.stringify(before));
    const again = await reopen(directory);
    expect(listOf(await again.store.get("work"))).toEqual(["page-main", "—stale"]);
    // A divider that reuses a page ID makes the work unreadable, like any duplicate ID.
    before.dividers = [{ id: "page-main", beforePageId: null }];
    await writeFile(fileFor(directory, "work"), JSON.stringify(before));
    await expect((await reopen(directory)).store.get("work")).rejects.toThrow("Duplicate");

    await again.store.changePages({
      workId: "work",
      operation: { type: "create", id: "two", title: "Two" },
    });
    // The new page went below the stale divider, which now names it; d1 goes last.
    await again.store.changePages({
      workId: "work",
      operation: { type: "add_divider", id: "d1", beforeId: null },
    });
    const copy = await again.store.duplicate({ workId: "work", id: "copy", title: "Copy" });
    const [first, second] = copy.pages;
    expect(canvasPageList(copy).map((item) => item.kind)).toEqual([
      "page",
      "divider",
      "page",
      "divider",
    ]);
    expect(copy.dividers!.map((divider) => divider.beforePageId)).toEqual([second!.id, null]);
    expect(first!.id).not.toBe("page-main");
  });
});

describe("frames through the store", () => {
  it("retries identical puts and edits without new revisions and refuses invalid batches whole", async () => {
    const { store } = await setup();
    await store.create({ id: "work", title: "Work" });
    const first = await store.putFrame({
      workId: "work",
      pageId: "page-main",
      frame: frameInput("home"),
    });
    const retry = await store.putFrame({
      workId: "work",
      pageId: "page-main",
      frame: frameInput("home"),
    });
    expect(retry.frame).toEqual(first.frame);
    await expect(
      store.putFrame({
        workId: "work",
        pageId: "page-main",
        frame: frameInput("home", { html: "<p>Other</p>" }),
      }),
    ).rejects.toThrow("revision conflict");

    const original = first.frame;
    const paragraph = elementNode(original, "p");
    const edit = {
      workId: "work",
      pageId: "page-main",
      edit: {
        frameId: "home",
        expectedRevision: 1,
        mutationId: "change-title",
        operations: [
          { type: "set_text" as const, nodeId: textNode(original, "Hello").id, text: "Quieter" },
        ],
      },
    };
    const edited = await store.editLayers(edit);
    expect(edited.frame.revision).toBe(2);
    expect((await store.editLayers(edit)).frame).toEqual(edited.frame);
    await expect(
      store.editLayers({ ...edit, edit: { ...edit.edit, mutationId: "stale" } }),
    ).rejects.toThrow("revision conflict");

    for (const operation of [
      { type: "insert_html" as const, parentId: paragraph.id, html: "<div>invalid inside p</div>" },
      { type: "move" as const, nodeId: original.layers.roots[0]!, parentId: paragraph.id },
      {
        type: "set_styles" as const,
        nodeId: paragraph.id,
        styles: { color: "red;background:blue" },
      },
      {
        type: "set_attributes" as const,
        nodeId: paragraph.id,
        attributes: { onclick: "alert(1)" },
      },
      { type: "set_text" as const, nodeId: "missing", text: "x" },
    ]) {
      await expect(
        store.editLayers({
          workId: "work",
          pageId: "page-main",
          edit: {
            frameId: "home",
            mutationId: "invalid",
            operations: [
              {
                type: "set_text",
                nodeId: textNode(original, "Keep me").id,
                text: "must roll back",
              },
              operation,
            ],
          },
        }),
      ).rejects.toThrow();
      expect(frameOf(await store.get("work"), "home")).toEqual(edited.frame);
    }
  });

  it("applies concurrent edits from two callers in queue order", async () => {
    const { store } = await setup();
    const frame = frameOf(await workWithFrames(store, "home"), "home");
    const one = { threadId: ThreadId.makeUnsafe("agent-one"), turnId: "turn-1" };
    const two = { threadId: ThreadId.makeUnsafe("agent-two"), turnId: "turn-1" };
    const setText = (mutationId: string, text: string, to: string, expectedRevision?: number) => ({
      workId: "work",
      pageId: "page-main",
      edit: {
        frameId: "home",
        ...(expectedRevision !== undefined ? { expectedRevision } : {}),
        mutationId,
        operations: [{ type: "set_text" as const, nodeId: textNode(frame, text).id, text: to }],
      },
    });
    const [a, b] = await Promise.all([
      store.editLayers(setText("from-one", "Hello", "From one"), undefined, one),
      store.editLayers(setText("from-two", "Keep me", "From two"), undefined, two),
    ]);
    expect([a.frame.revision, b.frame.revision]).toEqual([2, 3]);
    const merged = frameOf(await store.get("work"), "home");
    expect(textNode(merged, "From one").id).toBe(textNode(frame, "Hello").id);
    expect(textNode(merged, "From two").id).toBe(textNode(frame, "Keep me").id);
    expect(await store.turnActivity(one.threadId)).toMatchObject([{ updatedFrameIds: ["home"] }]);
    expect(await store.turnActivity(two.threadId)).toMatchObject([{ updatedFrameIds: ["home"] }]);

    const raced = await Promise.allSettled([
      store.editLayers(setText("cas-one", "Hello", "CAS one", 3), undefined, one),
      store.editLayers(setText("cas-two", "Keep me", "CAS two", 3), undefined, two),
    ]);
    expect(raced.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(String((raced[1] as PromiseRejectedResult).reason)).toContain("revision conflict");
  });

  it("patches frame layout, bumping revisions only for content changes", async () => {
    const { store } = await setup();
    await workWithFrames(store, "home", "detail");
    const moved = await store.layout({
      workId: "work",
      pageId: "page-main",
      frames: [
        { id: "home", x: -120, y: 240 },
        { id: "detail", width: 800, title: "Detail wide" },
      ],
    });
    expect(frameOf(moved, "home")).toMatchObject({ x: -120, y: 240, revision: 1 });
    expect(frameOf(moved, "detail")).toMatchObject({
      width: 800,
      title: "Detail wide",
      revision: 2,
    });
    await expect(
      store.layout({ workId: "work", pageId: "page-main", frames: [{ id: "missing", x: 0 }] }),
    ).rejects.toThrow("view not found");
    await expect(
      store.layout({ workId: "work", pageId: "missing", viewport: { x: 0, y: 0, zoom: 1 } }),
    ).rejects.toThrow("page not found");
  });

  it("hides, locks and reorders frames, keeping flags out of the document when off", async () => {
    const { store } = await setup();
    await workWithFrames(store, "home", "detail");
    const flagged = await store.layout({
      workId: "work",
      pageId: "page-main",
      frames: [{ id: "home", hidden: true, locked: true }],
      order: ["detail"],
    });
    expect(pageOf(flagged, "page-main").frames.map((frame) => frame.id)).toEqual([
      "detail",
      "home",
    ]);
    expect(frameOf(flagged, "home")).toMatchObject({ hidden: true, locked: true, revision: 1 });
    const cleared = await store.layout({
      workId: "work",
      pageId: "page-main",
      frames: [{ id: "home", hidden: false, locked: false }],
    });
    expect("hidden" in frameOf(cleared, "home")).toBe(false);
    expect("locked" in frameOf(cleared, "home")).toBe(false);
    await expect(
      store.layout({ workId: "work", pageId: "page-main", order: ["missing"] }),
    ).rejects.toThrow("view not found");
  });

  it("keeps export rows per node and drops them with their frame or layer", async () => {
    const { store } = await setup();
    const work = await workWithFrames(store, "home", "detail");
    const layerId = frameOf(work, "home").layers.roots[0]!;
    const rows = [{ format: "png" as const, scale: "2x", suffix: "@2x" }];
    const saved = await store.layout({
      workId: "work",
      pageId: "page-main",
      exportSettings: [
        { key: "frame:home", entries: rows },
        { key: `layer:home:${layerId}`, entries: rows },
        { key: "frame:detail", entries: rows },
      ],
    });
    expect(Object.keys(pageOf(saved, "page-main").exportSettings ?? {})).toHaveLength(3);
    const cleared = await store.layout({
      workId: "work",
      pageId: "page-main",
      frames: [{ id: "detail", remove: true }],
      exportSettings: [{ key: `layer:home:${layerId}`, entries: [] }],
    });
    expect(pageOf(cleared, "page-main").exportSettings).toEqual({ "frame:home": rows });
  });

  it("restores exact frames with fresh revisions and removes the requested ones", async () => {
    const { store } = await setup();
    const work = await workWithFrames(store, "home", "detail");
    const snapshot = frameOf(work, "home");
    await store.layout({
      workId: "work",
      pageId: "page-main",
      frames: [{ id: "home", remove: true }],
    });
    const restored = await store.restoreFrames({
      workId: "work",
      pageId: "page-main",
      frames: [snapshot],
      removeFrameIds: ["detail"],
    });
    expect(pageOf(restored).frames).toEqual([{ ...snapshot, revision: 2 }]);

    const ahead = await store.editLayers({
      workId: "work",
      pageId: "page-main",
      edit: {
        frameId: "home",
        mutationId: "ahead",
        operations: [{ type: "set_text", nodeId: textNode(snapshot, "Hello").id, text: "Ahead" }],
      },
    });
    expect(ahead.frame.revision).toBe(3);
    const back = await store.restoreFrames({
      workId: "work",
      pageId: "page-main",
      frames: [snapshot],
      removeFrameIds: [],
    });
    expect(frameOf(back, "home")).toEqual({ ...snapshot, revision: 4 });
  });
});

const user: CanvasCommentAuthor = { kind: "user" };
const agent: CanvasCommentAuthor = { kind: "agent", threadId: ThreadId.makeUnsafe("agent-chat") };
const change = (
  store: Store,
  operation: CanvasCommentChangeInput["operation"],
  author: CanvasCommentAuthor = user,
) => store.changeComments({ workId: "work", pageId: "page-main", operation }, author);

describe("comments", () => {
  it("edits and deletes a message only for its author, and records reading", async () => {
    const { store } = await setup();
    const work = await workWithFrames(store, "home");
    const create = {
      type: "create" as const,
      threadId: "t1",
      messageId: "m1",
      frameId: "home",
      layerId: frameOf(work, "home").layers.roots[0]!,
      x: 1,
      y: 2,
      text: "First",
    };
    await change(store, create);
    await change(store, { type: "reply", threadId: "t1", messageId: "m2", text: "Agent" }, agent);
    await change(store, { type: "reply", threadId: "t1", messageId: "m3", text: "Mine" });
    const edited = await change(store, {
      type: "edit_message",
      threadId: "t1",
      messageId: "m1",
      text: "First, edited",
    });
    expect(pageOf(edited).comments[0]!.messages[0]).toMatchObject({
      text: "First, edited",
      editedAt: expect.any(String),
    });
    await expect(
      change(store, { type: "edit_message", threadId: "t1", messageId: "m2", text: "No" }),
    ).rejects.toThrow("Only the author");
    await expect(
      change(store, { type: "delete_message", threadId: "t1", messageId: "m1" }),
    ).rejects.toThrow("Delete the comment");
    const deleted = await change(store, {
      type: "delete_message",
      threadId: "t1",
      messageId: "m3",
    });
    expect(pageOf(deleted).comments[0]!.messages.map((message) => message.id)).toEqual([
      "m1",
      "m2",
    ]);
    const updatedAt = pageOf(deleted).comments[0]!.updatedAt;
    const read = await change(store, { type: "mark_read", threadId: "t1" });
    expect(pageOf(read).comments[0]).toMatchObject({ readAt: expect.any(String), updatedAt });
  });

  it("runs the thread lifecycle and removes a frame's threads with the frame", async () => {
    const { store } = await setup();
    const work = await workWithFrames(store, "home", "detail");
    const heading = elementNode(frameOf(work, "home"), "h1");
    const create = {
      type: "create" as const,
      threadId: "t1",
      messageId: "m1",
      frameId: "home",
      layerId: heading.id,
      x: 10,
      y: 20,
      text: "Make it bigger",
    };
    await change(store, create);
    expect(pageOf(await change(store, create)).comments).toHaveLength(1);
    await expect(change(store, { ...create, messageId: "m-other" })).rejects.toThrow(
      "already used",
    );
    await expect(change(store, { ...create, threadId: "t-x", layerId: "missing" })).rejects.toThrow(
      "Commented layer not found",
    );
    await expect(change(store, { ...create, threadId: "t-y", frameId: "missing" })).rejects.toThrow(
      "view not found",
    );
    const reply = { type: "reply" as const, threadId: "t1", messageId: "m2", text: "Done" };
    await change(store, reply, agent);
    await change(store, reply, agent);
    await change(store, { type: "set_status", threadId: "t1", status: "resolved" });
    const moved = await change(store, { type: "move", threadId: "t1", x: 30, y: 40 });
    expect(pageOf(moved).comments[0]).toMatchObject({
      id: "t1",
      frameId: "home",
      layerId: heading.id,
      status: "resolved",
      x: 30,
      y: 40,
      messages: [
        { id: "m1", author: user, text: "Make it bigger" },
        { id: "m2", author: agent, text: "Done" },
      ],
    });
    await expect(
      change(store, { type: "reply", threadId: "missing", messageId: "m", text: "?" }),
    ).rejects.toThrow("thread not found");

    await change(store, { ...create, threadId: "t2", frameId: "detail", layerId: null });
    const removed = await store.layout({
      workId: "work",
      pageId: "page-main",
      frames: [{ id: "home", remove: true }],
    });
    expect(pageOf(removed).frames.map((frame) => frame.id)).toEqual(["detail"]);
    expect(pageOf(removed).comments.map((thread) => thread.id)).toEqual(["t2"]);
    await change(store, { type: "delete", threadId: "t2" });
    expect(pageOf(await change(store, { type: "delete", threadId: "t2" })).comments).toEqual([]);
  });

  it("brings a removed frame's threads back with the frame (undo of a frame delete)", async () => {
    const { store } = await setup();
    const work = await workWithFrames(store, "home", "detail");
    const snapshot = frameOf(work, "home");
    const create = {
      type: "create" as const,
      messageId: "m1",
      layerId: null,
      x: 1,
      y: 2,
      text: "Note",
    };
    await change(store, { ...create, threadId: "t1", frameId: "home" });
    const before = pageOf(await change(store, { ...create, threadId: "t2", frameId: "detail" }));
    const threads = before.comments;
    await store.layout({
      workId: "work",
      pageId: "page-main",
      frames: [{ id: "home", remove: true }],
    });
    const restored = await store.restoreFrames({
      workId: "work",
      pageId: "page-main",
      frames: [snapshot],
      removeFrameIds: [],
      // t2 is still there and "gone" has no frame on the page: neither is added again.
      comments: [...threads, { ...threads[0]!, id: "gone", frameId: "missing" }],
    });
    expect(
      pageOf(restored)
        .comments.map((thread) => thread.id)
        .toSorted(),
    ).toEqual(["t1", "t2"]);
    expect(pageOf(restored).comments.find((thread) => thread.id === "t1")).toEqual(threads[0]);
  });

  it("enforces the per-page thread and per-thread message limits", async () => {
    const { directory, store } = await setup();
    const frame = putDesignFrame([], frameInput("home")).frame;
    const at = "2026-11-07T00:00:00.000Z";
    const thread = (id: string, messages: number): CanvasCommentThread => ({
      id,
      frameId: "home",
      layerId: null,
      x: 0,
      y: 0,
      status: "open",
      createdAt: at,
      updatedAt: at,
      messages: Array.from({ length: messages }, (_, index) => ({
        id: `m${index}`,
        author: { kind: "user" as const },
        text: "Comment",
        createdAt: at,
      })),
    });
    const work: CanvasWork = {
      version: 3,
      kind: "work",
      id: "work",
      title: "Work",
      folderId: null,
      projectId: null,
      createdAt: at,
      updatedAt: at,
      archivedAt: null,
      pages: [
        {
          id: "page-main",
          title: "Page 1",
          viewport: { x: 0, y: 0, zoom: 1 },
          frames: [frame],
          comments: [
            thread("full", 50),
            ...Array.from({ length: 199 }, (_, i) => thread(`t${i}`, 1)),
          ],
        },
      ],
      chats: [],
    };
    await mkdir(path.dirname(fileFor(directory, "work")), { recursive: true });
    await writeFile(fileFor(directory, "work"), JSON.stringify(work));

    const create = {
      type: "create" as const,
      threadId: "new",
      messageId: "m0",
      frameId: "home",
      layerId: null,
      x: 0,
      y: 0,
      text: "One more",
    };
    await expect(change(store, create)).rejects.toThrow("comment limit");
    await expect(
      change(store, { type: "reply", threadId: "full", messageId: "m50", text: "One more" }),
    ).rejects.toThrow("reply limit");
    // An idempotent retry of an existing message is still accepted at the limit.
    await change(store, { type: "reply", threadId: "full", messageId: "m49", text: "Comment" });
    await change(store, { type: "delete", threadId: "t0" });
    expect(pageOf(await change(store, create)).comments).toHaveLength(200);
  });
});

describe("agent turns and events", () => {
  it("records an agent turn and restores created and updated frames", async () => {
    const { store } = await setup();
    const caller = { threadId: ThreadId.makeUnsafe("agent-chat"), turnId: "turn-1" };
    const before = frameOf(await workWithFrames(store, "existing"), "existing");
    const comment = (threadId: string, frameId: string) =>
      store.changeComments(
        {
          workId: "work",
          pageId: "page-main",
          operation: {
            type: "create",
            threadId,
            messageId: "m1",
            frameId,
            layerId: null,
            x: 0,
            y: 0,
            text: "Hi",
          },
        },
        { kind: "user" },
      );
    await comment("on-existing", "existing");

    await store.putFrame(
      { workId: "work", pageId: "page-main", frame: frameInput("fresh") },
      undefined,
      caller,
    );
    await store.editLayers(
      {
        workId: "work",
        pageId: "page-main",
        edit: {
          frameId: "existing",
          expectedRevision: 1,
          mutationId: "agent-edit",
          operations: [{ type: "set_text", nodeId: textNode(before, "Hello").id, text: "Agent" }],
        },
      },
      undefined,
      caller,
    );
    await store.layout(
      { workId: "work", pageId: "page-main", frames: [{ id: "existing", x: 900 }] },
      undefined,
      caller,
    );
    await comment("on-fresh", "fresh");
    // A user edit after the turn records nothing in the agent's history.
    await store.layout({
      workId: "work",
      pageId: "page-main",
      frames: [{ id: "existing", height: 700 }],
    });

    const activity = await store.turnActivity(caller.threadId);
    expect(activity).toEqual([
      expect.objectContaining({
        threadId: caller.threadId,
        turnId: "turn-1",
        workId: "work",
        workTitle: "Work",
        pageId: "page-main",
        createdFrameIds: ["fresh"],
        updatedFrameIds: ["existing"],
        firstFrameId: "fresh",
        restorable: true,
        restoredAt: null,
      }),
    ]);

    const events: CanvasStreamEvent[] = [];
    const unsubscribe = store.subscribe((event) => events.push(event));
    const restored = await store.restoreTurn({
      workId: "work",
      threadId: caller.threadId,
      turnId: "turn-1",
    });
    unsubscribe();
    expect(pageOf(restored).frames).toEqual([{ ...before, revision: 4 }]);
    expect(pageOf(restored).comments.map((thread) => thread.id)).toEqual(["on-existing"]);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect((await store.turnActivity(caller.threadId))[0]!.restoredAt).toEqual(expect.any(String));
    await expect(
      store.restoreTurn({ workId: "work", threadId: caller.threadId, turnId: "turn-unknown" }),
    ).rejects.toThrow("no longer in history");
  });

  it("publishes only committed changes, isolates observers and shares listeners per directory", async () => {
    const { store, directory } = await setup();
    await store.create({ id: "work", title: "Work" });
    const events: CanvasStreamEvent[] = [];
    const unsubscribeThrowing = store.subscribe(() => {
      throw new Error("observer broke");
    });
    const unsubscribe = makeCanvasLibraryStore(directory).subscribe((event) => events.push(event));
    const created = await store.get("work");
    const moved = await store.layout({
      workId: "work",
      pageId: "page-main",
      viewport: { x: 1, y: 2, zoom: 1 },
    });
    const committed: CanvasStreamEvent = {
      type: "changed",
      scope: "work",
      workId: "work",
      pageId: "page-main",
      updatedAt: moved.updatedAt,
      previousUpdatedAt: created.updatedAt,
    };
    expect(events).toEqual([committed]);
    await expect(
      store.layout(
        { workId: "work", pageId: "page-main", viewport: { x: 9, y: 9, zoom: 1 } },
        async () => {
          throw new Error("turn ended");
        },
      ),
    ).rejects.toThrow("turn ended");
    expect(events).toHaveLength(1);
    expect(pageOf(await store.get("work")).viewport).toEqual({ x: 1, y: 2, zoom: 1 });
    const badge: CanvasStreamEvent = {
      type: "activity",
      workId: "work",
      pageId: "page-main",
      frameIds: [],
      threadId: ThreadId.makeUnsafe("agent"),
      expiresAt: "2026-11-07T00:00:15.000Z",
    };
    store.publish(badge);
    expect(events).toEqual([committed, badge]);
    unsubscribe();
    unsubscribeThrowing();
    await store.layout({ workId: "work", pageId: "page-main", viewport: { x: 3, y: 4, zoom: 1 } });
    expect(events).toHaveLength(2);
  });
});

describe("single-layer updates", () => {
  const changedEvents = (store: Store) => {
    const events: CanvasChangedEvent[] = [];
    const unsubscribe = store.subscribe((event) => {
      if (event.type === "changed") events.push(event);
    });
    return { events, unsubscribe };
  };

  it("edits a work holding a 2 MiB asset without writing asset bytes and names the frame in its event", async () => {
    const { store, directory } = await setup();
    const work = await workWithFrames(store, "home", "detail");
    const bytes = randomBytes(2 * 1024 * 1024 - 64);
    await store.putAssets("work", [upload("photo", bytes)]);
    const assetFile = path.join(assetDirectory(directory), sha256(bytes));
    const assetBefore = await stat(assetFile);
    const before = await store.get("work");
    const heading = elementNode(frameOf(work, "home"), "h1");
    vi.mocked(writeFileStringAtomically).mockClear();
    vi.mocked(createFileStringExclusively).mockClear();
    const { events, unsubscribe } = changedEvents(store);

    const edited = await store.editLayers({
      workId: "work",
      pageId: "page-main",
      edit: {
        frameId: "home",
        mutationId: "restyle",
        operations: [{ type: "set_styles", nodeId: heading.id, styles: { color: "#ff0000" } }],
      },
    });
    unsubscribe();

    // One document write, a few KiB, and nothing in the asset store.
    const writes = vi.mocked(writeFileStringAtomically).mock.calls.map(([input]) => input);
    expect(writes.map((input) => input.filePath)).toEqual([fileFor(directory, "work")]);
    expect(Buffer.byteLength(writes[0]!.contents)).toBeLessThan(16 * 1024);
    expect(vi.mocked(createFileStringExclusively)).not.toHaveBeenCalled();
    const assetAfter = await stat(assetFile);
    expect([assetAfter.ino, assetAfter.mtimeMs, assetAfter.size]).toEqual([
      assetBefore.ino,
      assetBefore.mtimeMs,
      bytes.length,
    ]);
    expect((await stat(fileFor(directory, "work"))).size).toBeLessThan(16 * 1024);

    expect(events).toEqual([
      {
        type: "changed",
        scope: "work",
        workId: "work",
        pageId: "page-main",
        frameId: "home",
        revision: 2,
        mutationId: "restyle",
        updatedAt: edited.work.updatedAt,
        previousUpdatedAt: before.updatedAt,
        delta: {
          operations: [
            {
              type: "set_attributes",
              nodeId: heading.id,
              attributes: { style: "color:#ff0000" },
            },
          ],
          lastLayerEdit: edited.frame.lastLayerEdit,
        },
      },
    ]);
  });

  it("sends edits a client can replay to the exact stored frame, untouched layers kept", async () => {
    const { store } = await setup();
    const work = await workWithFrames(store, "home");
    const before = frameOf(work, "home");
    const main = elementNode(before, "main");
    const paragraph = elementNode(before, "p");
    const target = before.layers.nodes.find(
      (node) => node.type === "element" && node.attributes.class === "target",
    )!;
    const { events, unsubscribe } = changedEvents(store);
    const edited = await store.editLayers({
      workId: "work",
      pageId: "page-main",
      edit: {
        frameId: "home",
        mutationId: "everything",
        operations: [
          { type: "set_text", nodeId: textNode(before, "Keep me").id, text: "Line\r\nbreak" },
          {
            type: "set_attributes",
            nodeId: paragraph.id,
            attributes: { "data-name": "Body", style: "color: blue ; margin:0" },
          },
          { type: "set_styles", nodeId: main.id, styles: { padding: "24px", display: "flex" } },
          { type: "set_frame_styles", styles: { background: "#101010" } },
          {
            type: "insert_html",
            parentId: main.id,
            beforeId: paragraph.id,
            html: '<section class="card"><span>New</span></section>',
            css: ".card{border-radius:8px}",
          },
          {
            type: "insert_layers",
            parentId: null,
            layers: {
              roots: ["restored"],
              nodes: [
                { id: "restored", type: "element", tag: "div", attributes: {}, children: ["rt"] },
                { id: "rt", type: "text", text: "Back" },
              ],
            },
          },
          { type: "move", nodeId: target.id, parentId: null, beforeId: main.id },
          { type: "set_attributes", nodeId: "restored", attributes: { title: "Again" } },
          { type: "delete", nodeId: elementNode(before, "h1").id },
        ],
      },
    });
    unsubscribe();
    const event = events.at(-1)!;
    expect(event).toMatchObject({ frameId: "home", revision: 2, mutationId: "everything" });
    const replayed = applyDesignLayerEdits(before.layers, event.delta!.operations);
    expect(JSON.stringify(replayed)).toBe(JSON.stringify(edited.frame.layers));
    expect(event.delta!.style).toBe(edited.frame.style);
    expect(event.delta!.lastLayerEdit).toEqual(edited.frame.lastLayerEdit);
    // Clients never parse HTML: the inserted section arrives as layers.
    expect(JSON.stringify(event.delta)).not.toContain("<section");
    // Layers no edit touched keep their identity for keyed renderers.
    const untouched = before.layers.nodes.find(
      (node) => node.type === "text" && node.text === "Hello",
    );
    expect(replayed.nodes).not.toContain(untouched);
    const keep = textNode(before, "Keep me");
    expect(replayed.nodes.find((node) => node.id === keep.id)).not.toBe(keep);
    const inner = before.layers.nodes.find((node) => node.id === target.id)!;
    expect(replayed.nodes.find((node) => node.id === target.id)).toBe(inner);
  });

  it("keeps large inserts out of the event and still names the frame and revision", async () => {
    const { store } = await setup();
    await workWithFrames(store, "home");
    const { events, unsubscribe } = changedEvents(store);
    await store.editLayers({
      workId: "work",
      pageId: "page-main",
      edit: {
        frameId: "home",
        mutationId: "big",
        operations: [
          { type: "insert_html", parentId: null, html: `<p>${"word ".repeat(16_000)}</p>` },
        ],
      },
    });
    unsubscribe();
    expect(events.at(-1)).toMatchObject({ workId: "work", frameId: "home", revision: 2 });
    expect(events.at(-1)!.delta).toBeUndefined();
  });
});

const edit = (
  store: Store,
  mutationId: string,
  operations: CanvasEditLayersInput["edit"]["operations"],
  options: { agent?: boolean } = { agent: true },
) =>
  store.editLayers(
    { workId: "work", pageId: "page-main", edit: { frameId: "home", mutationId, operations } },
    undefined,
    undefined,
    options,
  );
const childrenOf = (frame: DesignFrame, id: string) => {
  const node = frame.layers.nodes.find((item) => item.id === id);
  return node?.type === "element" ? node.children : [];
};

describe("agent layer operations", () => {
  it("duplicates a subtree with new IDs, after the original or where asked, and retries it", async () => {
    const { store } = await setup();
    const before = frameOf(await workWithFrames(store, "home"), "home");
    const main = elementNode(before, "main");
    const heading = elementNode(before, "h1");
    const paragraph = elementNode(before, "p");
    const operations = [
      { type: "duplicate" as const, nodeId: heading.id },
      { type: "duplicate" as const, nodeId: paragraph.id, parentId: null },
      {
        type: "duplicate" as const,
        nodeId: textNode(before, "Keep me").id,
        parentId: main.id,
        beforeId: heading.id,
      },
    ];
    const result = await edit(store, "copies", operations);
    expect(result.duplicates).toHaveLength(3);
    const [title, body, text] = result.duplicates;
    expect(Object.keys(title!.idMap)).toEqual([heading.id, textNode(before, "Hello").id]);
    expect(new Set(Object.values(title!.idMap)).size).toBe(2);
    for (const id of Object.values(title!.idMap))
      expect(before.layers.nodes.map((node) => node.id)).not.toContain(id);
    expect(result.createdNodeIds).toEqual([
      ...Object.values(title!.idMap),
      ...Object.values(body!.idMap),
      ...Object.values(text!.idMap),
    ]);
    const after = result.frame;
    // The copy of the heading sits right after it; the text copy goes before the heading.
    expect(childrenOf(after, main.id)).toEqual([
      text!.newId,
      heading.id,
      title!.newId,
      paragraph.id,
      childrenOf(before, main.id)[2],
    ]);
    expect(after.layers.roots).toEqual([main.id, body!.newId]);
    const copiedText = after.layers.nodes.find(
      (node) => node.id === title!.idMap[textNode(before, "Hello").id],
    );
    expect(copiedText).toEqual({
      id: title!.idMap[textNode(before, "Hello").id],
      type: "text",
      text: "Hello",
    });
    expect(after.lastLayerEdit?.duplicates).toEqual(result.duplicates);
    // A retry of the same mutation answers with the same copies.
    expect((await edit(store, "copies", operations)).duplicates).toEqual(result.duplicates);
    await expect(
      edit(store, "into-void", [
        { type: "set_text", nodeId: textNode(before, "Hello").id, text: "x" },
        { type: "duplicate", nodeId: heading.id, parentId: elementNode(after, "div").id },
        { type: "duplicate", nodeId: heading.id, parentId: "missing" },
      ]),
    ).rejects.toThrow(
      `operations[2] (duplicate on layer ${heading.id}) was refused: Layer not found: missing.`,
    );
  });

  it("replaces a layer with parsed HTML in the same sibling slot", async () => {
    const { store } = await setup();
    const before = frameOf(await workWithFrames(store, "home"), "home");
    const main = elementNode(before, "main");
    const paragraph = elementNode(before, "p");
    const result = await edit(store, "replace", [
      {
        type: "replace_html",
        nodeId: paragraph.id,
        html: '<section class="intro"><span>One</span></section><p>Two</p>',
        css: ".intro{padding:4px}",
      },
    ]);
    const [heading, , target] = childrenOf(before, main.id);
    const children = childrenOf(result.frame, main.id);
    expect(children).toHaveLength(4);
    expect([children[0], children[3]]).toEqual([heading, target]);
    expect(result.createdNodeIds).toEqual(expect.arrayContaining([children[1], children[2]]));
    expect(result.frame.layers.nodes.some((node) => node.id === paragraph.id)).toBe(false);
    expect(
      result.frame.layers.nodes.some((node) => node.id === textNode(before, "Keep me").id),
    ).toBe(false);
    expect(serializeDesignLayers(result.frame.layers, false)).toContain(
      '<section class="intro" style="padding:4px"><span>One</span></section><p>Two</p>',
    );
    // Content the browser would re-nest is refused, naming the operation.
    const span = result.frame.layers.nodes.find(
      (node) => node.type === "element" && node.tag === "span",
    )!;
    await expect(
      edit(store, "bad-nesting", [
        { type: "replace_html", nodeId: span.id, html: "<span>fine</span>" },
        { type: "insert_html", parentId: children[2]!, html: "<div>block in p</div>" },
        { type: "set_text", nodeId: textNode(result.frame, "Two").id, text: "after" },
      ]),
    ).rejects.toThrow(
      `operations[1] (insert_html under layer ${children[2]}) was refused: Invalid HTML layer nesting.`,
    );
  });

  it("drops and reports rejected CSS for agents, keeps the editor strict, refuses malformed CSS", async () => {
    const { store } = await setup();
    const before = frameOf(await workWithFrames(store, "home"), "home");
    const heading = elementNode(before, "h1");
    const paragraph = elementNode(before, "p");
    const operations = [
      {
        type: "set_styles" as const,
        nodeId: heading.id,
        styles: { color: "url(https://example.com/x.png)", "font-size": "32px" },
      },
      {
        type: "set_attributes" as const,
        nodeId: paragraph.id,
        attributes: { style: "margin:0;background:url(https://example.com/y.png)" },
      },
      {
        type: "set_frame_styles" as const,
        styles: { "background-image": "image-set('a.png' 1x)" },
      },
    ];
    // The editor's rule: the batch is refused, with the plain message its toast shows.
    const strict = edit(store, "strict", operations, {});
    await expect(strict).rejects.toThrow(/^Unsupported CSS: color loads an external resource/);
    const result = await edit(store, "agent", operations);
    const stored = (id: string) => result.frame.layers.nodes.find((node) => node.id === id);
    // The heading keeps the color it had; nothing rejected is ever stored.
    expect(stored(heading.id)).toMatchObject({
      attributes: { style: "color:green;font-size:32px" },
    });
    expect(stored(paragraph.id)).toMatchObject({ attributes: { style: "margin:0" } });
    expect(result.frame.style).toBeUndefined();
    expect(JSON.stringify(result.frame)).not.toContain("example.com");
    expect(result.dropped).toEqual([
      `Dropped color on layer ${heading.id} (operations[0]): color loads an external resource; import it with synara_import_canvas_asset`,
      `Dropped background on layer ${paragraph.id} (operations[1]): background loads an external resource; import it with synara_import_canvas_asset`,
      "Dropped background-image on the frame style (operations[2]): background-image uses an unsupported CSS function",
    ]);
    expect(result.frame.lastLayerEdit?.dropped).toEqual(result.dropped);
    expect((await edit(store, "agent", operations)).dropped).toEqual(result.dropped);
    for (const styles of [
      { color: "red;background:blue" },
      { color: "red;background:url(https://example.com/z.png)" },
      { "1color": "red" },
    ])
      await expect(
        edit(store, "malformed", [{ type: "set_styles", nodeId: heading.id, styles }]),
      ).rejects.toThrow(`operations[0] (set_styles on layer ${heading.id}) was refused`);
  });

  it("sends duplicate and replace_html as deltas a client replays to the stored frame", async () => {
    const { store } = await setup();
    const before = frameOf(await workWithFrames(store, "home"), "home");
    const events: CanvasChangedEvent[] = [];
    const unsubscribe = store.subscribe((event) => {
      if (event.type === "changed") events.push(event);
    });
    const result = await edit(store, "both", [
      { type: "duplicate", nodeId: elementNode(before, "main").id },
      { type: "replace_html", nodeId: elementNode(before, "p").id, html: "<p>New <b>copy</b></p>" },
      {
        type: "duplicate",
        nodeId: elementNode(before, "h1").id,
        parentId: null,
        beforeId: elementNode(before, "main").id,
      },
    ]);
    unsubscribe();
    const delta = events.at(-1)!.delta!;
    expect(delta.operations.map((operation) => operation.type)).toEqual([
      "insert_layers",
      "insert_layers",
      "delete",
      "insert_layers",
    ]);
    const replayed = applyDesignLayerEdits(before.layers, delta.operations);
    expect(JSON.stringify(replayed)).toBe(JSON.stringify(result.frame.layers));
    expect(delta.lastLayerEdit.duplicates).toEqual(result.duplicates);
    // Clients never parse HTML, and layers no operation touched keep their identity.
    expect(JSON.stringify(delta)).not.toContain("<p>");
    const untouched = before.layers.nodes.find((node) => node.id === textNode(before, "Hello").id);
    expect(replayed.nodes).toContain(untouched);
  });
});
