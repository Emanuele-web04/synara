import "../../../index.css";

import {
  DEFAULT_SERVER_SETTINGS,
  type ReviewSourceRef,
  type ReviewWalkthrough as ReviewWalkthroughData,
} from "@t3tools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ReviewWalkthrough } from "./ReviewWalkthrough";

const WALKTHROUGH = {
  prologue: {
    motivation: "Reviewing big pull requests meant reading files in a confusing order.",
    outcome: "Reviewers now get a guided, chapter-by-chapter tour of the change.",
    keyChanges: [
      {
        summary: "Walkthroughs are a durable artifact",
        description: "Cached and keyed on the patch.",
      },
    ],
    focusAreas: [
      {
        type: "architecture" as const,
        severity: "medium" as const,
        title: "Guided versus Files ownership",
        description: "Confirm which surface owns the diff.",
        locations: ["apps/web/src/components/review/ReviewPrView.tsx"],
      },
    ],
    complexity: { level: "high" as const, reasoning: "New surface threaded across layers." },
  },
  chapters: [
    {
      id: "chapter-1",
      title: "Define the walkthrough contract",
      summary: "Schema and query keys establish a durable artifact.",
      intent: "Make the walkthrough cacheable and safe to rerun.",
      anchor: "contracts + query key",
      risk: "major" as const,
      hunkRefs: [],
      files: [],
      status: "queued" as const,
    },
  ],
} satisfies ReviewWalkthroughData;

const nativeApiMock = vi.hoisted(() => ({
  generateWalkthrough: vi.fn(async () => ({
    walkthrough: WALKTHROUGH,
    reviewedHeadSha: "abc123",
    patchSignature: "sig123",
  })),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

function createNativeApiMock() {
  return {
    review: { generateWalkthrough: nativeApiMock.generateWalkthrough },
    server: {
      getSettings: nativeApiMock.getSettings,
      updateSettings: nativeApiMock.updateSettings,
    },
  };
}

vi.mock("~/nativeApi", () => ({
  ensureNativeApi: createNativeApiMock,
  readNativeApi: createNativeApiMock,
}));

const CWD = "/repo";
const REFERENCE = "42";
const SOURCE = { _tag: "pullRequest", reference: REFERENCE } satisfies ReviewSourceRef;

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

async function renderWalkthrough(input?: {
  patch?: string | undefined;
  patchSignature?: string | null;
  expectedHeadSha?: string | null;
  title?: string;
  body?: string | null;
}): Promise<{ cleanup: () => Promise<void> }> {
  const queryClient = createQueryClient();
  const host = document.createElement("div");
  host.className = "flex h-[900px] bg-background text-foreground";
  document.body.append(host);

  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <ReviewWalkthrough
        cwd={CWD}
        reference={REFERENCE}
        source={SOURCE}
        target={null}
        patch={input?.patch ?? ""}
        files={[]}
        patchSignature={input && "patchSignature" in input ? input.patchSignature : "sig123"}
        expectedHeadSha={input && "expectedHeadSha" in input ? input.expectedHeadSha : "abc123"}
        changesetError={null}
        changesetLoading={false}
        title={input?.title ?? "Add PR walkthroughs to the review interface"}
        body={input?.body ?? "Prototype a guided review path."}
      />
    </QueryClientProvider>,
    { container: host },
  );

  return {
    cleanup: async () => {
      await screen.unmount();
      queryClient.clear();
      host.remove();
    },
  };
}

describe("ReviewWalkthrough", () => {
  beforeEach(() => {
    window.localStorage.clear();
    nativeApiMock.getSettings.mockResolvedValue(DEFAULT_SERVER_SETTINGS);
    nativeApiMock.updateSettings.mockResolvedValue(DEFAULT_SERVER_SETTINGS);
  });

  afterEach(() => {
    nativeApiMock.generateWalkthrough.mockClear();
    nativeApiMock.getSettings.mockReset();
    nativeApiMock.updateSettings.mockReset();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
    window.localStorage.clear();
  });

  it("generates once and renders the prologue and chapters from real data", async () => {
    await page.viewport(1440, 900);
    const mounted = await renderWalkthrough();

    try {
      await expect.element(page.getByText("Define the walkthrough contract")).toBeVisible();
      await expect.element(page.getByText(/guided, chapter-by-chapter tour/)).toBeVisible();

      expect(nativeApiMock.generateWalkthrough).toHaveBeenCalledTimes(1);
      expect(nativeApiMock.generateWalkthrough).toHaveBeenCalledWith({
        cwd: CWD,
        source: SOURCE,
        expectedPatchSignature: "sig123",
        expectedHeadSha: "abc123",
        modelSelection: {
          provider: "codex",
          model: "gpt-5.4-mini",
        },
        textGenerationModel: "gpt-5.4-mini",
      });

      await page.getByText("Define the walkthrough contract").click();
      await expect.element(page.getByText("contracts + query key")).toBeVisible();
    } finally {
      await mounted.cleanup();
    }
  });

  it("persists the walkthrough diff style after switching from split to unified", async () => {
    await page.viewport(1440, 900);
    const firstMount = await renderWalkthrough();

    try {
      const toggle = page.getByRole("button", { name: "Toggle split diff view" });
      await expect.element(page.getByText("Split")).toBeVisible();
      await toggle.click();
      await expect.element(page.getByText("Unified")).toBeVisible();
    } finally {
      await firstMount.cleanup();
    }

    nativeApiMock.generateWalkthrough.mockClear();
    const secondMount = await renderWalkthrough();

    try {
      await expect.element(page.getByText("Unified")).toBeVisible();
      expect(
        page.getByRole("button", { name: "Toggle split diff view" }).element(),
      ).toHaveAttribute("aria-pressed", "false");
    } finally {
      await secondMount.cleanup();
    }
  });

  it("does not call the server until a patch signature is known", async () => {
    await page.viewport(1440, 900);
    const mounted = await renderWalkthrough({
      patch: undefined,
      patchSignature: null,
      expectedHeadSha: null,
      title: "Add PR walkthroughs",
      body: null,
    });

    try {
      await expect.element(page.getByText(/Generating walkthrough|No chapters/)).toBeVisible();
      expect(nativeApiMock.generateWalkthrough).toHaveBeenCalledTimes(0);
    } finally {
      await mounted.cleanup();
    }
  });
});
