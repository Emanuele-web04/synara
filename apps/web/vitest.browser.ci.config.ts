import { defineConfig } from "vitest/config";

import { createPinnedShardSequencer } from "../../vitest.shards";
import stableConfig from "./vitest.browser.stable.config";

const chatViewFile = "src/components/ChatView.browser.tsx";
const { testNamePattern, ...stableTestConfig } = stableConfig.test!;
const stablePattern = testNamePattern as RegExp;
// Complementary groups keep every stable ChatView case in exactly one project.
// The final fallback also owns unknown future stable cases instead of silently skipping them.
// Keep pane/follow cases and workspace tab navigation with their related projects.
const followPattern =
  "(?:restores streaming follow|anchor|scroll|tool|detached (?:reading|transcript)|\\bpanes?\\b|split widths|split collapses)";
const tabNavigationPattern =
  "(?:pending editor chat tab switch|horizontal tabs|Cmd/Ctrl\\+W yields to the editor surface)";
const projectPattern = `(?:project|worktree|Space|approval|preserves three answers|queued|queue|sidebar|handoff|${tabNavigationPattern})`;

// CI runs each ChatView project as several processes. A process takes the
// cases whose full name length has one remainder modulo the slice count, so the
// slices of a project are complete and disjoint by construction, and a new case
// lands in exactly one of them without a keyword list to maintain. Measured
// balance and the job layout: .github/CI.md.
export const CHAT_SLICE_COUNTS = {
  "chat-follow": 2,
  "chat-projects": 3,
  "chat-workflows": 3,
} as const;

// Native placement put EventRouter (40 s of tests) on shard 9 beside the
// lightest shard, 10. These five files move from 9 to 10 so the pair on
// components 5/5 is balanced; every other file keeps its native shard
// (.github/CI.md).
const componentSequencer = createPinnedShardSequencer({
  10: {
    "src/components/chat/AsciiWaveBackground.browser.tsx": 10,
    "src/components/chat/group/GroupSettingsDialog.browser.tsx": 10,
    "src/components/SafariAccessOnboarding.browser.tsx": 10,
    "src/components/settings/SyncKeyPairingPanel.browser.tsx": 10,
    "src/components/useRouteSpaceSync.browser.tsx": 10,
  },
});

function sliceCondition(): string {
  const slice = process.env.VITEST_BROWSER_CHAT_SLICE;
  if (slice === undefined || slice === "") return "";
  const match = /^([1-9])\/([1-9])$/.exec(slice);
  const index = Number(match?.[1]);
  const count = Number(match?.[2]);
  if (!match || index > count) throw new Error(`Invalid VITEST_BROWSER_CHAT_SLICE: ${slice}`);
  return `(?=(?:[\\s\\S]{${count}})*[\\s\\S]{${index - 1}}$)`;
}
const slice = sliceCondition();

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
          testNamePattern: new RegExp(`${stablePattern.source}(?=.*${followPattern})${slice}`),
        },
      },
      {
        extends: true,
        test: {
          name: "chat-projects",
          include: [chatViewFile],
          testNamePattern: new RegExp(
            `${stablePattern.source}(?!.*${followPattern})(?=.*${projectPattern})${slice}`,
          ),
        },
      },
      {
        extends: true,
        test: {
          name: "chat-workflows",
          include: [chatViewFile],
          testNamePattern: new RegExp(
            `${stablePattern.source}(?!.*${followPattern})(?!.*${projectPattern})${slice}`,
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
