import "../../../index.css";

import { ThreadId, type ResourceSnapshot } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const mocks = vi.hoisted(() => ({
  killSession: vi.fn(async (input: { pid: number }) => ({ pid: input.pid, killed: true })),
}));
vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({ server: { killResourceSession: mocks.killSession } }),
}));
vi.mock("~/confirmDialogFallback", () => ({
  showConfirmDialogFallback: async () => true,
}));

import { serverQueryKeys } from "~/lib/serverReactQuery";
import { EnvironmentResourcesSection } from "./EnvironmentResourcesSection";

describe("resource terminal selection", () => {
  it("sends the selected thread identity when two terminals share a name", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const snapshot: ResourceSnapshot = {
      generatedAt: "2026-09-14T00:00:00.000Z",
      totalCpuPct: 0,
      totalRssBytes: 2048,
      sessionCount: 2,
      orphanCount: 0,
      unattributed: [],
      projects: [
        {
          id: "project",
          name: "Project",
          cpuPct: 0,
          rssBytes: 2048,
          sessionCount: 2,
          history: [],
          worktrees: [
            {
              path: "/repo/worktree",
              name: "Workspace",
              cpuPct: 0,
              rssBytes: 2048,
              sessionCount: 2,
              history: [],
              processes: ["a", "b"].map((thread, index) => ({
                pid: 110 + index,
                ppid: 1,
                command: "shell",
                args: "shell",
                cpuPct: 0,
                rssBytes: 1024,
                terminalId: "default",
                threadId: ThreadId.makeUnsafe(thread),
              })),
            },
          ],
        },
      ],
    };
    queryClient.setQueryData(serverQueryKeys.resourceSnapshot(), snapshot);
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <EnvironmentResourcesSection enabled={false} />
      </QueryClientProvider>,
    );
    await page.getByRole("button", { name: /Resources/ }).click();
    await page.getByRole("menuitem", { name: "Kill default", exact: true }).nth(1).click();
    await vi.waitFor(() =>
      expect(mocks.killSession).toHaveBeenCalledExactlyOnceWith({
        terminalId: "default",
        threadId: "b",
        pid: 111,
      }),
    );
    const project = page.getByRole("button", { name: /^Project/ });
    await project.click();
    await expect.element(project).toHaveAttribute("aria-expanded", "false");
    expect(
      document.querySelector('[aria-label="Kill default"]')?.closest("[inert]"),
    ).not.toBeNull();
    await screen.unmount();
    queryClient.clear();
  });
});
