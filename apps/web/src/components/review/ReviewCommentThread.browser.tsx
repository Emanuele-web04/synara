import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ReviewCommentThread, type ReviewCommentThreadActions } from "./ReviewCommentThread";

function buildActions(): ReviewCommentThreadActions {
  return {
    saveDraft: vi.fn(),
    cancelDraft: vi.fn(),
    updateBody: vi.fn(),
    toggleResolved: vi.fn(),
    remove: vi.fn(),
    startReply: vi.fn(),
    convertFinding: vi.fn(),
    dismissFinding: vi.fn(),
    resolveRemoteThread: vi.fn(),
    replyRemoteThread: vi.fn(),
    editRemoteComment: vi.fn(),
    deleteRemoteComment: vi.fn(),
  };
}

async function mountDraftThread() {
  const actions = buildActions();
  const host = document.createElement("div");
  host.className = "w-[520px] bg-background p-4";
  document.body.append(host);
  const screen = await render(
    <ReviewCommentThread
      actions={actions}
      data={{
        kind: "local-draft",
        path: "src/review/a.ts",
        line: 42,
        side: "RIGHT",
        comments: [],
        draft: {
          draftId: "draft-1",
          path: "src/review/a.ts",
          line: 42,
          side: "RIGHT",
          threadId: null,
          serverId: null,
          body: "",
          status: "editing",
        },
      }}
    />,
    { container: host },
  );
  return {
    actions,
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

async function mountDraftThreadWithViewer() {
  const actions = buildActions();
  const host = document.createElement("div");
  host.className = "w-[520px] bg-background p-4";
  document.body.append(host);
  const screen = await render(
    <ReviewCommentThread
      actions={actions}
      viewer={{
        login: "Tbsheff",
        avatarUrl: "https://avatars.githubusercontent.com/u/92263166?v=4",
      }}
      data={{
        kind: "local-draft",
        path: "src/review/a.ts",
        line: 42,
        side: "RIGHT",
        comments: [],
        draft: {
          draftId: "draft-1",
          path: "src/review/a.ts",
          line: 42,
          side: "RIGHT",
          threadId: null,
          serverId: null,
          body: "",
          status: "editing",
        },
      }}
    />,
    { container: host },
  );
  return {
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

async function mountSubmittedThread() {
  const actions = buildActions();
  const host = document.createElement("div");
  host.className = "w-[520px] bg-background p-4";
  document.body.append(host);
  const screen = await render(
    <ReviewCommentThread
      actions={actions}
      data={{
        kind: "submitted-thread",
        path: "src/review/a.ts",
        line: 42,
        side: "RIGHT",
        thread: {
          id: "thread-1",
          path: "src/review/a.ts",
          line: 42,
          side: "RIGHT",
          isResolved: false,
          comments: [
            {
              author: "octocat",
              authorAvatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4",
              body: "Can we tighten this?",
              createdAt: "2026-06-07T12:00:00.000Z",
            },
          ],
        },
      }}
    />,
    { container: host },
  );
  return {
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

async function mountLocalThreadWithViewer() {
  const actions = buildActions();
  const host = document.createElement("div");
  host.className = "w-[520px] bg-background p-4";
  document.body.append(host);
  const screen = await render(
    <ReviewCommentThread
      actions={actions}
      viewer={{
        login: "Tbsheff",
        avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
      }}
      data={{
        kind: "local-draft",
        path: "src/review/a.ts",
        line: 42,
        side: "RIGHT",
        comments: [
          {
            id: "local-1",
            threadId: "thread-1",
            path: "src/review/a.ts",
            line: 42,
            side: "RIGHT",
            body: "Pending local comment",
            resolved: false,
            createdAt: "2026-06-07T12:00:00.000Z",
            updatedAt: "2026-06-07T12:00:00.000Z",
          },
        ],
        draft: null,
      }}
    />,
    { container: host },
  );
  return {
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

describe("ReviewCommentThread", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders the polished write/preview inline comment editor", async () => {
    const mounted = await mountDraftThread();

    try {
      await expect.element(page.getByRole("tab", { name: "Write" })).toBeVisible();
      await expect.element(page.getByRole("tab", { name: "Preview" })).toBeVisible();
      await page.getByLabelText("Inline review comment").fill("Looks good.");
      await page.getByRole("tab", { name: "Preview" }).click();
      await expect.element(page.getByText("Looks good.")).toBeVisible();
      await page.getByRole("button", { name: "Add comment" }).click();

      expect(mounted.actions.saveDraft).toHaveBeenCalledWith("draft-1", "Looks good.");
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders submitted GitHub comment author avatars", async () => {
    const mounted = await mountSubmittedThread();

    try {
      const avatar = page.getByRole("img", { name: "octocat" }).element();
      expect(avatar).toHaveAttribute("src", "https://avatars.githubusercontent.com/u/583231?v=4");
      await expect.element(page.getByText("Can we tighten this?")).toBeVisible();
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders current viewer avatars for pending local comments", async () => {
    const mounted = await mountLocalThreadWithViewer();

    try {
      const avatar = page.getByRole("img", { name: "Tbsheff" }).element();
      expect(avatar).toHaveAttribute("src", "https://avatars.githubusercontent.com/u/1?v=4");
      await expect.element(page.getByText("Pending local comment")).toBeVisible();
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders the current viewer avatar while writing a draft comment", async () => {
    const mounted = await mountDraftThreadWithViewer();

    try {
      const avatar = page.getByRole("img", { name: "Tbsheff" }).element();
      expect(avatar).toHaveAttribute("src", "https://avatars.githubusercontent.com/u/92263166?v=4");
      await expect.element(page.getByText("Pending")).toBeVisible();
    } finally {
      await mounted.cleanup();
    }
  });
});
