// Where an isolated scenario run keeps its state. Outside the checkout, so the disposable demo
// repository is never nested inside Synara's own git tree.
import * as nodeOs from "node:os";
import * as nodePath from "node:path";

export const RUN_DIR =
  process.env.SYNBOT_SCENARIO_DIR ?? nodePath.join(nodeOs.tmpdir(), "synbot-scenarios");
export const STATE_DIR = nodePath.join(RUN_DIR, "agent");
export const DEMO_REPO = nodePath.join(RUN_DIR, "repos/demo-app");
export const HOME = nodePath.join(RUN_DIR, "home");
export const SYNARA_HOME = nodePath.join(RUN_DIR, "synara-home");
export const WORKTREES_DIR = nodePath.join(SYNARA_HOME, "worktrees");
