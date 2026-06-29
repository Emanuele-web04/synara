import "../../index.css";

import {
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type ReviewCheck,
  type ReviewPullRequestDetail,
} from "@t3tools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ReviewPrSidebar } from "./ReviewPrSidebar";
import { ReviewPrView } from "./ReviewPrView";
import { buildReviewSidechatContextPayload } from "./reviewSidechatContext";
import { prewarmReviewChatThread, sendReviewChatQuestion } from "~/lib/reviewChatThread";
import { reviewQueryKeys } from "~/lib/reviewReactQuery";
import { useStore } from "~/store";
import type { Project, Thread } from "~/types";

vi.mock("~/lib/reviewChatThread", async (importActual) => {
  const actual = await importActual<typeof import("~/lib/reviewChatThread")>();
  return {
    ...actual,
    defaultReviewChatModelSelection: vi.fn(() => ({
      provider: "codex",
      model: "gpt-5.3-codex-spark",
      options: { reasoningEffort: "low" },
    })),
    prewarmReviewChatThread: vi.fn(async () => ({
      status: "unavailable" as const,
      reason: "No Synara project is open for this repository.",
    })),
    sendReviewChatQuestion: vi.fn(async () => ({
      status: "unavailable" as const,
      reason: "No Synara project is open for this repository.",
    })),
    startNewReviewChatThread: vi.fn(async () => ({
      status: "ready" as const,
      threadId: ThreadId.makeUnsafe("thread-review-chat-fresh"),
      created: true,
    })),
  };
});

const prewarmReviewChatThreadMock = vi.mocked(prewarmReviewChatThread);
const sendReviewChatQuestionMock = vi.mocked(sendReviewChatQuestion);
const initialStoreState = useStore.getState();
type SendReviewChatResult = Awaited<ReturnType<typeof sendReviewChatQuestion>>;

const nativeApiMock = vi.hoisted(() => ({
  listSkills: vi.fn(async () => ({
    skills: [
      {
        name: "hallmark",
        description: "Check generated-code tells.",
        path: "/Users/tylersheffield/.agents/skills/hallmark/SKILL.md",
        enabled: true,
      },
    ],
    source: "mock",
    cached: false,
  })),
  loadPullRequestHeader: vi.fn(async () => ({
    detail: {
      number: 7866,
      title: "docs(test): dashboard vitest harness research",
      url: "https://github.com/enzo-health/bonaparte/pull/7866",
      state: "open" as const,
      isDraft: false,
      author: "Tbsheff",
      authorAvatarUrl: "https://avatars.example/tbsheff.png",
      baseBranch: "main",
      headBranch: "test-speed/06-harness-docs",
      body: "",
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-07T00:00:00.000Z",
      additions: 251,
      deletions: 0,
      changedFiles: 2,
      reviewDecision: "REVIEW_REQUIRED" as const,
      mergeable: "MERGEABLE" as const,
      milestone: null,
      labels: [],
      assignees: [],
      reviewers: [
        {
          login: "global-approver",
          avatarUrl: "https://avatars.example/global-approver.png",
          state: "REVIEW_REQUIRED" as const,
        },
        {
          login: "tech-lead",
          avatarUrl: "https://avatars.example/tech-lead.png",
          state: "APPROVED" as const,
        },
      ],
    },
  })),
  loadConversation: vi.fn(async () => ({ events: [] })),
  loadChangeset: vi.fn(async () => ({
    files: [],
    target: null,
    headSha: null,
    patch: "",
  })),
}));

vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({
    provider: {
      listSkills: nativeApiMock.listSkills,
    },
    review: {
      loadPullRequestHeader: nativeApiMock.loadPullRequestHeader,
      loadConversation: nativeApiMock.loadConversation,
      loadChangeset: nativeApiMock.loadChangeset,
    },
  }),
  readNativeApi: () => ({
    provider: {
      listSkills: nativeApiMock.listSkills,
    },
    review: {
      loadPullRequestHeader: nativeApiMock.loadPullRequestHeader,
      loadConversation: nativeApiMock.loadConversation,
      loadChangeset: nativeApiMock.loadChangeset,
    },
  }),
}));

const DETAIL = {
  number: 7866,
  title: "docs(test): dashboard vitest harness research",
  url: "https://github.com/enzo-health/bonaparte/pull/7866",
  state: "open",
  isDraft: false,
  author: "Tbsheff",
  authorAvatarUrl: "https://avatars.example/tbsheff.png",
  baseBranch: "main",
  headBranch: "test-speed/06-harness-docs",
  body: "",
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-07T00:00:00.000Z",
  additions: 251,
  deletions: 0,
  changedFiles: 2,
  commitsCount: 1,
  reviewDecision: "REVIEW_REQUIRED",
  mergeable: "MERGEABLE",
  checksStatus: "failing",
  milestone: null,
  labels: [],
  assignees: [],
  reviewers: [
    {
      login: "global-approver",
      avatarUrl: "https://avatars.example/global-approver.png",
      state: "REVIEW_REQUIRED",
    },
    {
      login: "tech-lead",
      avatarUrl: "https://avatars.example/tech-lead.png",
      state: "APPROVED",
    },
  ],
} satisfies ReviewPullRequestDetail;

