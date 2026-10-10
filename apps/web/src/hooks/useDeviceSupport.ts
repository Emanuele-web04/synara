import { useQuery } from "@tanstack/react-query";

import { serverEnvironmentQueryOptions } from "~/lib/serverReactQuery";

// the simulator engine shells out to the server's Xcode — support follows the server's platform, not the browser's; false until resolved so the add-menu entry doesn't flicker
export function useDeviceSupport(): boolean {
  const environmentQuery = useQuery(serverEnvironmentQueryOptions());
  return environmentQuery.data?.platform.os === "darwin";
}
