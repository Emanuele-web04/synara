import { mergeConfig } from "vitest/config";

import serverConfig from "../../apps/server/vitest.config.ts";
import TimingSequencer from "./ci-sequencer.mjs";

// Keep the server's aliases, timeouts and test inventory; change only placement.
export default mergeConfig(serverConfig, {
  test: { sequence: { sequencer: TimingSequencer } },
});
