import "../../../index.css";

import type {
  CanvasCommentChangeInput,
  CanvasCommentThread,
  CanvasWork,
  DesignFrame,
} from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const native = vi.hoisted(() => ({
  canvas: { changeComments: vi.fn() },
  dialogs: { confirm: vi.fn() },
}));
vi.mock("../../../nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../nativeApi")>()),
  ensureNativeApi: () => native,
  readNativeApi: () => undefined,
}));

import { SidebarProvider } from "../../ui/sidebar";
import { toastManager } from "../../ui/toast";
import { useCanvasEditorStore } from "../canvasStores";
import { CanvasCommentLayer } from "./CanvasComments";
import { CanvasCommentsPanel } from "./CanvasCommentsPanel";
import { CanvasEditorProvider, useCanvasEditor } from "./CanvasEditorContext";
import { CanvasFrameView } from "./CanvasFrameView";

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const frame: DesignFrame = {
  id: "frame1",
  title: "Sign in",
  x: 40,
  y: 40,
  width: 320,
  height: 260,
  revision: 1,
  style: "background: #ffffff",
  layers: {
    roots: ["title"],
    nodes: [
      {
        id: "title",
        type: "element",
        tag: "p",
        attributes: { "data-name": "Headline", style: "font-size: 20px; margin: 16px" },
        children: ["titleText"],
      },
      { id: "titleText", type: "text", text: "Your next chapter" },
    ],
  },
};

const thread = (
  id: string,
  text: string,
  overrides: Partial<CanvasCommentThread> = {},
): CanvasCommentThread => ({
  id,
  frameId: "frame1",
  layerId: null,
  x: 40,
  y: 40,
  status: "open",
  createdAt: minutesAgo(5),
  updatedAt: minutesAgo(5),
  messages: [{ id: `${id}m`, author: { kind: "user" }, text, createdAt: minutesAgo(5) }],
  ...overrides,
});

const comments: CanvasCommentThread[] = [
  thread("headline", "Headline feels too heavy", { layerId: "title", x: 12, y: 4 }),
  thread("button", "Full-width, #1F6F4A fill", {
    x: 200,
    y: 150,
    messages: [
      {
        id: "b1",
        author: { kind: "user" },
        text: "Full-width, #1F6F4A fill",
        createdAt: minutesAgo(5),
      },
      {
        id: "b2",
        author: { kind: "agent", threadId: "chat1" as never },
        text: "Updated fill and label color.",
        createdAt: minutesAgo(4),
      },
    ],
  }),
  thread("logo", "Add the logo", { status: "resolved", x: 60, y: 220 }),
];

const workWith = (threads: CanvasCommentThread[]) =>
  ({
    id: "work1",
    title: "Work",
    folderId: null,
    createdAt: minutesAgo(60),
    updatedAt: minutesAgo(60),
    archivedAt: null,
    version: 3,
    kind: "work",
    projectId: null,
    assets: [],
    chats: [],
    pages: [
      {
        id: "page1",
        title: "Page 1",
        viewport: { x: 0, y: 0, zoom: 1 },
        frames: [frame],
        comments: threads,
      },
    ],
  }) as unknown as CanvasWork;

type Pending = { frameId: string; layerId: string | null; x: number; y: number };

function Stage({ initialPending }: { initialPending: Pending | null }) {
  const editor = useCanvasEditor();
  const stage = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState(initialPending);
  const context = useMemo(() => ({ fonts: editor.fonts, assetUrl: () => null }), [editor.fonts]);
  const relative = (element: Element | null) => {
    if (!element || !stage.current) return null;
    const box = element.getBoundingClientRect();
    const origin = stage.current.getBoundingClientRect();
    return {
      x: box.left - origin.left,
      y: box.top - origin.top,
      width: box.width,
      height: box.height,
    };
  };
  return (
    <div
      ref={stage}
      data-canvas-viewport=""
      data-testid="canvas"
      className="relative h-[420px] w-[720px] shrink-0 overflow-hidden bg-muted"
    >
      <CanvasFrameView
        frame={frame}
        context={context}
        zoom={1}
        selected={false}
        hovered={false}
        agentActive={false}
        onRegister={editor.registerFrame}
      />
      <CanvasCommentLayer
        frameRect={(frameId) => relative(editor.elementFor({ kind: "frame", frameId }))}
        layerRect={(frameId, layerId) =>
          relative(editor.elementFor({ kind: "layer", frameId, layerId }))
        }
        pending={pending}
        onPendingDone={() => {
          pendingDone();
          setPending(null);
        }}
      />
    </div>
  );
}

