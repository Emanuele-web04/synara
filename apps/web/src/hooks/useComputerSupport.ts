// Report support using the connected server platform and already-cached status.
// Reading status just to draw the launcher would start the driver and may show
// a permission dialog on macOS. Runtime readiness remains authoritative.

import { useQuery } from "@tanstack/react-query";

import { useCachedComputerStatus } from "~/hooks/useCachedComputerStatus";
import { serverEnvironmentQueryOptions } from "~/lib/serverReactQuery";

/** The server platforms a computer backend exists for at all. */
const COMPUTER_CAPABLE_PLATFORMS: ReadonlySet<string> = new Set(["darwin", "linux", "windows"]);

export function useComputerSupport(): boolean {
  const environmentQuery = useQuery(serverEnvironmentQueryOptions());
  const platform = environmentQuery.data?.platform.os;
  const status = useCachedComputerStatus();
  // Until the environment resolves this is false, which keeps the launcher from
  // flickering in on a cold start the way an optimistic default would.
  if (platform === undefined || !COMPUTER_CAPABLE_PLATFORMS.has(platform)) return false;
  // Cached runtime status can narrow the platform-level support decision.
  return status?.availability.kind !== "unsupported-platform";
}
