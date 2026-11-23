// Where an isolated scenario run keeps its state. Outside the checkout, so the disposable demo
// repository is never nested inside Synara's own git tree.
import * as nodeOs from "node:os";
import * as nodePath from "node:path";

export const RUN_DIR =
  process.env.SYNBOT_SCENARIO_DIR ?? nodePath.join(nodeOs.tmpdir(), "synbot-scenarios");

/** The folders of one run rooted at `root`. */
export const runPaths = (root: string) => {
  const synaraHome = nodePath.join(root, "synara-home");
  return {
    RUN_DIR: root,
    STATE_DIR: nodePath.join(root, "agent"),
    DEMO_REPO: nodePath.join(root, "repos/demo-app"),
    HOME: nodePath.join(root, "home"),
    SYNARA_HOME: synaraHome,
    WORKTREES_DIR: nodePath.join(synaraHome, "worktrees"),
  };
};

export const { STATE_DIR, DEMO_REPO, HOME, SYNARA_HOME, WORKTREES_DIR } = runPaths(RUN_DIR);

/** The Stable gate run (e2e.stable.config.ts) keeps its own state next to the default run's. */
export const STABLE = runPaths(`${RUN_DIR}-stable`);

/** The flavorless (CLI-like) gate run (e2e.cli.config.ts) keeps its own state too. */
export const CLI = runPaths(`${RUN_DIR}-cli`);

/** The Beta flavor run (e2e.beta.config.ts). */
export const BETA = runPaths(`${RUN_DIR}-beta`);

/** The run against a host without SynBot (e2e.old-host.config.ts). */
export const OLD_HOST = runPaths(`${RUN_DIR}-old-host`);
