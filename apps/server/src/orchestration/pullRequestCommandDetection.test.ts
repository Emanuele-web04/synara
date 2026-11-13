import { describe, expect, it } from "vitest";

import { detectCreatedPullRequestUrls } from "./pullRequestCommandDetection.ts";

const URL = "https://github.com/acme/app/pull/42";

const codexItem = (command: string, output: string, status = "completed") => ({
  itemType: "command_execution",
  status,
  data: { item: { type: "commandExecution", command, aggregatedOutput: output } },
});

const claudeItem = (command: string, output: string) => ({
  itemType: "command_execution",
  status: "completed",
  data: {
    toolName: "Bash",
    input: { command, description: "Open the PR" },
    result: { type: "tool_result", content: [{ type: "text", text: output }] },
  },
});

describe("detectCreatedPullRequestUrls", () => {
  it("finds the URL gh pr create prints, for Codex and Claude item shapes", () => {
    expect(
      detectCreatedPullRequestUrls(
        codexItem(
          '/bin/zsh -lc \'gh pr create --title "Fix" --body "Body"\'',
          `Creating pull request for fix into main in acme/app\n\n${URL}\n`,
        ),
      ),
    ).toEqual([URL]);
    expect(
      detectCreatedPullRequestUrls(
        claudeItem(
          `git push -u origin fix && gh pr create --title "Fix" --body "$(cat <<'EOF'\nSee ${URL.replace("42", "7")}\nEOF\n)"`,
          `${URL}\n`,
        ),
      ),
    ).toEqual([URL]);
  });

  it("accepts env prefixes at a command position", () => {
    expect(
      detectCreatedPullRequestUrls(codexItem("GH_PROMPT_DISABLED=1 gh pr create --fill", URL)),
    ).toEqual([URL]);
  });

  it("ignores commands that only mention gh pr create", () => {
    expect(detectCreatedPullRequestUrls(codexItem('echo "gh pr create"', URL))).toEqual([]);
    expect(detectCreatedPullRequestUrls(codexItem("gh pr view 42 --json url", URL))).toEqual([]);
  });

  it("ignores ambiguous or failed output", () => {
    const other = "https://github.com/acme/app/pull/43";
    expect(
      detectCreatedPullRequestUrls(codexItem("gh pr create --fill", `${URL}\n${other}\n`)),
    ).toEqual([]);
    expect(
      detectCreatedPullRequestUrls(codexItem("gh pr create --fill && gh pr list", `${URL}\n`)),
    ).toEqual([]);
    expect(detectCreatedPullRequestUrls(codexItem("gh pr create --fill", URL, "failed"))).toEqual(
      [],
    );
    expect(
      detectCreatedPullRequestUrls(
        codexItem(
          "gh pr create --fill",
          `a pull request for branch "fix" into branch "main" already exists:\n${URL} is open`,
        ),
      ),
    ).toEqual([]);
  });

  it("ignores URLs the command itself names and non-command items", () => {
    expect(
      detectCreatedPullRequestUrls(codexItem(`gh pr create --body "Follows ${URL}"`, `${URL}\n`)),
    ).toEqual([]);
    expect(
      detectCreatedPullRequestUrls({
        itemType: "mcp_tool_call",
        status: "completed",
        data: { item: { command: "gh pr create", aggregatedOutput: URL } },
      }),
    ).toEqual([]);
  });
});
