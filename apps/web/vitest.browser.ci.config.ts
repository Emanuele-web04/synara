import { defineConfig } from "vitest/config";

import stableConfig from "./vitest.browser.stable.config";

const chatViewFile = "src/components/ChatView.browser.tsx";
const { testNamePattern, ...stableTestConfig } = stableConfig.test!;
const stablePattern = testNamePattern as RegExp;
// complementary groups keep every stable ChatView case in exactly one lane
// the fallback owns unknown future stable cases instead of silently skipping them
// see .github/CI.md for the paired measurements and runner-time tradeoff
const followPattern = "(?:restores streaming follow|anchor|scroll|tool)";
const projectPattern = "(?:project|worktree|Space|approval|preserves three answers|queued|queue)";

export default defineConfig({
  ...stableConfig,
  test: {
    // a root testNamePattern overrides project patterns at runtime — keep the quarantine per-project
    ...stableTestConfig,
    // project inheritance concatenates include arrays — give each project sole ownership of its files
    include: [],
    projects: [
      {
        extends: true,
        test: {
          name: "chat-follow",
          include: [chatViewFile],
          testNamePattern: new RegExp(`${stablePattern.source}(?=.*${followPattern})`),
        },
      },
      {
        extends: true,
        test: {
          name: "chat-projects",
          include: [chatViewFile],
          testNamePattern: new RegExp(
            `${stablePattern.source}(?!.*${followPattern})(?=.*${projectPattern})`,
          ),
        },
      },
      {
        extends: true,
        test: {
          name: "chat-workflows",
          include: [chatViewFile],
          testNamePattern: new RegExp(
            `${stablePattern.source}(?!.*${followPattern})(?!.*${projectPattern})`,
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
