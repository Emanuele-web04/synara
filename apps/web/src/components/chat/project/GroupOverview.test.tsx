// FILE: GroupOverview.test.tsx
// Purpose: Static-markup coverage for the Group panel Overview — row titles must
//          size off the same `text-ui` token sidebar thread rows use, not the
//          panel's ambient font size.
// Layer: Chat UI component test
// Depends on: GroupOverview with a stubbed project agent.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProjectId, ThreadId } from "@synara/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { SidebarThreadSummary } from "../../../types";

import { GroupOverview } from "./GroupOverview";
import type { useProjectAgent } from "./useProjectAgent";

type ProjectAgent = ReturnType<typeof useProjectAgent>;

const GROUP_ID = ProjectId.makeUnsafe("group-1");

function makeThread(overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    projectId: GROUP_ID,
    title: "Mars recruitment web",
    modelSelection: { provider: "codex", model: "gpt-5.4" },
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    session: null,
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    latestTurn: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    hasLiveTailWork: false,
    ...overrides,
  };
}

const agent = { tasks: [], threads: [] } as unknown as ProjectAgent;

function renderOverview(threads: readonly SidebarThreadSummary[]): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <GroupOverview
        groupProjectId={GROUP_ID}
        groupName="Mars"
        memberThreadIds={new Set(threads.map((thread) => thread.id))}
        groupThreads={threads}
        projectNameById={new Map()}
        projectCwdById={new Map()}
        agent={agent}
        onOpenThread={() => undefined}
        onOpenThreadSplit={() => undefined}
        onOpenAutomation={() => undefined}
      />
    </QueryClientProvider>,
  );
}

describe("GroupOverview", () => {
  it("sizes thread row titles with the same text-ui token sidebar rows use", () => {
    const markup = renderOverview([makeThread()]);

    // SidebarThreadRowContent titles carry `text-ui`; panel rows must match so
    // titles track the Settings font size instead of the ambient default.
    expect(markup).toContain('class="min-w-0 truncate text-ui font-medium text-foreground"');
    expect(markup).toContain("Mars recruitment web");
  });
});
