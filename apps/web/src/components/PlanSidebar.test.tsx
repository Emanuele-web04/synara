import { OrchestrationProposedPlanId } from "@synara/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import PlanSidebar from "./PlanSidebar";

it("announces the initially collapsed plan before hydration", () => {
  const markup = renderToStaticMarkup(
    <PlanSidebar
      activeTaskList={null}
      activeProposedPlan={{
        id: OrchestrationProposedPlanId.makeUnsafe("sidebar-plan"),
        createdAt: "2026-10-05T10:00:00Z",
        updatedAt: "2026-10-05T10:00:00Z",
        turnId: null,
        planMarkdown: "# Shared panel headers\n\nPlan details.",
        implementedAt: null,
        implementationThreadId: null,
      }}
      markdownCwd={undefined}
      workspaceRoot={undefined}
      timestampFormat="locale"
      onClose={() => {}}
    />,
  );

  expect(markup).toContain('aria-expanded="false"');
});
