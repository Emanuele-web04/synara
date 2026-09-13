import { defineConfig } from "vitest/config";

import stableConfig from "./vitest.browser.stable.config";
import { chatPatterns } from "./vitest.browser.partitions";

const chatViewFile = "src/components/ChatView.browser.tsx";
const { testNamePattern, ...stableTestConfig } = stableConfig.test!;
const stablePattern = testNamePattern as RegExp;
const patterns = chatPatterns(stablePattern);

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
          testNamePattern: patterns.follow,
        },
      },
      {
        extends: true,
        test: {
          name: "chat-workflows",
          include: [chatViewFile],
          testNamePattern: patterns.workflows,
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
