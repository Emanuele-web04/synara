import { describe, expect, it } from "vitest";
import {
  deriveFriendlyCommandTarget,
  deriveInlineCommandCall,
  deriveReadableCommandDisplay,
  deriveReadableToolTitle,
  deriveSynaraMcpToolTitle,
  extractWebFetchUrl,
  isSynaraBrowserToolCall,
  normalizeCompactToolLabel,
  resolveCommandVisualKind,
  sanitizeSynaraMcpToolPreview,
} from "./toolCallLabel";

describe("extractWebFetchUrl", () => {
  it("pulls the url out of a WebFetch argument summary", () => {
    expect(
      extractWebFetchUrl({
        toolName: "WebFetch",
        detail: 'WebFetch: {"url":"https://ui.shadcn.com/docs/components","prompt":"List EVER..."}',
      }),
    ).toBe("https://ui.shadcn.com/docs/components");
  });

  it("recognizes alternate fetch tool names and the uri field", () => {
    expect(
      extractWebFetchUrl({
        toolName: "web_fetch",
        detail: '{"uri":"https://example.com/path"}',
      }),
    ).toBe("https://example.com/path");
  });

  it("falls back to a bare URL token when there is no json field", () => {
    expect(extractWebFetchUrl({ toolName: "fetch", detail: "Fetching https://example.com." })).toBe(
      "https://example.com",
    );
  });

  it("ignores non-fetch tools", () => {
    expect(
      extractWebFetchUrl({ toolName: "Read", detail: '{"url":"https://example.com"}' }),
    ).toBeNull();
  });

  it("ignores non-http(s) and missing urls", () => {
    expect(
      extractWebFetchUrl({ toolName: "WebFetch", detail: '{"url":"ftp://example.com"}' }),
    ).toBeNull();
    expect(extractWebFetchUrl({ toolName: "WebFetch", detail: '{"prompt":"hi"}' })).toBeNull();
    expect(extractWebFetchUrl({ toolName: "WebFetch", detail: undefined })).toBeNull();
  });
});

describe("normalizeCompactToolLabel", () => {
  it("removes trailing completion wording", () => {
    expect(normalizeCompactToolLabel("Tool call completed")).toBe("Tool call");
    expect(normalizeCompactToolLabel("Ran command done")).toBe("Ran command");
    expect(normalizeCompactToolLabel("Ran command started")).toBe("Ran command");
  });

  it.each([
    ["  Tool\r\n\tCOMPLETED\n", "Tool"],
    ["completed", "completed"],
    [" completed ", ""],
    ["Toolcompleted", "Toolcompleted"],
    ["Tool completed later", "Tool completed later"],
    ["Tool\u00a0done\u2028", "Tool"],
  ])("preserves status-word boundaries in %j", (value, expected) => {
    expect(normalizeCompactToolLabel(value)).toBe(expected);
  });
});

describe("deriveSynaraMcpToolTitle", () => {
  it.each([["browser_run", "Run browser actions"]])(
    "keeps current and historical %s messages readable",
    (toolName, title) => {
      expect(deriveSynaraMcpToolTitle({ toolName, status: "completed" })).toBe(title);
      expect(isSynaraBrowserToolCall({ title })).toBe(true);
    },
  );

  it("uses stable action-first names for Synara browser tools", () => {
    for (const status of ["running", "completed", "failed"] as const) {
      expect(
        deriveSynaraMcpToolTitle({
          toolName: "mcp__synara__browser_open",
          status,
        }),
      ).toBe("Open browser tab");
    }

    expect(
      deriveSynaraMcpToolTitle({
        title: "Synara: Browser Snapshot",
        status: "completed",
      }),
    ).toBe("Snapshot browser page");
  });

  it("recognizes bare and already-humanized Synara tool names", () => {
    expect(deriveSynaraMcpToolTitle({ toolName: "synara_send_message", status: "running" })).toBe(
      "Synara is sending a message",
    );
    expect(
      deriveSynaraMcpToolTitle({ title: "Synara: Synara List Threads", status: "completed" }),
    ).toBe("Synara listed threads");
    expect(
      deriveSynaraMcpToolTitle({ toolName: "synara_create_thread", status: "cancelled" }),
    ).toBe("Synara stopped creating a thread");
  });

  it("ignores tools from other MCP servers", () => {
    expect(
      deriveSynaraMcpToolTitle({
        toolName: "mcp__codex_apps__github_fetch_pr",
        status: "running",
      }),
    ).toBeNull();
  });

  it("keeps future Synara actions branded without exposing raw identifiers", () => {
    expect(
      deriveSynaraMcpToolTitle({
        toolName: "mcp__synara__synara_delete_project",
        status: "running",
      }),
    ).toBe("Synara is handling delete project");
    expect(
      deriveSynaraMcpToolTitle({
        toolName: "Synara__synara_delete_project",
        status: "completed",
      }),
    ).toBe("Synara handled delete project");
    expect(
      deriveSynaraMcpToolTitle({
        toolName: "synara_is_handling_delete_project",
        status: "completed",
      }),
    ).toBe("Synara handled delete project");
  });

  it("does not reinterpret free text beginning with fallback status copy", () => {
    expect(
      deriveSynaraMcpToolTitle({
        title: "Synara is handling delete project after recovery",
        status: "completed",
      }),
    ).toBeNull();
    expect(
      deriveSynaraMcpToolTitle({
        title: "Synara handled delete project after recovery",
        status: "running",
      }),
    ).toBeNull();
    expect(
      deriveSynaraMcpToolTitle({
        title: "Synara couldn't handle delete project after recovery",
        status: "failed",
      }),
    ).toBeNull();
  });

  it("removes transport identifiers without hiding meaningful Synara details", () => {
    expect(
      sanitizeSynaraMcpToolPreview({
        preview: "Synara__synara_create_threads",
        heading: "Synara created threads",
        status: "completed",
      }),
    ).toBeNull();
    expect(
      sanitizeSynaraMcpToolPreview({
        preview: 'Unexpected key "reasoningEffort" for Claude Agent',
        heading: "Synara couldn't create threads",
        status: "failed",
      }),
    ).toBe('Unexpected key "reasoningEffort" for Claude Agent');
  });
});

