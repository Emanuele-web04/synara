import { afterEach, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { KeybindingCommand, ResolvedKeybindingRule, ServerConfig } from "@synara/contracts";
import { resolveShortcutCommand } from "../../keybindings";
import { serverConfigQueryOptions, serverQueryKeys } from "../serverReactQuery";
import { subscribeWorkspaceKeybindings } from "./workspaceKeybindings";

afterEach(() => vi.unstubAllGlobals());

const rule = (command: KeybindingCommand, key: string): ResolvedKeybindingRule => ({
  command,
  shortcut: { key, modKey: true, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false },
});

it("uses live controller chords while keeping remote scripts and provider configuration", async () => {
  const remote: ServerConfig = {
    keybindings: [rule("sidebar.search", "r"), rule("script.remote.run", "j")],
    providers: [
      {
        provider: "codex",
        instanceId: "codex",
        driver: "codex",
        status: "ready",
        available: true,
        authStatus: "authenticated",
        checkedAt: "2026-10-07T12:00:00.000Z",
      },
    ],
    cwd: "/remote/project",
    homeDir: "/remote",
    chatWorkspaceRoot: "/remote/chats",
    studioWorkspaceRoot: "/remote/studio",
    groupsWorkspaceRoot: "/remote/groups",
    worktreesDir: "/remote/worktrees",
    keybindingsConfigPath: "/remote/keybindings.json",
    availableEditors: [],
    issues: [],
  };
  let controller = [rule("sidebar.search", "k"), rule("script.local.run", "l")];
  const listeners = new Set<() => void>();
  vi.stubGlobal("window", {
    nativeApi: { server: { getConfig: async () => remote } },
    frameElement: {
      synaraWorkspace: {
        controller: {
          keybindings: {
            read: () => controller,
            subscribe: (listener: () => void) => {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
          },
        },
      },
    },
  });
  const client = new QueryClient();
  const unsubscribe = subscribeWorkspaceKeybindings(client, serverQueryKeys.config());
  try {
    await client.fetchQuery(serverConfigQueryOptions());
    const dispatch = (key: string) =>
      resolveShortcutCommand(
        { key, ctrlKey: true, metaKey: false, shiftKey: false, altKey: false },
        client.getQueryData<ServerConfig>(serverQueryKeys.config())!.keybindings,
        { platform: "Win32" },
      );
    expect(dispatch("k")).toBe("sidebar.search");
    expect(dispatch("r")).not.toBe("sidebar.search");
    expect(dispatch("j")).toBe("script.remote.run");
    expect(dispatch("l")).not.toBe("script.local.run");
    controller = [rule("sidebar.search", "y")];
    for (const listener of listeners) listener();
    expect(dispatch("y")).toBe("sidebar.search");
    expect(dispatch("k")).not.toBe("sidebar.search");
    expect(dispatch("j")).toBe("script.remote.run");
    expect(client.getQueryData<ServerConfig>(serverQueryKeys.config())).toMatchObject({
      cwd: "/remote/project",
      providers: remote.providers,
    });
    unsubscribe?.();
    controller = [rule("sidebar.search", "z")];
    for (const listener of listeners) listener();
    expect(dispatch("y")).toBe("sidebar.search");
  } finally {
    unsubscribe?.();
    client.clear();
  }
});
