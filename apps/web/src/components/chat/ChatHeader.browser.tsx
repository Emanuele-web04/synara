import "../../index.css";
import { EventId, ThreadId, type OrchestrationThreadActivity } from "@synara/contracts";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";
import { deriveContinuousHandoffPath } from "~/lib/continuousHandoffPath";
import { ChatHeader } from "./ChatHeader";

vi.mock("../ProviderUsageMenuControl", () => ({ ProviderUsageMenuControl: () => null }));
vi.mock("~/hooks/useOpenFavoriteEditorShortcut", () => ({
  useOpenFavoriteEditorShortcut: () => {},
}));

const targets = [
  { provider: "claudeAgent", instanceId: "claudeAgent", label: "Claude" },
  { provider: "grok", instanceId: "grok", label: "Grok" },
] as const;

function header(overrides: Partial<Parameters<typeof ChatHeader>[0]> = {}, width = 900) {
  const onCreateHandoff = vi.fn();
  const onContinueHandoff = vi.fn();
  return {
    onCreateHandoff,
    onContinueHandoff,
    element: (
      <div style={{ width }}>
        <ChatHeader
          activeThreadId={ThreadId.makeUnsafe("source")}
          activeThreadTitle="Review task"
          activeThreadEntryPoint="chat"
          activeProvider="codex"
          activeProjectName={undefined}
          threadBreadcrumbs={[]}
          hideSidebarControls
          isGitRepo={false}
          openInTarget={null}
          activeProjectScripts={undefined}
          preferredScriptId={null}
          keybindings={[]}
          availableEditors={[]}
          diffToggleShortcutLabel={null}
          handoffActionLabel="Hand off thread"
          handoffDisabled={false}
          handoffActionTargets={targets}
          continueHandoffActionTargets={targets}
          gitCwd={null}
          diffTotals={{ additions: 0, deletions: 0, fileCount: 0, hasChanges: false }}
          showGitActions={false}
          showDiffToggle={false}
          diffOpen={false}
          onRunProjectScript={vi.fn()}
          onAddProjectScript={vi.fn()}
          onUpdateProjectScript={vi.fn()}
          onDeleteProjectScript={vi.fn()}
          onToggleDiff={vi.fn()}
          onCreateHandoff={onCreateHandoff}
          onContinueHandoff={onContinueHandoff}
          onNavigateToThread={vi.fn()}
          onRenameThread={vi.fn()}
          {...overrides}
        />
      </div>
    ),
  };
}

afterEach(async () => {
  await cleanup();
  document.body.innerHTML = "";
});