describe("isSynaraBrowserToolCall", () => {
  it("recognizes canonical presentation titles without a tool identifier", () => {
    expect(isSynaraBrowserToolCall({ title: "Open browser tab" })).toBe(true);
    expect(isSynaraBrowserToolCall({ fallbackLabel: "Snapshot browser page" })).toBe(true);
    expect(isSynaraBrowserToolCall({ title: "Synara listed threads" })).toBe(false);
  });
});

describe("deriveReadableToolTitle", () => {
  it.each([["mcp__synara__computer_activate_window", "Activate a window"]])(
    "uses the curated Computer label for %s",
    (toolName, expected) => {
      expect(
        deriveReadableToolTitle({
          title: "Tool",
          fallbackLabel: "Tool",
          itemType: "mcp_tool_call",
          payload: { data: { item: { tool: toolName } } },
        }),
      ).toBe(expected);
    },
  );

  it("humanizes git status commands", () => {
    expect(
      deriveReadableToolTitle({
        title: "Ran command",
        fallbackLabel: "Ran command",
        itemType: "command_execution",
        command: "git status --short",
      }),
    ).toBe("Checked");
  });

  it("keeps explicit non-generic titles", () => {
    expect(
      deriveReadableToolTitle({
        title: "Bash",
        fallbackLabel: "Ran command",
        itemType: "command_execution",
        command: "echo hello",
      }),
    ).toBe("Bash");
  });

  it("treats Cursor placeholder titles as generic", () => {
    expect(
      deriveReadableToolTitle({
        title: "Find",
        fallbackLabel: "Find",
        itemType: "dynamic_tool_call",
        payload: { data: { kind: "search" } },
      }),
    ).toBe("Search");

    expect(
      deriveReadableToolTitle({
        title: "Read File",
        fallbackLabel: "Read File",
        itemType: "dynamic_tool_call",
        payload: { data: { kind: "read" } },
      }),
    ).toBe("Read");
  });

  it("humanizes provider tool identifiers used as lifecycle titles", () => {
    expect(
      deriveReadableToolTitle({
        title: "get_app_state",
        fallbackLabel: "get_app_state",
        itemType: "mcp_tool_call",
      }),
    ).toBe("Get App State");
  });
});