const CHECKS = [
  { name: "lint", state: "success", workflow: "CI" },
  { name: "test", state: "failure", workflow: "CI" },
] satisfies ReadonlyArray<ReviewCheck>;

async function mountSidebar() {
  await page.viewport(1440, 900);
  const host = document.createElement("div");
  host.className = "flex h-[900px] justify-end bg-background";
  document.body.append(host);
  const sidechatContext = buildReviewSidechatContextPayload({
    cwd: "/repo",
    reference: "7866",
    detail: DETAIL,
    checks: CHECKS,
    events: [],
    files: [
      {
        path: "docs/design-docs/dashboard-vitest-harness-research.md",
        insertions: 245,
        deletions: 0,
      },
    ],
    source: { _tag: "pullRequest", reference: "7866" },
    target: { _tag: "pullRequest", repositoryId: "enzo-health/bonaparte", number: 7866 },
    headSha: "2162c93",
    currentView: "conversation",
    selectedFilePath: null,
  });
  const screen = await renderWithQueryClient(
    <ReviewPrSidebar
      detail={DETAIL}
      checks={CHECKS}
      events={[]}
      sidechatContext={sidechatContext}
    />,
    host,
  );
  return {
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

async function renderWithQueryClient(
  ui: ReactNode,
  host: HTMLElement,
  seedQueryClient?: (queryClient: QueryClient) => void,
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
  seedQueryClient?.(queryClient);
  const screen = await render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
    {
      container: host,
    },
  );
  return {
    unmount: async () => {
      await screen.unmount();
      queryClient.clear();
    },
  };
}

function activeInfoOption(): HTMLElement {
  const panel = document
    .querySelector<HTMLElement>('[aria-label="Pull request readiness"]')
    ?.closest<HTMLElement>("aside");
  expect(panel).toBeTruthy();
  return panel!;
}

function activeSidebar(): HTMLElement {
  const sidebar = page
    .getByRole("tablist", { name: "Pull request sidebar" })
    .element()
    .closest<HTMLElement>("aside");
  expect(sidebar).toBeTruthy();
  return sidebar!;
}

function exactTextElementWithin(root: HTMLElement, text: string): HTMLElement {
  const element = Array.from(root.querySelectorAll<HTMLElement>("*")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  expect(element).toBeTruthy();
  return element!;
}

describe("ReviewPrSidebar", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    useStore.setState(initialStoreState, true);
    prewarmReviewChatThreadMock.mockClear();
    sendReviewChatQuestionMock.mockClear();
    nativeApiMock.listSkills.mockClear();
  });

  it("shows checks and keeps PR chat on the PR-bound Synara thread path", async () => {
    const mounted = await mountSidebar();

    try {
      await expect.element(page.getByRole("tab", { name: "Chat" })).toBeInTheDocument();
      await expect.element(page.getByRole("tab", { name: "Info" })).toBeInTheDocument();
      await expect.element(page.getByTestId("composer-editor")).toBeInTheDocument();
      await page.getByRole("tab", { name: "Info" }).click();
      await vi.waitFor(() => {
        const infoOption = activeInfoOption();
        expect(infoOption.textContent).toContain("test");
        expect(infoOption.textContent).toContain("1 failing");
        expect(infoOption.textContent).toContain("CI is blocking this PR.");
        expect(infoOption.textContent).toContain("Reviewers");
        expect(infoOption.textContent).toContain("global-approver");
      });
      const infoOption = activeInfoOption();
      expect(infoOption.querySelectorAll('[aria-label^="Reviewers:"]').length).toBeGreaterThan(1);
      const failedCheckTop = exactTextElementWithin(infoOption, "test").getBoundingClientRect().top;
      const passedCheckTop = exactTextElementWithin(infoOption, "lint").getBoundingClientRect().top;
      expect(failedCheckTop).toBeLessThan(passedCheckTop);
      expect(infoOption.textContent).toContain("Activity");
      const ciTop = exactTextElementWithin(infoOption, "CI").getBoundingClientRect().top;
      const activityTop = exactTextElementWithin(infoOption, "Activity").getBoundingClientRect()
        .top;
      expect(ciTop).toBeLessThan(activityTop);

      await page.getByRole("tab", { name: "Chat" }).click();
      await expect
        .element(page.getByRole("button", { name: /GPT|Codex|5\.5/ }))
        .toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps typed questions in the Synara sidechat launcher", async () => {
    const mounted = await mountSidebar();

    try {
      const input = page.getByTestId("composer-editor");
      const sidebar = activeSidebar();
      expect(sidebar.scrollWidth).toBeLessThanOrEqual(sidebar.clientWidth);
      expect(input.element().getBoundingClientRect().bottom).toBeGreaterThan(
        sidebar.getBoundingClientRect().bottom - 96,
      );
      await input.fill("What changed?");
      await page.getByRole("button", { name: "Send PR chat question" }).click();

      expect(sendReviewChatQuestionMock).toHaveBeenCalledTimes(1);
      expect(sendReviewChatQuestionMock.mock.calls[0]?.[0].question).toBe("What changed?");
      expect(sendReviewChatQuestionMock.mock.calls[0]?.[0].modelSelection).toMatchObject({
        provider: "codex",
        model: "gpt-5.3-codex-spark",
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("resizes the AI chat sidebar with the separator keyboard controls", async () => {
    const mounted = await mountSidebar();

    try {
      const sidebar = activeSidebar();
      const initialWidth = sidebar.getBoundingClientRect().width;
      expect(initialWidth).toBeGreaterThanOrEqual(358);
      expect(initialWidth).toBeLessThanOrEqual(362);

      const resizeHandle = page.getByRole("separator", { name: "Resize AI chat sidebar" });
      const resizeElement = resizeHandle.element();
      resizeElement.focus();
      resizeElement.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft" }),
      );
      await vi.waitFor(() => {
        expect(sidebar.getBoundingClientRect().width).toBeGreaterThan(initialWidth);
      });
      const expandedWidth = sidebar.getBoundingClientRect().width;

      await vi.waitFor(() => {
        expect(Number(resizeElement.getAttribute("aria-valuemax"))).toBeGreaterThanOrEqual(700);
      });
      resizeElement.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "End" }));
      await vi.waitFor(() => {
        expect(sidebar.getBoundingClientRect().width).toBeGreaterThanOrEqual(700);
      });
      expect(sidebar?.getBoundingClientRect().width ?? 0).toBeLessThanOrEqual(720);

      resizeElement.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Home" }));
      await vi.waitFor(() => {
        expect(sidebar?.getBoundingClientRect().width ?? 0).toBeLessThan(expandedWidth);
      });
      const minimumWidth = sidebar?.getBoundingClientRect().width ?? 0;
      expect(minimumWidth).toBeLessThan(expandedWidth);
      expect(minimumWidth).toBeGreaterThanOrEqual(288);
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows the outgoing question before the hidden review thread round-trip finishes", async () => {
    const sendDeferred: { resolve?: (result: SendReviewChatResult) => void } = {};
    sendReviewChatQuestionMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          sendDeferred.resolve = resolve;
        }),
    );
    const mounted = await mountSidebar();

    try {
      await page.getByTestId("composer-editor").fill("What changed?");
      await page.getByRole("button", { name: "Send PR chat question" }).click();

      await expect.element(page.getByText("What changed?")).toBeVisible();
      await expect.element(page.getByText("Starting review agent...")).toBeVisible();
      sendDeferred.resolve?.({
        status: "sent",
        threadId: ThreadId.makeUnsafe("thread-review-chat-optimistic"),
        created: true,
        turnRequestedAt: new Date().toISOString(),
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the outgoing question visible when PR chat send is queued", async () => {
    sendReviewChatQuestionMock.mockResolvedValueOnce({
      status: "queued",
      threadId: ThreadId.makeUnsafe("thread-review-chat-queued"),
      created: true,
      queuedAt: new Date().toISOString(),
      reason: "session_warming",
    });
    const mounted = await mountSidebar();

    try {
      await page.getByTestId("composer-editor").fill("What changed?");
      await page.getByRole("button", { name: "Send PR chat question" }).click();

      await expect.element(page.getByText("What changed?")).toBeVisible();
      await expect.element(page.getByText("Starting review agent...")).toBeVisible();
      await expect.element(page.getByText("PR chat is unavailable")).not.toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows thinking after a queued PR chat turn is accepted before assistant text arrives", async () => {
    const sendInput: { current: Parameters<typeof sendReviewChatQuestion>[0] | null } = {
      current: null,
    };
    const queuedAt = new Date().toISOString();
    sendReviewChatQuestionMock.mockImplementationOnce(async (input) => {
      sendInput.current = input;
      return {
        status: "queued",
        threadId: ThreadId.makeUnsafe("thread-review-chat-queued-thinking"),
        created: true,
        queuedAt,
        reason: "session_warming",
      };
    });
    const mounted = await mountSidebar();

    try {
      await page.getByTestId("composer-editor").fill("What changed?");
      await page.getByRole("button", { name: "Send PR chat question" }).click();

      await expect.element(page.getByText("Starting review agent...")).toBeVisible();
      sendInput.current?.onQueuedTurnStarted?.(
        ThreadId.makeUnsafe("thread-review-chat-queued-thinking"),
        queuedAt,
      );
      await expect.element(page.getByText("Thinking...")).toBeVisible();
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows thinking once a queued PR chat turn is handed to the provider", async () => {
    const sendInput: { current: Parameters<typeof sendReviewChatQuestion>[0] | null } = {
      current: null,
    };
    const queuedAt = new Date().toISOString();
    sendReviewChatQuestionMock.mockImplementationOnce(async (input) => {
      sendInput.current = input;
      return {
        status: "queued",
        threadId: ThreadId.makeUnsafe("thread-review-chat-provider-starting"),
        created: true,
        queuedAt,
        reason: "session_warming",
      };
    });
    const mounted = await mountSidebar();

    try {
      await page.getByTestId("composer-editor").fill("Find the issue");
      await page.getByRole("button", { name: "Send PR chat question" }).click();

      await expect.element(page.getByText("Starting review agent...")).toBeVisible();
      sendInput.current?.onQueuedProviderStartRequested?.(
        ThreadId.makeUnsafe("thread-review-chat-provider-starting"),
        queuedAt,
      );
      await expect.element(page.getByText("Thinking...")).toBeVisible();
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders first model reasoning in review chat within the app-side first-output budget", async () => {
    const sendDeferred: { resolve?: (result: SendReviewChatResult) => void } = {};
    sendReviewChatQuestionMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          sendDeferred.resolve = resolve;
        }),
    );
    const mounted = await mountSidebarWithReviewThread({ liveActivity: false });

    try {
      await page.getByTestId("composer-editor").fill("What changed?");
      await page.getByRole("button", { name: "Send PR chat question" }).click();
      await expect.element(page.getByText("What changed?")).toBeVisible();

      const outputLandedAt = performance.now();
      useStore.setState((state) => ({
        ...state,
        threads: state.threads.map((thread) =>
          thread.id === ThreadId.makeUnsafe("thread-review-chat")
            ? {
                ...thread,
                activities: [
                  ...thread.activities,
                  {
                    id: EventId.makeUnsafe("activity-review-chat-first-reasoning"),
                    createdAt: new Date(Date.now() + 1_000).toISOString(),
                    kind: "reasoning.delta",
                    summary: "Thinking",
                    tone: "info",
                    turnId: null,
                    payload: {
                      streamKind: "reasoning_text",
                      detail: "checking changed files",
                    },
                  },
                ],
              }
            : thread,
        ),
      }));

      await expect.element(page.getByText("Thinking")).toBeVisible();
      expect(performance.now() - outputLandedAt).toBeLessThan(1_000);
      sendDeferred.resolve?.({
        status: "sent",
        threadId: ThreadId.makeUnsafe("thread-review-chat"),
        created: false,
        turnRequestedAt: new Date().toISOString(),
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("lets the reviewer choose the model used for PR chat sends", async () => {
    const mounted = await mountSidebar();

    try {
      await page.getByRole("button", { name: /GPT|Codex|5\.5/ }).click();
      await page.getByRole("menuitemradio", { name: /GPT-5\.4$/ }).click();
      await page.getByTestId("composer-editor").fill("Use GPT-5.4 for this?");
      await page.getByRole("button", { name: "Send PR chat question" }).click();

      expect(sendReviewChatQuestionMock).toHaveBeenCalledTimes(1);
      expect(sendReviewChatQuestionMock.mock.calls[0]?.[0].modelSelection).toMatchObject({
        provider: "codex",
        model: "gpt-5.4",
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("starts PR-bound review chat without requiring a host thread", async () => {
    const mounted = await mountSidebar();
    try {
      await page.getByRole("button", { name: "Find review risks" }).click();
      expect(sendReviewChatQuestionMock).toHaveBeenCalledTimes(1);
      expect(sendReviewChatQuestionMock.mock.calls[0]?.[0].question).toBe("Find review risks");
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps skill discovery off plain PR chat sends", async () => {
    const mounted = await mountSidebar();
    try {
      await expect.element(page.getByTestId("composer-editor")).toBeVisible();
      expect(nativeApiMock.listSkills).toHaveBeenCalledTimes(0);

      await page.getByRole("button", { name: "Find review risks" }).click();

      expect(nativeApiMock.listSkills).toHaveBeenCalledTimes(0);
      expect(sendReviewChatQuestionMock).toHaveBeenCalledTimes(1);
      expect(sendReviewChatQuestionMock.mock.calls[0]?.[0].skills).toEqual([]);
    } finally {
      await mounted.cleanup();
    }
  });

  it("discovers skills only after a PR chat draft mentions one", async () => {
    let resolveSkills = (_result: Awaited<ReturnType<typeof nativeApiMock.listSkills>>) => {};
    nativeApiMock.listSkills.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSkills = resolve;
        }),
    );
    const mounted = await mountSidebar();
    try {
      await page.getByTestId("composer-editor").fill("$hallmark Find review risks");
      await page.getByRole("button", { name: "Send PR chat question" }).click();

      expect(nativeApiMock.listSkills).toHaveBeenCalledTimes(1);
      expect(sendReviewChatQuestionMock).toHaveBeenCalledTimes(0);
      resolveSkills({
        skills: [
          {
            name: "hallmark",
            description: "Check generated-code tells.",
            path: "/Users/tylersheffield/.agents/skills/hallmark/SKILL.md",
            enabled: true,
          },
        ],
        source: "mock",
        cached: false,
      });

      await vi.waitFor(() => {
        expect(sendReviewChatQuestionMock).toHaveBeenCalledTimes(1);
      });
      expect(sendReviewChatQuestionMock).toHaveBeenCalledTimes(1);
      expect(sendReviewChatQuestionMock.mock.calls[0]?.[0].skills).toEqual([
        {
          name: "hallmark",
          path: "/Users/tylersheffield/.agents/skills/hallmark/SKILL.md",
        },
      ]);
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders existing review threads as compact sidebar chat instead of full ChatView", async () => {
    const mounted = await mountSidebarWithReviewThread({ liveActivity: false });
    try {
      await expect.element(page.getByRole("button", { name: /GPT|Codex|5\.5/ })).toBeVisible();
      await expect
        .element(page.getByText("Ask about changes, checks, risk, or what to read first."))
        .toBeVisible();
      await expect.element(page.getByRole("button", { name: "Find review risks" })).toBeVisible();
      expect(document.body.textContent ?? "").not.toContain("What should we do in");
      expect(document.body.textContent ?? "").not.toContain("Ask for follow-up changes");
    } finally {
      await mounted.cleanup();
    }
  });

  it("hides a late bootstrap ready reply after an interleaved visible question", async () => {
    const mounted = await mountSidebarWithReviewThread({ liveActivity: false });
    try {
      useStore.setState((state) => ({
        ...state,
        threads: state.threads.map((thread) =>
          thread.id === ThreadId.makeUnsafe("thread-review-chat")
            ? {
                ...thread,
                messages: [
                  {
                    id: MessageId.makeUnsafe("message-review-bootstrap"),
                    role: "user",
                    text: "Hidden bootstrap\n\nUser question:\nReply exactly: ready",
                    createdAt: "2026-06-07T12:00:00.500Z",
                    streaming: false,
                    turnId: null,
                    source: "review-context-bootstrap",
                  },
                  {
                    id: MessageId.makeUnsafe("message-review-visible-question"),
                    role: "user",
                    text: "What changed?",
                    createdAt: "2026-06-07T12:00:01.000Z",
                    streaming: false,
                    turnId: null,
                  },
                  {
                    id: MessageId.makeUnsafe("message-review-bootstrap-ready"),
                    role: "assistant",
                    text: "ready",
                    createdAt: "2026-06-07T12:00:01.200Z",
                    streaming: false,
                    turnId: TurnId.makeUnsafe("turn-review-bootstrap"),
                  },
                  {
                    id: MessageId.makeUnsafe("message-review-visible-answer"),
                    role: "assistant",
                    text: "The visible answer stays visible.",
                    createdAt: "2026-06-07T12:00:02.000Z",
                    streaming: false,
                    turnId: TurnId.makeUnsafe("turn-review-visible"),
                  },
                ],
              }
            : thread,
        ),
      }));

      await expect.element(page.getByText("What changed?")).toBeVisible();
      await expect.element(page.getByText("The visible answer stays visible.")).toBeVisible();
      expect(document.body.textContent ?? "").not.toContain("Reply exactly: ready");
      expect(document.body.textContent ?? "").not.toMatch(/\bready\b/i);
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows live provider activity in the review chat timeline before assistant text arrives", async () => {
    const mounted = await mountSidebarWithReviewThread({ liveActivity: true });
    try {
      await expect.element(page.getByText("Reading changed files")).toBeVisible();
      await expect.element(page.getByText("Reading PR context...")).toBeVisible();
      await expect
        .element(page.getByRole("button", { name: "Start new PR chat thread" }))
        .toBeEnabled();
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows reasoning tokens in the review chat timeline", async () => {
    const mounted = await mountSidebarWithReviewThread({ liveActivity: true });
    try {
      useStore.setState((state) => ({
        ...state,
        threads: state.threads.map((thread) =>
          thread.id === ThreadId.makeUnsafe("thread-review-chat")
            ? {
                ...thread,
                messages: [
                  {
                    id: MessageId.makeUnsafe("message-review-user-question"),
                    role: "user",
                    text: "summarize this pr",
                    createdAt: "2026-06-07T12:00:01.000Z",
                    streaming: false,
                    turnId: TurnId.makeUnsafe("turn-review-chat-running"),
                  },
                  {
                    id: MessageId.makeUnsafe("message-review-assistant-answer"),
                    role: "assistant",
                    text: "This PR updates the review surface.",
                    createdAt: "2026-06-07T12:00:02.000Z",
                    streaming: true,
                    turnId: TurnId.makeUnsafe("turn-review-chat-running"),
                  },
                ],
                activities: [
                  {
                    id: EventId.makeUnsafe("activity-review-chat-thinking"),
                    createdAt: "2026-06-07T12:00:01.500Z",
                    kind: "reasoning.delta",
                    summary: "Thinking",
                    tone: "info",
                    turnId: null,
                    payload: {
                      streamKind: "reasoning_text",
                      detail: "checking changed files",
                    },
                  },
                ],
              }
            : thread,
        ),
      }));

      await expect.element(page.getByText("Thinking")).toBeVisible();
      await expect.element(page.getByText("checking changed files")).toBeVisible();
      await expect.element(page.getByText("summarize this pr")).toBeVisible();
      await expect.element(page.getByText("This PR updates the review surface.")).toBeVisible();
      const userTop = page.getByText("summarize this pr").element().getBoundingClientRect().top;
      const thinkingTop = page.getByText("Thinking").element().getBoundingClientRect().top;
      const assistantTop = page
        .getByText("This PR updates the review surface.")
        .element()
        .getBoundingClientRect().top;
      expect(userTop).toBeLessThan(thinkingTop);
      expect(thinkingTop).toBeLessThan(assistantTop);
      const input = page.getByTestId("composer-editor");
      await input.fill("What is still risky?");
      await expect.element(input).toHaveTextContent("What is still risky?");
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps composer typing responsive while review activity streams", async () => {
    const mounted = await mountSidebarWithReviewThread({ liveActivity: true });
    try {
      const input = page.getByTestId("composer-editor");
      const startedAt = performance.now();
      for (let index = 0; index < 20; index += 1) {
        useStore.setState((state) => ({
          ...state,
          threads: state.threads.map((thread) =>
            thread.id === ThreadId.makeUnsafe("thread-review-chat")
              ? {
                  ...thread,
                  activities: [
                    ...thread.activities,
                    {
                      id: EventId.makeUnsafe(`activity-review-chat-progress-${index}`),
                      createdAt: `2026-06-07T12:00:${String(index + 2).padStart(2, "0")}.000Z`,
                      kind: "task.progress",
                      summary: `Streaming update ${index}`,
                      tone: "info",
                      turnId: TurnId.makeUnsafe("turn-review-chat-running"),
                      payload: { taskType: "review-chat" },
                    },
                  ],
                }
              : thread,
          ),
        }));
        await input.fill(`Question ${index}`);
      }
      const elapsedMs = performance.now() - startedAt;
      expect(elapsedMs).toBeLessThan(1_500);
      await expect.element(input).toHaveTextContent("Question 19");
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps production review-view chat responsive through normalized thread selectors", async () => {
    const mounted = await mountReviewViewWithNormalizedReviewThread();
    try {
      const input = page.getByTestId("composer-editor");
      await expect.element(page.getByText("Reading changed files")).toBeVisible();

      const threadId = ThreadId.makeUnsafe("thread-review-chat-normalized");
      const startedAt = performance.now();
      for (let index = 0; index < 20; index += 1) {
        const activityId = EventId.makeUnsafe(`activity-review-chat-normalized-${index}`);
        useStore.setState((state) => ({
          ...state,
          activityIdsByThreadId: {
            ...(state.activityIdsByThreadId ?? {}),
            [threadId]: [...(state.activityIdsByThreadId?.[threadId] ?? []), activityId],
          },
          activityByThreadId: {
            ...(state.activityByThreadId ?? {}),
            [threadId]: {
              ...(state.activityByThreadId?.[threadId] ?? {}),
              [activityId]: {
                id: activityId,
                createdAt: `2026-06-07T12:00:${String(index + 2).padStart(2, "0")}.000Z`,
                kind: "task.progress",
                summary: `Normalized streaming update ${index}`,
                tone: "info",
                turnId: TurnId.makeUnsafe("turn-review-chat-normalized"),
                payload: { taskType: "review-chat" },
              },
            },
          },
        }));
        await input.fill(`Production question ${index}`);
      }

      expect(performance.now() - startedAt).toBeLessThan(1_500);
      await expect.element(input).toHaveTextContent("Production question 19");
      expect(prewarmReviewChatThreadMock).toHaveBeenCalledTimes(0);
    } finally {
      await mounted.cleanup();
    }
  });

  it("collapses and expands as a controlled AI chat sidebar", async () => {
    const mounted = await mountCollapsibleSidebar();

    try {
      await expect.element(page.getByRole("tab", { name: "Info" })).toBeVisible();
      expect(activeInfoOption().textContent).toContain("test");
      await page.getByRole("tab", { name: "Chat" }).click();
      await expect.element(page.getByTestId("composer-editor")).toBeVisible();
      await page.getByRole("button", { name: "Collapse AI chat sidebar" }).click();
      await expect
        .element(page.getByRole("button", { name: "Expand AI chat sidebar" }))
        .toBeVisible();
      expect(document.body.textContent ?? "").not.toContain("PR context loaded");

      await page.getByRole("button", { name: "Expand AI chat sidebar" }).click();
      await page.getByRole("tab", { name: "Chat" }).click();
      await expect.element(page.getByTestId("composer-editor")).toBeVisible();
    } finally {
      await mounted.cleanup();
    }
  });
});

async function mountCollapsibleSidebar() {
  await page.viewport(1440, 900);
  const host = document.createElement("div");
  host.className = "flex h-[900px] justify-end bg-background";
  document.body.append(host);
  const sidechatContext = buildReviewSidechatContextPayload({
    cwd: "/repo",
    reference: "7866",
    detail: DETAIL,
    checks: CHECKS,
    events: [],
    files: [
      {
        path: "docs/design-docs/dashboard-vitest-harness-research.md",
        insertions: 245,
        deletions: 0,
      },
    ],
    source: { _tag: "pullRequest", reference: "7866" },
    target: { _tag: "pullRequest", repositoryId: "enzo-health/bonaparte", number: 7866 },
    headSha: "2162c93",
    currentView: "files",
    selectedFilePath: null,
  });

  function Harness() {
    const [collapsed, setCollapsed] = useState(false);
    return (
      <ReviewPrSidebar
        detail={DETAIL}
        checks={CHECKS}
        events={[]}
        mode="files"
        sidechatContext={sidechatContext}
        collapsed={collapsed}
        onCollapsedChange={setCollapsed}
      />
    );
  }

  const screen = await renderWithQueryClient(<Harness />, host);
  return {
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

async function mountSidebarWithReviewThread(input: { liveActivity: boolean }) {
  await page.viewport(1440, 900);
  const host = document.createElement("div");
  host.className = "flex h-[900px] justify-end bg-background";
  document.body.append(host);
  const sidechatContext = buildReviewSidechatContextPayload({
    cwd: "/repo",
    reference: "7866",
    detail: DETAIL,
    checks: CHECKS,
    events: [],
    files: [
      {
        path: "docs/design-docs/dashboard-vitest-harness-research.md",
        insertions: 245,
        deletions: 0,
      },
    ],
    source: { _tag: "pullRequest", reference: "7866" },
    target: { _tag: "pullRequest", repositoryId: "enzo-health/bonaparte", number: 7866 },
    headSha: "2162c93",
    currentView: "conversation",
    selectedFilePath: null,
  });
  const threadId = ThreadId.makeUnsafe("thread-review-chat");
  const turnId = TurnId.makeUnsafe("turn-review-chat-running");
  useStore.setState((state) => ({
    ...state,
    threads: [makeReviewChatThread({ threadId, turnId, liveActivity: input.liveActivity })],
  }));
  const screen = await renderWithQueryClient(
    <ReviewPrSidebar
      detail={DETAIL}
      checks={CHECKS}
      events={[]}
      sidechatContext={sidechatContext}
      reviewThreadId={threadId}
    />,
    host,
  );
  return {
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

async function mountReviewViewWithNormalizedReviewThread() {
  await page.viewport(1440, 900);
  const host = document.createElement("div");
  host.className = "flex h-[900px] bg-background";
  document.body.append(host);
  const projectId = ProjectId.makeUnsafe("project-review-chat-normalized");
  const threadId = ThreadId.makeUnsafe("thread-review-chat-normalized");
  const turnId = TurnId.makeUnsafe("turn-review-chat-normalized");
  const thread = makeReviewChatThread({ threadId, turnId, liveActivity: true });
  const normalizedThread = {
    ...thread,
    projectId,
    reviewChatTarget: {
      projectId,
      cwd: "/repo",
      repositoryId: "enzo-health/bonaparte",
      reference: "7866",
      number: 7866,
      url: DETAIL.url,
    },
    latestTurn: {
      turnId,
      state: "running" as const,
      requestedAt: "2026-06-07T12:00:00.000Z",
      startedAt: "2026-06-07T12:00:01.000Z",
      completedAt: null,
      assistantMessageId: null,
    },
  };
  const initialActivity = normalizedThread.activities[0];
  useStore.setState((state) => ({
    ...state,
    projects: [makeProject({ id: projectId, cwd: "/repo" })],
    threads: [],
    threadIds: [threadId],
    threadShellById: {
      ...(state.threadShellById ?? {}),
      [threadId]: normalizedThread,
    },
    threadSessionById: {
      ...(state.threadSessionById ?? {}),
      [threadId]: normalizedThread.session,
    },
    threadTurnStateById: {
      ...(state.threadTurnStateById ?? {}),
      [threadId]: {
        latestTurn: normalizedThread.latestTurn,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
      },
    },
    messageIdsByThreadId: {
      ...(state.messageIdsByThreadId ?? {}),
      [threadId]: [],
    },
    messageByThreadId: {
      ...(state.messageByThreadId ?? {}),
      [threadId]: {},
    },
    activityIdsByThreadId: {
      ...(state.activityIdsByThreadId ?? {}),
      [threadId]: initialActivity ? [initialActivity.id] : [],
    },
    activityByThreadId: {
      ...(state.activityByThreadId ?? {}),
      [threadId]: initialActivity ? { [initialActivity.id]: initialActivity } : {},
    },
  }));
  const screen = await renderWithQueryClient(
    <ReviewPrView
      cwd="/repo"
      reference="7866"
      source={{ _tag: "pullRequest", reference: "7866" }}
    />,
    host,
    (queryClient) => {
      queryClient.setQueryData(reviewQueryKeys.pullRequestHeader("/repo", "7866"), {
        detail: DETAIL,
      });
      queryClient.setQueryData(reviewQueryKeys.conversation("/repo", "7866"), {
        events: [],
      });
      queryClient.setQueryData(reviewQueryKeys.changeset("/repo", "pullRequest:7866"), {
        files: [
          {
            path: "docs/design-docs/dashboard-vitest-harness-research.md",
            insertions: 245,
            deletions: 0,
          },
        ],
        target: {
          _tag: "pullRequest",
          repositoryId: "enzo-health/bonaparte",
          number: 7866,
        },
        headSha: "2162c93",
      });
    },
  );
  return {
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

function makeProject(input: { id: ProjectId; cwd: string }): Project {
  return {
    id: input.id,
    kind: "project",
    name: "Bonaparte",
    remoteName: "bonaparte",
    folderName: "bonaparte",
    localName: null,
    cwd: input.cwd,
    defaultModelSelection: null,
    expanded: true,
    scripts: [],
  };
}

function makeReviewChatThread(input: {
  threadId: ThreadId;
  turnId: TurnId;
  liveActivity: boolean;
}): Thread {
  const createdAt = "2026-06-07T12:00:00.000Z";
  return {
    id: input.threadId,
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-review-chat"),
    title: "Review #7866: docs(test): dashboard vitest harness research",
    modelSelection: {
      provider: "codex",
      model: "gpt-5.3-codex-spark",
      options: { reasoningEffort: "low" },
    },
    runtimeMode: "approval-required",
    interactionMode: "default",
    session: input.liveActivity
      ? {
          provider: "codex",
          status: "running",
          activeTurnId: input.turnId,
          createdAt,
          updatedAt: "2026-06-07T12:00:01.000Z",
          orchestrationStatus: "running",
        }
      : null,
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt,
    updatedAt: "2026-06-07T12:00:01.000Z",
    archivedAt: null,
    latestTurn: input.liveActivity
      ? {
          turnId: input.turnId,
          state: "running",
          requestedAt: createdAt,
          startedAt: "2026-06-07T12:00:01.000Z",
          completedAt: null,
          assistantMessageId: null,
        }
      : null,
    latestUserMessageAt: createdAt,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    envMode: "local",
    branch: "main",
    worktreePath: null,
    associatedWorktreePath: null,
    associatedWorktreeBranch: null,
    associatedWorktreeRef: null,
    createBranchFlowCompleted: false,
    parentThreadId: null,
    subagentAgentId: null,
    subagentNickname: null,
    subagentRole: null,
    forkSourceThreadId: null,
    sidechatSourceThreadId: null,
    handoff: null,
    lastKnownPr: {
      number: 7866,
      title: DETAIL.title,
      url: DETAIL.url,
      baseBranch: DETAIL.baseBranch,
      headBranch: DETAIL.headBranch,
      state: DETAIL.state,
    },
    reviewChatTarget: {
      projectId: ProjectId.makeUnsafe("project-review-chat"),
      cwd: "/repo",
      repositoryId: "enzo-health/bonaparte",
      reference: "7866",
      number: 7866,
      url: DETAIL.url,
    },
    runtime: null,
    turnDiffSummaries: [],
    providerItems: [],
    activities: input.liveActivity
      ? [
          {
            id: EventId.makeUnsafe("activity-review-chat-reading-files"),
            createdAt: "2026-06-07T12:00:01.100Z",
            kind: "task.progress",
            summary: "Reading changed files",
            tone: "info",
            turnId: input.turnId,
            payload: {
              taskType: "review-chat",
            },
          },
        ]
      : [],
  };
}
