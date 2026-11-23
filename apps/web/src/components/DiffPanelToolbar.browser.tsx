import "../index.css";

import { TurnId } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { gitQueryKeys } from "../lib/gitReactQuery";
import { DiffPanelToolbar } from "./DiffPanelToolbar";

const noop = () => {};

it.each([false, true])(
  "exposes the diff source and actions in the toolbar (turn: %s)",
  async (turn) => {
    await page.viewport(1280, 800);
    const onReload = vi.fn();
    const onClose = vi.fn();
    const client = new QueryClient();
    client.setQueryData(gitQueryKeys.branches("/fixture"), {
      isRepo: true,
      hasOriginRemote: true,
      branches: [
        {
          name: "feature/work",
          current: true,
          isDefault: false,
          isRemote: false,
          worktreePath: null,
        },
      ],
    });
    client.setQueryData(gitQueryKeys.status("/fixture"), {
      branch: "feature/work",
      hasWorkingTreeChanges: true,
      workingTree: { files: [], insertions: 1234, deletions: 567 },
      hasUpstream: true,
      upstreamBranch: "origin/feature/work",
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    });
    const mounted = await render(
      <QueryClientProvider client={client}>
        <div data-testid="toolbar" style={{ width: 404, height: 40 }}>
          <DiffPanelToolbar
            activeCwd="/fixture"
            activeThreadId={null}
            viewSource={
              turn
                ? { kind: "turn", turnId: TurnId.makeUnsafe("long-turn") }
                : { kind: "repo", scope: "workingTree" }
            }
            turnScopeIntent="all"
            scopeFileCounts={{ workingTree: 12 }}
            activeStats={{ additions: 1234, deletions: 567 }}
            orderedTurnDiffSummaries={[]}
            inferredCheckpointTurnCountByTurnId={{ "long-turn": 123456 }}
            selectedTurnId={turn ? TurnId.makeUnsafe("long-turn") : null}
            timestampFormat="locale"
            renderableFiles={[]}
            selectedFilePath={null}
            fileTreeOpen
            resolvedTheme="light"
            diffRenderMode="split"
            diffWordWrap={false}
            diffIgnoreWhitespace={false}
            diffCopyText={null}
            diffCopyLabel="Copy diff"
            reloading={false}
            allFilesCollapsed={false}
            changeMarkersEnabled={false}
            compareRef={null}
            changeNavigation={{
              canGoToPrevious: false,
              canGoToNext: true,
              previousShortcutLabel: null,
              nextShortcutLabel: null,
              onGoToPrevious: noop,
              onGoToNext: noop,
            }}
            onChangeMarkersEnabledChange={noop}
            onSelectRepoScope={noop}
            onSelectCompareRef={noop}
            onSelectAllTurns={noop}
            onSelectLastTurn={noop}
            onSelectTurn={noop}
            onSelectFile={noop}
            onToggleFileTree={noop}
            onDiffRenderModeChange={noop}
            onDiffWordWrapChange={noop}
            onDiffIgnoreWhitespaceChange={noop}
            onCopyDiff={noop}
            onReload={onReload}
            onToggleCollapseAll={noop}
            onClosePanel={onClose}
          />
        </div>
      </QueryClientProvider>,
    );
    await expect
      .element(page.getByRole("button", { name: "Choose diff source" }))
      .toHaveAccessibleDescription(
        turn ? "Turn diff, +1234 -567" : "Working tree, 12 files, +1234 -567",
      );
    await expect.element(page.getByRole("button", { name: "Previous change" })).toBeDisabled();
    await page.getByRole("button", { name: "Reload diff" }).click();
    expect(onReload).toHaveBeenCalledOnce();
    await page.getByRole("button", { name: "Close file view" }).click();
    expect(onClose).toHaveBeenCalledOnce();
    await mounted.unmount();
  },
);
