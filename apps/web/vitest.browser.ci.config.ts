import { defineConfig } from "vitest/config";

import { createPinnedShardSequencer } from "../../vitest.shards";
import stableConfig from "./vitest.browser.stable.config";

const chatViewFile = "src/components/ChatView.browser.tsx";
const { testNamePattern, ...stableTestConfig } = stableConfig.test!;
const stablePattern = testNamePattern as RegExp;
// Measured complementary groups keep every stable ChatView case in exactly one lane.
// The final fallback also owns unknown future stable cases instead of silently skipping them.
// Keep pane/follow cases and workspace tab navigation with their related lanes.
// See .github/CI.md for the paired measurements and runner-time tradeoff.
const followPattern =
  "(?:restores streaming follow|anchor|scroll|tool|detached (?:reading|transcript)|\\bpanes?\\b|split widths|split collapses)";
const followSlicePattern = "restores streaming follow";
const tabNavigationPattern =
  "(?:pending editor chat tab switch|horizontal tabs|Cmd/Ctrl\\+W yields to the editor surface)";
const projectPattern = `(?:project|worktree|Space|approval|preserves three answers|queued|queue|sidebar|handoff|${tabNavigationPattern})`;
const projectSlicePattern = `(?:worktree|queue|queued|handoff|${tabNavigationPattern})`;
const workflowSlicePattern = "(?:[Cc]omposer|[Dd]raft|[Pp]icker|[Ss]hortcut|[Ee]ditor)";
const chatSlice = process.env.VITEST_BROWSER_CHAT_SLICE;

// Balance the six component processes. EventRouter and three shorter files
// balance the pair on components 3/3. The three files on shard 3 move some
// of that job's work to components 2/3 (.github/CI.md). All other files use
// their native shard, and the single-shard ChatView jobs have no pins.
const componentSequencer = createPinnedShardSequencer({
  6: {
    "src/components/ChatMarkdown.streaming.browser.tsx": 3,
    "src/components/ProjectImportPanel.browser.tsx": 3,
    "src/components/codeEditor/CodeEditorPane.pierre.browser.tsx": 3,
    "src/components/EventRouter.browser.tsx": 5,
    "src/components/chat/environment/EnvironmentPullRequestSection.browser.tsx": 6,
    "src/components/chat/GeneratedMarkdownImage.browser.tsx": 6,
    "src/hooks/useWorkspaceFileEditorSession.browser.tsx": 6,
  },
});

// Each paired runner uses complementary filters after the original project
// filter. New cases stay covered even if they match neither slice's keywords.
function sliceCondition(pattern: string): string {
  switch (chatSlice) {
    case "a":
      return `(?=.*${pattern})`;
    case "b":
      return `(?!.*${pattern})`;
    case undefined:
    case "":
      return "";
    default:
      throw new Error(`Invalid VITEST_BROWSER_CHAT_SLICE: ${chatSlice}`);
  }
}

export default defineConfig({
  ...stableConfig,
  // Separate Vite's optimizer and Vitest results when two processes share a runner.
  cacheDir: process.env.VITEST_BROWSER_CACHE_DIR ?? stableConfig.cacheDir,
  test: {
    // A root testNamePattern overrides project patterns at runtime in Vitest.
    // Keep the quarantine in each project so the ChatView split also applies.
    ...stableTestConfig,
    sequence: { sequencer: componentSequencer },
    // Project inheritance concatenates include arrays. Give each project sole
    // ownership of its files instead of inheriting the full browser glob set.
    include: [],
    projects: [
      {
        extends: true,
        test: {
          name: "chat-follow",
          include: [chatViewFile],
          testNamePattern: new RegExp(
            `${stablePattern.source}(?=.*${followPattern})${sliceCondition(followSlicePattern)}`,
          ),
        },
      },
      {
        extends: true,
        test: {
          name: "chat-projects",
          include: [chatViewFile],
          testNamePattern: new RegExp(
            `${stablePattern.source}(?!.*${followPattern})(?=.*${projectPattern})${sliceCondition(projectSlicePattern)}`,
          ),
        },
      },
      {
        extends: true,
        test: {
          name: "chat-workflows",
          include: [chatViewFile],
          testNamePattern: new RegExp(
            `${stablePattern.source}(?!.*${followPattern})(?!.*${projectPattern})${sliceCondition(workflowSlicePattern)}`,
          ),
        },
      },
      {
        extends: true,
        test: {
          name: "components",
          include: stableTestConfig.include!,
          exclude: [chatViewFile],
          testNamePattern: stablePattern,
        },
      },
    ],
  },
});
