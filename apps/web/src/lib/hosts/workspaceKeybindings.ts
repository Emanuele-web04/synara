import type { ServerConfig } from "@synara/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { readWorkspaceFrame } from "./workspaceFrame";

/** App chords follow the controlling window; project scripts stay with their computer. */
export function withWorkspaceKeybindings(config: ServerConfig): ServerConfig {
  const frame = readWorkspaceFrame();
  if (!frame) return config;
  return {
    ...config,
    keybindings: [
      ...(frame.controller.keybindings?.read() ?? []).filter(
        (binding) => !binding.command.startsWith("script."),
      ),
      ...config.keybindings.filter((binding) => binding.command.startsWith("script.")),
    ],
  };
}

export function subscribeWorkspaceKeybindings(
  queryClient: QueryClient,
  queryKey: readonly string[],
) {
  return readWorkspaceFrame()?.controller.keybindings?.subscribe(() => {
    queryClient.setQueryData<ServerConfig>(queryKey, (config) =>
      config ? withWorkspaceKeybindings(config) : config,
    );
  });
}
