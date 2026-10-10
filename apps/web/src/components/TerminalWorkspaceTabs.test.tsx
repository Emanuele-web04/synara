import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import TerminalWorkspaceTabs from "./TerminalWorkspaceTabs";

describe("TerminalWorkspaceTabs", () => {
  it("keeps only the terminal and its close action in terminal-only mode", () => {
    const markup = renderToStaticMarkup(
      <TerminalWorkspaceTabs
        activeTab="terminal"
        isWorking={false}
        terminalHasRunningActivity={false}
        workspaceLayout="terminal-only"
        onSelectTab={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(markup).toContain("Terminal");
    expect(markup).toContain("Close terminal");
    expect(markup).not.toContain(">Chat<");
  });

  it("shows the chat switcher when the workspace still includes chat", () => {
    const markup = renderToStaticMarkup(
      <TerminalWorkspaceTabs
        activeTab="terminal"
        isWorking={false}
        terminalHasRunningActivity={false}
        workspaceLayout="both"
        onSelectTab={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(markup).toContain("Terminal");
    expect(markup).toContain("Chat");
  });
});
