import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ComposerWorkspaceStatus } from "./ComposerWorkspaceStatus";

describe("ComposerWorkspaceStatus", () => {
  it("identifies a local checkout and its current branch", () => {
    const markup = renderToStaticMarkup(
      <ComposerWorkspaceStatus envMode="local" worktreePath={null} branch="feature/local-chat" />,
    );

    expect(markup).toContain('title="Local checkout · feature/local-chat"');
    expect(markup).toContain(">Local</span>");
    expect(markup).toContain(">feature/local-chat</span>");
  });

  it("identifies a worktree and its current branch", () => {
    const markup = renderToStaticMarkup(
      <ComposerWorkspaceStatus
        envMode="worktree"
        worktreePath="/repo/.worktrees/feature-chat"
        branch="feature/worktree-chat"
      />,
    );

    expect(markup).toContain('title="Worktree · feature/worktree-chat"');
    expect(markup).toContain(">Worktree</span>");
    expect(markup).toContain(">feature/worktree-chat</span>");
  });

  it("identifies a pending worktree branch as its selected base", () => {
    const markup = renderToStaticMarkup(
      <ComposerWorkspaceStatus envMode="worktree" worktreePath={null} branch="feature/base" />,
    );

    expect(markup).toContain('aria-label="Worktree pending · Base: feature/base"');
    expect(markup).toContain(">Worktree pending</span>");
    expect(markup).toContain(">Base: feature/base</span>");
  });

  it("identifies a pending worktree without inventing a base branch", () => {
    const markup = renderToStaticMarkup(
      <ComposerWorkspaceStatus envMode="worktree" worktreePath={null} branch={null} />,
    );

    expect(markup).toContain('aria-label="Worktree pending"');
    expect(markup).not.toContain("Base:");
  });

  it.each([
    { envMode: "local" as const, worktreePath: null, label: "Local checkout" },
    {
      envMode: "worktree" as const,
      worktreePath: "/repo/.worktrees/feature-chat",
      label: "Worktree",
    },
  ])("omits the branch for a detached $envMode checkout", ({ label, ...workspace }) => {
    const markup = renderToStaticMarkup(<ComposerWorkspaceStatus {...workspace} branch={null} />);

    expect(markup).toContain(`aria-label="${label}"`);
    expect(markup).not.toContain("·");
  });
});