const pendingDone = vi.fn();
const askAgent = vi.fn();

async function mount({
  threads = comments,
  pending = null,
}: { threads?: CanvasCommentThread[]; pending?: Pending | null } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SidebarProvider>
        <CanvasEditorProvider
          work={workWith(threads)}
          pageId="page1"
          readOnly={false}
          onAskAgent={askAgent}
        >
          <div className="flex">
            <CanvasCommentsPanel className="w-[216px] shrink-0 border-e" />
            <Stage initialPending={pending} />
          </div>
        </CanvasEditorProvider>
      </SidebarProvider>
    </QueryClientProvider>,
  );
}

/** A pin on the canvas, named by its first message. */
const pin = (name: string) => page.getByTestId("canvas").getByRole("button", { name, exact: true });

type Operation = CanvasCommentChangeInput["operation"];
const operations = (): Operation[] =>
  native.canvas.changeComments.mock.calls.map(
    ([input]) => (input as CanvasCommentChangeInput).operation,
  );

describe("canvas comments", () => {
  beforeEach(async () => {
    await page.viewport(1100, 600);
    native.canvas.changeComments.mockReset().mockResolvedValue(workWith(comments));
    native.dialogs.confirm.mockReset();
    pendingDone.mockReset();
    askAgent.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it("posts a new comment on its layer from the bubble", async () => {
    await mount({ pending: { frameId: "frame1", layerId: "title", x: 10.4, y: 5.6 } });
    await page.getByPlaceholder("Add a comment").fill("Make this warmer");
    await page.getByRole("button", { name: "Post", exact: true }).click();
    await vi.waitFor(() => expect(pendingDone).toHaveBeenCalled());
    expect(operations()[0]).toMatchObject({
      type: "create",
      frameId: "frame1",
      layerId: "title",
      x: 10,
      y: 6,
      text: "Make this warmer",
    });
    expect(askAgent).not.toHaveBeenCalled();
  });

  it("asks the agent with Mod+Enter", async () => {
    await mount({ pending: { frameId: "frame1", layerId: "title", x: 10, y: 5 } });
    const field = page.getByPlaceholder("Add a comment");
    await field.fill("Warmer cream background");
    await userEvent.keyboard(
      navigator.platform.includes("Mac") ? "{Meta>}{Enter}{/Meta}" : "{Control>}{Enter}{/Control}",
    );
    await vi.waitFor(() => expect(askAgent).toHaveBeenCalled());
    const created = operations()[0] as Extract<Operation, { type: "create" }>;
    expect(askAgent.mock.calls[0]![0]).toContain(
      '"Headline" in "Sign in": Warmer cream background',
    );
    expect(askAgent.mock.calls[0]![0]).toContain(`commentThreadId=${created.threadId}`);
  });

  it("drops a written comment on Escape only after the discard confirmation", async () => {
    await mount({ pending: { frameId: "frame1", layerId: null, x: 10, y: 5 } });
    await page.getByPlaceholder("Add a comment").fill("Never mind");
    native.dialogs.confirm.mockResolvedValueOnce(false);
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(native.dialogs.confirm).toHaveBeenCalledWith("Discard changes?"));
    expect(pendingDone).not.toHaveBeenCalled();
    native.dialogs.confirm.mockResolvedValueOnce(true);
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(pendingDone).toHaveBeenCalledTimes(1));
    expect(operations()).toEqual([]);
  });

  it("drops an empty comment on a click on the canvas but keeps a written one", async () => {
    await mount({ pending: { frameId: "frame1", layerId: null, x: 10, y: 5 } });
    const field = page.getByPlaceholder("Add a comment");
    await field.fill("Keep me");
    await page.getByTestId("canvas").click({ position: { x: 700, y: 400 } });
    expect(pendingDone).not.toHaveBeenCalled();
    await field.fill("");
    await page.getByTestId("canvas").click({ position: { x: 700, y: 400 } });
    expect(pendingDone).toHaveBeenCalledTimes(1);
  });

  it("resolves a thread with an 8 second Undo", async () => {
    const add = vi.spyOn(toastManager, "add");
    await mount();
    await pin("Headline feels too heavy").click();
    const card = page.getByRole("dialog", { name: "Headline" });
    await expect.element(card).toBeVisible();
    await card.getByRole("button", { name: "Resolve" }).click();
    await vi.waitFor(() => expect(add).toHaveBeenCalled());
    expect(operations()[0]).toEqual({
      type: "set_status",
      threadId: "headline",
      status: "resolved",
    });
    const toast = add.mock.calls.at(-1)![0] as {
      timeout: number;
      actionProps: { onClick: () => void };
    };
    expect(toast.timeout).toBe(8000);
    await expect.element(card).not.toBeInTheDocument();
    toast.actionProps.onClick();
    await vi.waitFor(() =>
      expect(operations()[1]).toEqual({ type: "set_status", threadId: "headline", status: "open" }),
    );
  });

  it("replies, and closes the thread on Escape or a click on the canvas", async () => {
    await mount();
    await pin("Full-width, #1F6F4A fill").click();
    const card = page.getByRole("dialog", { name: "Sign in" });
    await expect.element(card.getByText("Updated fill and label color.")).toBeVisible();
    // Opening a thread with an unread agent reply reads it.
    await vi.waitFor(() =>
      expect(operations()[0]).toEqual({ type: "mark_read", threadId: "button" }),
    );
    await card.getByPlaceholder("Reply").fill("Thanks");
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() =>
      expect(operations()[1]).toMatchObject({ type: "reply", threadId: "button", text: "Thanks" }),
    );
    await userEvent.keyboard("{Escape}");
    await expect.element(card).not.toBeInTheDocument();

    await pin("Full-width, #1F6F4A fill").click();
    await expect.element(card).toBeVisible();
    await page.getByTestId("canvas").click({ position: { x: 700, y: 400 } });
    await expect.element(card).not.toBeInTheDocument();
  });

  it("deletes a thread only after confirmation", async () => {
    await mount();
    await pin("Headline feels too heavy").click();
    const card = page.getByRole("dialog", { name: "Headline" });
    native.dialogs.confirm.mockResolvedValueOnce(false);
    await card.getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await vi.waitFor(() => expect(native.dialogs.confirm).toHaveBeenCalledTimes(1));
    expect(operations()).toEqual([]);
    await expect.element(card).toBeVisible();

    native.dialogs.confirm.mockResolvedValueOnce(true);
    await card.getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await vi.waitFor(() =>
      expect(operations()).toEqual([{ type: "delete", threadId: "headline" }]),
    );
    await expect.element(card).not.toBeInTheDocument();
  });

  it("asks the agent about a thread from its menu", async () => {
    await mount();
    await pin("Headline feels too heavy").click();
    await page
      .getByRole("dialog", { name: "Headline" })
      .getByRole("button", { name: "More" })
      .click();
    await page.getByRole("menuitem", { name: /Ask agent/ }).click();
    await vi.waitFor(() => expect(askAgent).toHaveBeenCalledTimes(1));
    expect(askAgent.mock.calls[0]![0]).toContain("commentThreadId=headline");
    expect(operations()).toEqual([]);
  });

  it("lists open and resolved threads and opens or reopens them", async () => {
    await mount();
    const list = page.getByRole("region", { name: "Comments" });
    await expect.element(list.getByText("Open · 2")).toBeVisible();
    await expect.element(list.getByText("Resolved · 1")).toBeVisible();
    await expect.element(list.getByText("Agent replied · 1")).toBeVisible();
    await list.getByText("Headline feels too heavy").click();
    await expect.element(page.getByRole("dialog", { name: "Headline" })).toBeVisible();
    await list.getByRole("button", { name: "Reopen" }).click();
    await vi.waitFor(() =>
      expect(operations()).toEqual([{ type: "set_status", threadId: "logo", status: "open" }]),
    );
  });

  it("edits a message in place and deletes the thread from its first message", async () => {
    await mount();
    await pin("Headline feels too heavy").click();
    const card = page.getByRole("dialog", { name: "Headline" });
    await card.getByRole("button", { name: "Message actions" }).click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    await card.getByRole("textbox", { name: "Edit" }).fill("Headline is heavy");
    await card.getByRole("button", { name: "Save" }).click();
    await vi.waitFor(() =>
      expect(operations()).toContainEqual({
        type: "edit_message",
        threadId: "headline",
        messageId: "headlinem",
        text: "Headline is heavy",
      }),
    );
    native.dialogs.confirm.mockResolvedValueOnce(true);
    await card.getByRole("button", { name: "Message actions" }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await vi.waitFor(() =>
      expect(operations()).toContainEqual({ type: "delete", threadId: "headline" }),
    );
  });

  it("searches, filters and hides resolved threads, and marks unread ones", async () => {
    localStorage.removeItem("synara:canvas-comments-show-resolved");
    await mount();
    const list = page.getByRole("region", { name: "Comments" });
    // The agent's reply on "button" has not been read.
    await expect.element(list.getByRole("img", { name: "Unread" })).toBeVisible();
    await list.getByRole("textbox", { name: "Search comments" }).fill("logo");
    await expect.element(list.getByText("Add the logo")).toBeVisible();
    await expect.element(list.getByText("Headline feels too heavy")).not.toBeInTheDocument();
    await list.getByRole("textbox", { name: "Search comments" }).fill("");
    await list.getByRole("button", { name: "Sort and filter" }).click();
    await page.getByRole("menuitemcheckbox", { name: "Show resolved" }).click();
    await expect.element(list.getByText("Add the logo")).not.toBeInTheDocument();
    expect(localStorage.getItem("synara:canvas-comments-show-resolved")).toBe("false");
    // Only threads an agent started: none here.
    await page.getByRole("menuitemradio", { name: "Agent" }).click();
    await expect.element(list.getByText("No comments match your filters")).toBeVisible();
  });

  it("shrinks a closed pin with the canvas below 50% zoom, from its anchor corner", async () => {
    await mount({
      threads: [thread("small", "Tiny frame note", { layerId: "title", x: 12, y: 4 })],
    });
    const body = () =>
      pin("Tiny frame note").element().querySelector<HTMLElement>("[data-comment-pin-body]")!;
    const stage = document.querySelector<HTMLElement>("[data-testid=canvas]")!;
    const size = () => body().getBoundingClientRect();
    // At 100% and down to 50% the pin keeps its 26px screen size.
    expect(Math.round(size().width)).toBe(26);
    stage.style.setProperty("--canvas-zoom", "0.5");
    expect(Math.round(size().width)).toBe(26);
    // At 25% it is half size, still on its anchor point (the pin's bottom-left corner).
    stage.style.setProperty("--canvas-zoom", "0.25");
    expect(Math.round(size().width)).toBe(13);
    const anchor = body().parentElement!.parentElement!.getBoundingClientRect();
    expect(Math.round(size().left)).toBe(Math.round(anchor.left));
    expect(Math.round(size().bottom)).toBe(Math.round(anchor.bottom));
    // It never gets smaller than half.
    stage.style.setProperty("--canvas-zoom", "0.05");
    expect(Math.round(size().width)).toBe(13);
  });

  it("keeps a pin inside its layer and hides every pin with ⇧C", async () => {
    await mount({
      threads: [thread("far", "Off the edge", { layerId: "title", x: 9999, y: 4 })],
    });
    const box = (await pin("Off the edge").element()).getBoundingClientRect();
    const title = document
      .querySelector<HTMLElement>("[data-canvas-frame-id]")!
      .shadowRoot!.querySelector<HTMLElement>('[data-synara-layer-id="title"]')!
      .getBoundingClientRect();
    expect(box.left).toBeLessThanOrEqual(title.right);
    useCanvasEditorStore.setState({ commentsHidden: true });
    await expect.element(pin("Off the edge")).not.toBeInTheDocument();
    useCanvasEditorStore.setState({ commentsHidden: false });
  });
});