describe("ChatHeader explicit handoff destinations", () => {
  it.each([undefined, false])(
    "keeps legacy new-conversation targets when opt-in is %s",
    async (enabled) => {
      const h = header(enabled === undefined ? {} : { enableSameThreadHandoffs: enabled });
      await render(h.element);
      await page.getByRole("button", { name: "Hand off thread" }).click();
      await expect
        .element(page.getByRole("menuitem", { name: "Claude", exact: true }))
        .toBeVisible();
      expect(document.body.textContent).not.toContain("Continue here");
      expect(document.querySelector('[data-handoff-destination="this-thread"]')).toBeNull();
      if (enabled === undefined) {
        await page.screenshot({
          path: "../../../../../output/playwright/handoff-1136-default-menu.png",
        });
      }
      await page.getByRole("menuitem", { name: "Claude", exact: true }).click();
      expect(h.onCreateHandoff).toHaveBeenCalledExactlyOnceWith(targets[0]);
      expect(h.onContinueHandoff).not.toHaveBeenCalled();
    },
  );

  it("offers two compact destination submenus and continues here only after explicit selection", async () => {
    const h = header({ enableSameThreadHandoffs: true });
    await render(h.element);
    await page.getByRole("button", { name: "Hand off thread" }).click();
    await expect
      .element(page.getByRole("menuitem", { name: "Continue here", exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByRole("menuitem", { name: "New conversation", exact: true }))
      .toBeVisible();
    expect(h.onContinueHandoff).not.toHaveBeenCalled();
    await page.screenshot({ path: "../../../../../output/playwright/handoff-1136-optin-menu.png" });
    await page.getByRole("menuitem", { name: "Continue here", exact: true }).click();
    await page.getByRole("menuitem", { name: "Claude", exact: true }).click();
    expect(h.onContinueHandoff).toHaveBeenCalledExactlyOnceWith(targets[0]);
    expect(h.onCreateHandoff).not.toHaveBeenCalled();
  });

  it("retains New conversation in the opted-in menu", async () => {
    const h = header({ enableSameThreadHandoffs: true });
    await render(h.element);
    await page.getByRole("button", { name: "Hand off thread" }).click();
    await page.getByRole("menuitem", { name: "New conversation", exact: true }).click();
    await page.getByRole("menuitem", { name: "Grok", exact: true }).click();
    expect(h.onCreateHandoff).toHaveBeenCalledExactlyOnceWith(targets[1]);
    expect(h.onContinueHandoff).not.toHaveBeenCalled();
  });

  it("uses plain outcome rows for one target instead of one-entry submenus", async () => {
    const h = header({
      enableSameThreadHandoffs: true,
      handoffActionTargets: [targets[0]],
      continueHandoffActionTargets: [targets[0]],
    });
    await render(h.element);
    await page.getByRole("button", { name: "Hand off thread" }).click();
    const continueItem = page.getByRole("menuitem", { name: "Continue here with Claude" });
    await expect.element(continueItem).toBeVisible();
    expect(continueItem.element().hasAttribute("aria-haspopup")).toBe(false);
    await expect
      .element(page.getByRole("menuitem", { name: "New conversation with Claude" }))
      .toBeVisible();
  });

  it("keeps busy handoffs disabled", async () => {
    await render(header({ enableSameThreadHandoffs: true, handoffDisabled: true }).element);
    await expect.element(page.getByRole("button", { name: "Hand off thread" })).toBeDisabled();
  });
});

describe("ChatHeader durable provider path", () => {
  it("compresses overflow, keeps return/current markers, and discloses the full route on focus and click", async () => {
    const providers = ["claudeAgent", "grok", "codex", "cursor", "claudeAgent", "grok"] as const;
    const activities: OrchestrationThreadActivity[] = providers.slice(1).map((provider, index) => ({
      id: EventId.makeUnsafe(`handoff-${index}`),
      kind: "provider.handoff",
      tone: "info",
      summary: "Handoff",
      payload: { sourceProvider: providers[index]!, targetProvider: provider },
      turnId: null,
      sequence: index + 1,
      createdAt: "2026-10-03T10:00:00.000Z",
    }));
    // History is meaningful even with the explicit-action preference off.
    await render(
      header(
        { activeProvider: "grok", providerHandoffPath: deriveContinuousHandoffPath(activities) },
        380,
      ).element,
    );
    const trigger = page.getByRole("button", { name: /Provider path:/ });
    await expect.element(trigger).toBeVisible();
    await vi.waitFor(() =>
      expect(document.querySelector('[data-handoff-path-overflow="4"]')).not.toBeNull(),
    );
    expect(trigger.element().querySelectorAll("[data-handoff-path-provider]")).toHaveLength(2);
    expect(
      trigger.element().querySelector('[data-handoff-path-transition="return"]')?.textContent,
    ).toBe("↩");
    expect(
      trigger
        .element()
        .querySelector('[data-handoff-path-current="true"]')
        ?.getAttribute("data-handoff-path-provider"),
    ).toBe("grok");
    expect(trigger.element().getAttribute("aria-label")).toContain("return to Claude");
    await userEvent.tab();
    await vi.waitFor(() =>
      expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toContain(
        "Claude → Grok → Codex → Cursor ↩ Claude ↩ Grok",
      ),
    );
    await trigger.click();
    const history = page.getByRole("list", { name: "Full provider history" });
    await expect.element(history).toBeVisible();
    expect(history.element().children).toHaveLength(6);
    expect(history.element().textContent).toContain("Current");
    expect(history.element().textContent?.match(/\(return\)/g)).toHaveLength(2);
    await page.screenshot({
      path: "../../../../../output/playwright/handoff-1136-path-disclosure.png",
    });
    await userEvent.keyboard("{Escape}");
    await expect.element(history).not.toBeInTheDocument();
    await expect.element(trigger).toHaveFocus();
  });

  it("adds no path chrome to threads without completed transitions", async () => {
    await render(header().element);
    expect(document.querySelector("[data-handoff-path]")).toBeNull();
  });
});
