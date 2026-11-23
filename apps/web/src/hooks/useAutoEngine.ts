import { useQuery } from "@tanstack/react-query";
import type { AutoEngine } from "@synara/contracts";
import { serverSettingsQueryOptions } from "~/lib/serverReactQuery";

/** The server-selected Auto approval engine; "native" until settings load. */
export function useAutoEngine(): AutoEngine {
  const settings = useQuery(serverSettingsQueryOptions());
  return settings.data?.autoEngine ?? "native";
}
