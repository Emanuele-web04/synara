import { defineConfig } from "vitest/config";

import stableConfig from "./vitest.browser.stable.config";

const chatViewFile = "src/components/ChatView.browser.tsx";
const { testNamePattern, ...stableTestConfig } = stableConfig.test!;
const stablePattern = testNamePattern as RegExp;
// Pair the short follow matrix with measured project/worktree/approval flows.
// Complementary patterns keep every new stable ChatView case in exactly one lane.
// See .github/CI.md for the paired measurements and runner-time tradeoff.
const followPattern = "(?:restores streaming follow|project|worktree|Space|approval)";

export default defineConfig({
  ...stableConfig,
  test: {
    // A root testNamePattern overrides project patterns at runtime in Vitest.
    // Keep the quarantine in each project so the ChatView split also applies.
    ...stableTestConfig,
    // Project inheritance concatenates include arrays. Give each project sole
    // ownership of its files instead of inheriting the full browser glob set.
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
          name: "chat-workflows",
          include: [chatViewFile],
          testNamePattern: new RegExp(`${stablePattern.source}(?!.*${followPattern})`),
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
