// deliberately a leaf module with no xterm dependency — eagerly-loaded surfaces must not drag the xterm runtime (~223 KB gzip) into the initial bundle

import { randomUUID } from "~/lib/utils";

// Stable, collision-resistant id for a new terminal pane/tab/split.
export function randomTerminalId(): string {
  return `terminal-${randomUUID()}`;
}