describe("deriveReadableCommandDisplay", () => {
  it.each(["|", "\t\r\n|\t"])("keeps the first command before a pipe: %j", (pipe) => {
    const command = `cat src/result.ts${pipe}head -n 1`;
    expect(deriveReadableCommandDisplay(command)).toEqual({
      verb: "Read",
      target: "src/result.ts",
      fullCommand: command,
    });
  });

  it("extracts search targets without leaking the full shell wrapper inline", () => {
    expect(deriveReadableCommandDisplay(`/bin/zsh -lc 'rg -n "tool call" apps/web/src'`)).toEqual({
      verb: "Searched",
      target: "for tool call in web/src",
      fullCommand: `/bin/zsh -lc 'rg -n "tool call" apps/web/src'`,
    });
  });

  it("unwraps zsh shell wrappers around read commands", () => {
    expect(
      deriveReadableCommandDisplay(
        `/bin/zsh -lc "sed -n '240,520p' src/components/provider-card.tsx"`,
      ),
    ).toEqual({
      verb: "Read",
      target: "components/provider-card.tsx",
      fullCommand: `/bin/zsh -lc "sed -n '240,520p' src/components/provider-card.tsx"`,
    });
  });

  it("keeps quoted paths intact when shell wrappers include cd chaining", () => {
    expect(
      deriveReadableCommandDisplay(
        `zsh -lc "cd '/tmp/my app' && sed -n '1,260p' src/pages/overview.tsx"`,
      ),
    ).toEqual({
      verb: "Read",
      target: "pages/overview.tsx",
      fullCommand: `zsh -lc "cd '/tmp/my app' && sed -n '1,260p' src/pages/overview.tsx"`,
    });
  });

  it("does not discard real chained commands after a shell wrapper", () => {
    expect(
      deriveReadableCommandDisplay(
        `/bin/zsh -lc 'rm -f /tmp/test.log && bun run --cwd apps/server test'`,
      ),
    ).toEqual({
      verb: "Removed",
      target: "/tmp/test.log",
      fullCommand: `/bin/zsh -lc 'rm -f /tmp/test.log && bun run --cwd apps/server test'`,
    });
  });

  it("removes env and timeout wrappers from inline command summaries", () => {
    expect(
      deriveReadableCommandDisplay(
        "env -u SYNARA_AUTH_TOKEN SYNARA_PORT_OFFSET=3158 timeout 180s bun run dev",
        true,
      ),
    ).toEqual({
      verb: "Running",
      target: "bun run dev",
      fullCommand: "env -u SYNARA_AUTH_TOKEN SYNARA_PORT_OFFSET=3158 timeout 180s bun run dev",
    });
  });

  it("summarizes inline script commands without leaking the script body", () => {
    expect(
      deriveReadableCommandDisplay(`node -e "const fs = require('fs'); console.log(fs.cwd)"`, true),
    ).toEqual({
      verb: "Running",
      target: "node script",
      fullCommand: `node -e "const fs = require('fs'); console.log(fs.cwd)"`,
    });

    expect(deriveReadableCommandDisplay("python3 - <<'PY'\nprint('hi')\nPY", true)).toEqual({
      verb: "Running",
      target: "python script",
      fullCommand: "python3 - <<'PY'\nprint('hi')\nPY",
    });
  });

  it("humanizes current-directory searches without leaking placeholder dots", () => {
    expect(deriveReadableCommandDisplay(`rg -n "model(s)?" .`)).toEqual({
      verb: "Searched",
      target: "for model(s)? in current directory",
      fullCommand: `rg -n "model(s)?" .`,
    });
  });

  it("falls back to a directory summary when the search token is only punctuation", () => {
    expect(deriveReadableCommandDisplay(`rg -n . src/lib`)).toEqual({
      verb: "Searched",
      target: "in src/lib",
      fullCommand: `rg -n . src/lib`,
    });
  });
});

describe("deriveFriendlyCommandTarget", () => {
  it("uses a friendly shell name instead of leaking the full wrapper command", () => {
    expect(
      deriveFriendlyCommandTarget(
        '"C:\\Users\\Example\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe" -Command "powershell -NoProfile -Command \\"1..8\\""',
      ),
    ).toBe("PowerShell");
  });

  it("keeps long targets short enough to sit inline", () => {
    const target = deriveFriendlyCommandTarget(`echo ${"a".repeat(200)}`);
    expect(target.length).toBeLessThanOrEqual(72);
    expect(target.endsWith("…")).toBe(true);
  });
});

describe("deriveInlineCommandCall", () => {
  it("shows the actual command call without the shell wrapper", () => {
    expect(deriveInlineCommandCall(`/bin/zsh -lc 'rg -n "tool call" apps/web/src'`)).toBe(
      `rg -n "tool call" apps/web/src`,
    );
  });
});

describe("resolveCommandVisualKind", () => {
  it("detects read-only inspection commands (read/search/find/list)", () => {
    expect(resolveCommandVisualKind("cat package.json")).toBe("inspect");
    expect(resolveCommandVisualKind("sed -n 1,40p src/app.ts")).toBe("inspect");
    expect(resolveCommandVisualKind("head -n 20 README.md")).toBe("inspect");
    expect(resolveCommandVisualKind(`rg -n "tool call" apps/web/src`)).toBe("inspect");
    expect(resolveCommandVisualKind("grep -R foo .")).toBe("inspect");
    expect(resolveCommandVisualKind("find . -name '*.ts'")).toBe("inspect");
    expect(resolveCommandVisualKind("ls -la src")).toBe("inspect");
    expect(resolveCommandVisualKind(`/bin/zsh -lc 'rg -n "x" src'`)).toBe("inspect");
  });

  it("does not treat mutating or executing commands as inspections", () => {
    expect(resolveCommandVisualKind("git status")).toBe("git");
    expect(resolveCommandVisualKind("node build.js")).toBe("terminal");
    expect(resolveCommandVisualKind("rm -rf dist")).toBe("terminal");
    expect(resolveCommandVisualKind("mkdir foo")).toBe("terminal");
  });

  it("classifies git commands through shell and global-option wrappers", () => {
    expect(resolveCommandVisualKind("git status --short")).toBe("git");
    expect(resolveCommandVisualKind("git -C apps/web status --short")).toBe("git");
    expect(resolveCommandVisualKind(`/bin/zsh -lc "cd repo && git branch -vv"`)).toBe("git");
  });

  it("classifies GitHub CLI commands through env wrappers", () => {
    expect(resolveCommandVisualKind("gh pr view 274 --repo owner/repo")).toBe("github");
    expect(resolveCommandVisualKind("env -u GH_TOKEN gh pr status")).toBe("github");
    expect(resolveCommandVisualKind("hub pull-request -m test")).toBe("github");
  });
});
