import { readNativeApi } from "~/nativeApi";

/** Shell alias/command used to start CrossUsage locally. */
export const CROSSUSAGE_LAUNCH_COMMAND = "usage";

export async function launchCrossUsage(): Promise<void> {
  const api = readNativeApi();
  if (!api) {
    throw new Error("Native API not found");
  }

  await api.shell.runDetachedCommand(CROSSUSAGE_LAUNCH_COMMAND);
}
