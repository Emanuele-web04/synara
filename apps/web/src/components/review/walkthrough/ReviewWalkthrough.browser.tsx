import "../../../index.css";

import type {
  ReviewSourceRef,
  ReviewWalkthrough as ReviewWalkthroughData,
} from "@t3tools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
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
}));

vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({ review: { generateWalkthrough: nativeApiMock.generateWalkthrough } }),
  readNativeApi: () => ({ review: { generateWalkthrough: nativeApiMock.generateWalkthrough } }),
}));

const CWD = "/repo";
const REFERENCE = "42";
const SOURCE = { _tag: "pullRequest", reference: REFERENCE } satisfies ReviewSourceRef;

describe("ReviewWalkthrough", () => {
  afterEach(() => {
    nativeApiMock.generateWalkthrough.mockClear();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("generates once and renders the prologue and chapters from real data", async () => {
    await page.viewport(1440, 900);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
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
          patch=""
          files={[]}
          patchSignature="sig123"
          expectedHeadSha="abc123"
          title="Add PR walkthroughs to the review interface"
          body="Prototype a guided review path."
        />
      </QueryClientProvider>,
      { container: host },
    );

    try {
      await expect.element(page.getByText("Define the walkthrough contract")).toBeVisible();
      await expect.element(page.getByText(/guided, chapter-by-chapter tour/)).toBeVisible();

      expect(nativeApiMock.generateWalkthrough).toHaveBeenCalledTimes(1);
      expect(nativeApiMock.generateWalkthrough).toHaveBeenCalledWith({
        cwd: CWD,
        source: SOURCE,
        expectedPatchSignature: "sig123",
        expectedHeadSha: "abc123",
      });

      await page.getByText("Define the walkthrough contract").click();
      await expect.element(page.getByText("contracts + query key")).toBeVisible();
    } finally {
      await screen.unmount();
      queryClient.clear();
      host.remove();
    }
  });

  it("does not call the server until a patch signature is known", async () => {
    await page.viewport(1440, 900);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const host = document.createElement("div");
    document.body.append(host);

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <ReviewWalkthrough
          cwd={CWD}
          reference={REFERENCE}
          source={SOURCE}
          target={null}
          patch={undefined}
          files={[]}
          patchSignature={null}
          expectedHeadSha={null}
          title="Add PR walkthroughs"
          body={null}
        />
      </QueryClientProvider>,
      { container: host },
    );

    try {
      await expect.element(page.getByText(/Generating walkthrough|No chapters/)).toBeVisible();
      expect(nativeApiMock.generateWalkthrough).toHaveBeenCalledTimes(0);
    } finally {
      await screen.unmount();
      queryClient.clear();
      host.remove();
    }
  });
});
