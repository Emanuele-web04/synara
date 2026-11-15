import "../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import ChatMarkdown from "./ChatMarkdown";

const COST_TABLE = [
  "| | Peak memory | CPU | Time |",
  "|---|---|---|---|",
  "| Claude prediction process | 290 MB | 0.7 s | 3.1–4.9 s |",
  "| Codex prediction process | 410–420 MB | 2.9–3.3 s | 5.0–6.1 s |",
  "| Reading the transcript for the prediction (largest seeded thread, 1,400 messages) | – | 2–3 ms | – |",
  "| For comparison: reading a thread when you open it | – | 18–45 ms | – |",
].join("\n");

const PR_TABLE = [
  "| PR | What it changes | Status |",
  "|---|---|---|",
  "| PR #2156 | Desktop performance: delay the prediction process until the chat has been open for 1 s, and reuse the answer across windows | Merged |",
  "| PR #2114 | Child threads in the sidebar | Review requested |",
].join("\n");

const WIDE_TABLE = [
  "| Scenario | Before p50 | Before p95 | After p50 | After p95 | Change | Peak memory | Notes |",
  "|---|---|---|---|---|---|---|---|",
  "| Browse 10 chats in a row | 1.9 s | 3.4 s | 0.4 s | 0.9 s | −74% | 280 MB | No prediction process started |",
  "| Open a thread (1,400 messages) | 42 ms | 88 ms | 18 ms | 45 ms | −49% | 312 MB | Transcript read once, then cached |",
].join("\n");

const NUMBERS_ONLY_TABLE = [
  `| Run | ${Array.from({ length: 11 }, (_, index) => `Sample ${index + 1}`).join(" | ")} |`,
  `|---|${"---|".repeat(11)}`,
  `| Cold | ${Array.from({ length: 11 }, (_, index) => `${1200 + index} ms`).join(" | ")} |`,
].join("\n");

function lineCount(element: Element): number {
  const range = document.createRange();
  range.selectNodeContents(element);
  return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
}

async function renderTables(text: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const mounted = await render(
    <QueryClientProvider client={queryClient}>
      <div style={{ width: 728, padding: 0 }} data-testid="chat-column">
        <ChatMarkdown cwd="/workspace" text={text} isStreaming={false} />
      </div>
    </QueryClientProvider>,
  );
  return {
    mounted,
    cleanup: async () => {
      await mounted.unmount();
      queryClient.clear();
    },
  };
}

it("keeps numbers, units and IDs on one line while the text column wraps", async () => {
  await page.viewport(900, 1000);
  const { cleanup } = await renderTables(`${COST_TABLE}\n\n${PR_TABLE}`);
  try {
    const cells = [
      ...document.querySelectorAll<HTMLTableCellElement>(
        'td[data-table-column="numeric"], td[data-table-column="short"]',
      ),
    ];
    expect(cells.map((cell) => cell.textContent)).toContain("3.1–4.9 s");
    expect(cells.map((cell) => cell.textContent)).toContain("PR #2156");
    for (const cell of cells) expect(lineCount(cell), cell.textContent ?? "").toBe(1);

    const longText = [...document.querySelectorAll('td[data-table-column="text"]')].find((cell) =>
      cell.textContent?.startsWith("Reading the transcript"),
    )!;
    expect(lineCount(longText)).toBeGreaterThan(1);

    for (const scroller of document.querySelectorAll(".chat-markdown-table__scroll")) {
      expect(scroller.scrollWidth).toBeLessThanOrEqual(scroller.clientWidth);
    }
  } finally {
    await cleanup();
  }
});

it("narrows the text columns first when many number columns compete for the width", async () => {
  await page.viewport(900, 600);
  const { cleanup } = await renderTables(WIDE_TABLE);
  try {
    const scroller = document.querySelector(".chat-markdown-table__scroll")!;
    expect(scroller.scrollWidth).toBeLessThanOrEqual(scroller.clientWidth);
    for (const cell of document.querySelectorAll('td[data-table-column="numeric"]')) {
      expect(lineCount(cell), cell.textContent ?? "").toBe(1);
    }
  } finally {
    await cleanup();
  }
});

it("scrolls a table sideways instead of squeezing it when the short columns cannot fit", async () => {
  await page.viewport(900, 600);
  const { cleanup } = await renderTables(NUMBERS_ONLY_TABLE);
  try {
    const scroller = document.querySelector(".chat-markdown-table__scroll")!;
    expect(scroller.scrollWidth).toBeGreaterThan(scroller.clientWidth);
    expect(
      document.querySelector('[data-testid="chat-column"]')!.getBoundingClientRect().width,
    ).toBe(728);
    for (const cell of document.querySelectorAll('td[data-table-column="numeric"]')) {
      expect(lineCount(cell)).toBe(1);
    }
  } finally {
    await cleanup();
  }
});

it("copies the table's own Markdown", async () => {
  await page.viewport(900, 600);
  const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
  const { mounted, cleanup } = await renderTables(`Intro line.\n\n${PR_TABLE}\n\nAfter.`);
  try {
    await mounted.getByRole("button", { name: "Copy table" }).click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(PR_TABLE));
  } finally {
    writeText.mockRestore();
    await cleanup();
  }
});
