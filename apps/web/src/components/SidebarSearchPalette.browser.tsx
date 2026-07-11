// Production breakpoints are part of this regression: import targets must stay
// readable when several provider accounts share a narrow command palette.
import "../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { ThreadImportTarget } from "../lib/threadImport";
import { SidebarSearchPalette } from "./SidebarSearchPalette";

const MANY_IMPORT_TARGETS = [
  { provider: "codex", instanceId: "codex", label: "Personal Codex" },
  { provider: "codex", instanceId: "codex_work", label: "Work Codex" },
  { provider: "codex", instanceId: "codex_client", label: "Client Codex" },
  { provider: "claudeAgent", instanceId: "claudeAgent", label: "Personal Claude" },
  { provider: "claudeAgent", instanceId: "claude_work", label: "Work Claude" },
  { provider: "cursor", instanceId: "cursor", label: "Default Cursor" },
  { provider: "droid", instanceId: "droid", label: "Default Droid" },
  { provider: "opencode", instanceId: "opencode_work", label: "Work OpenCode" },
] as const satisfies ReadonlyArray<ThreadImportTarget>;

describe("SidebarSearchPalette import targets", () => {
  it("keeps many account identities usable in a narrow viewport", async () => {
    await page.viewport(320, 700);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <SidebarSearchPalette
          open
          mode="import"
          onModeChange={vi.fn()}
          onOpenChange={vi.fn()}
          actions={[]}
          projects={[]}
          threads={[]}
          onCreateChat={vi.fn()}
          onCreateThread={vi.fn()}
          onAddProjectPath={async () => {}}
          homeDir={null}
          onOpenSettings={vi.fn()}
          onOpenFeedback={vi.fn()}
          onOpenUsageSettings={vi.fn()}
          onOpenProject={vi.fn()}
          onOpenThread={vi.fn()}
          importTargets={MANY_IMPORT_TARGETS}
          onImportThread={vi.fn()}
        />
      </QueryClientProvider>,
    );

    try {
      const targetGroup = page.getByRole("radiogroup", { name: "Provider account" });
      await expect.element(targetGroup).toBeInTheDocument();
      expect(page.getByRole("radio").length).toBe(MANY_IMPORT_TARGETS.length);

      const groupElement = targetGroup.element();
      const groupRect = groupElement.getBoundingClientRect();
      expect(groupElement.scrollWidth).toBeLessThanOrEqual(groupElement.clientWidth + 1);
      expect(groupElement.scrollHeight).toBeGreaterThan(groupElement.clientHeight);
      for (const option of groupElement.querySelectorAll<HTMLElement>("[role='radio']")) {
        const optionRect = option.getBoundingClientRect();
        expect(optionRect.left).toBeGreaterThanOrEqual(groupRect.left - 1);
        expect(optionRect.right).toBeLessThanOrEqual(groupRect.right + 1);
      }

      const workCodex = page.getByRole("radio", { name: /Work Codex.*Codex/ });
      const workOpenCode = page.getByRole("radio", { name: /Work OpenCode.*OpenCode/ });
      await workCodex.click();
      await expect.element(workCodex).toHaveAttribute("aria-checked", "true");
      await workOpenCode.click();
      await expect.element(workOpenCode).toHaveAttribute("aria-checked", "true");
      await expect.element(workCodex).toHaveAttribute("aria-checked", "false");
    } finally {
      await screen.unmount();
      queryClient.clear();
      await page.viewport(1280, 720);
    }
  });
});
