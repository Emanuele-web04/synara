import {
  ThreadId,
  type KeybindingCommand,
  type ProjectId,
  type ProjectScript,
} from "@synara/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef } from "react";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { decodeProjectScriptKeybindingRule } from "~/lib/projectScriptKeybindings";
import { serverQueryKeys } from "~/lib/serverReactQuery";
import { newCommandId } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import {
  commandForProjectScript,
  nextProjectScriptId,
  type ProjectScriptRunOptions,
  type ProjectScriptRunResult,
} from "~/projectScripts";
import { runProjectCommandInTerminal } from "~/projectTerminalRunner";
import { isElectron } from "../../env";
import { useTerminalStateStore } from "../../terminalStateStore";
import type { Project, Thread } from "../../types";
import { DEFAULT_THREAD_TERMINAL_ID } from "../../types";
import {
  LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
  LastInvokedScriptByProjectSchema,
} from "../ChatView.logic";
import { type NewProjectScriptInput } from "../ProjectScriptsControl";
import { disposeAndCloseTerminalSession } from "../terminal/terminalSession";
import { randomTerminalId } from "../terminal/terminalIds";
import { toastManager } from "../ui/toast";
const EMPTY_LAST_INVOKED_SCRIPT_BY_PROJECT: Record<string, string> = {};
interface ChatProjectScriptsInput {
  activeThreadId: ThreadId | null;
  activeThread: Thread | undefined;
  activeProject: Project | undefined;
  gitCwd: string | null;
  isGroupContainer: boolean;
  requestTerminalFocus: () => void;
  setTerminalOpen: (open: boolean) => void;
  setThreadError: (threadId: ThreadId, error: string | null) => void;
}

export function useChatProjectScripts({
  activeThreadId,
  activeThread,
  activeProject,
  gitCwd,
  isGroupContainer,
  requestTerminalFocus,
  setTerminalOpen,
  setThreadError,
}: ChatProjectScriptsInput) {
  const queryClient = useQueryClient();
  const pendingScriptThreads = useRef(new Set<ThreadId>());
  const storeNewTerminal = useTerminalStateStore((state) => state.newTerminal);
  const storeSetTerminalMetadata = useTerminalStateStore((state) => state.setTerminalMetadata);
  const [lastInvokedScriptByProjectId, setLastInvokedScriptByProjectId] = useLocalStorage(
    LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
    EMPTY_LAST_INVOKED_SCRIPT_BY_PROJECT,
    LastInvokedScriptByProjectSchema,
  );

  const runProjectScript = useCallback(
    async (
      script: ProjectScript,
      options?: ProjectScriptRunOptions,
    ): Promise<ProjectScriptRunResult | null> => {
      const api = readNativeApi();
      if (!api || !activeThreadId || !activeProject || !activeThread) return null;
      if (options?.rememberAsLastInvoked !== false) {
        setLastInvokedScriptByProjectId((current) => {
          if (current[activeProject.id] === script.id) return current;
          return { ...current, [activeProject.id]: script.id };
        });
      }
      const targetCwd = options?.cwd ?? gitCwd ?? activeProject.cwd;
      const terminalState =
        useTerminalStateStore.getState().terminalStateByThreadId[activeThreadId];
      const baseTerminalId = terminalState?.activeTerminalId ?? DEFAULT_THREAD_TERMINAL_ID;
      if (
        pendingScriptThreads.current.has(activeThreadId) ||
        terminalState?.runningTerminalIds.includes(baseTerminalId)
      ) {
        const error = new Error(
          "The terminal is busy. Stop its command or use another chat before running this action.",
        );
        setThreadError(activeThreadId, error.message);
        if (options?.throwOnError) throw error;
        return null;
      }
      const targetTerminalId = randomTerminalId();

      // React Compiler cannot lower value blocks directly inside `try`; keep
      // those expressions in the nested function while retaining error handling.
      const runScriptInTargetTerminal = async () => {
        const { metadata } = await runProjectCommandInTerminal({
          api,
          threadId: activeThreadId,
          terminalId: targetTerminalId,
          project: {
            cwd: isGroupContainer ? targetCwd : activeProject.cwd,
          },
          cwd: targetCwd,
          command: script.command,
          worktreePath: options?.worktreePath ?? activeThread.worktreePath ?? null,
          ...(options?.env ? { env: options.env } : {}),
        });
        if (metadata) {
          storeSetTerminalMetadata(activeThreadId, targetTerminalId, {
            cliKind: metadata.cliKind,
            label: metadata.label,
          });
        }
      };

      pendingScriptThreads.current.add(activeThreadId);
      try {
        // Persisted client activity is intentionally empty after reload. Always
        // ask the server, even for a legacy default session hidden in the UI.
        await disposeAndCloseTerminalSession({
          api,
          threadId: activeThreadId,
          terminalId: baseTerminalId,
          onlyIfIdle: true,
          deleteHistory: false,
        });
        useTerminalStateStore.getState().closeTerminal(activeThreadId, baseTerminalId);
        storeNewTerminal(activeThreadId, targetTerminalId);
        setTerminalOpen(true);
        requestTerminalFocus();
        await runScriptInTargetTerminal();
        pendingScriptThreads.current.delete(activeThreadId);
        return { terminalId: targetTerminalId };
      } catch (error) {
        pendingScriptThreads.current.delete(activeThreadId);
        setThreadError(
          activeThreadId,
          error instanceof Error ? error.message : `Failed to run script "${script.name}".`,
        );
        if (options?.throwOnError) {
          throw error instanceof Error
            ? error
            : new Error(`Failed to run script "${script.name}".`);
        }
        return null;
      }
    },
    [
      activeProject,
      activeThread,
      activeThreadId,
      gitCwd,
      isGroupContainer,
      requestTerminalFocus,
      setTerminalOpen,
      setThreadError,
      storeNewTerminal,
      storeSetTerminalMetadata,
      setLastInvokedScriptByProjectId,
    ],
  );

  const persistProjectScripts = useCallback(
    async (input: {
      projectId: ProjectId;
      nextScripts: ProjectScript[];
      keybinding?: string | null;
      keybindingCommand: KeybindingCommand;
    }) => {
      const api = readNativeApi();
      if (!api) return;

      await api.orchestration.dispatchCommand({
        type: "project.meta.update",
        commandId: newCommandId(),
        projectId: input.projectId,
        scripts: input.nextScripts,
      });

      const keybindingRule = decodeProjectScriptKeybindingRule({
        keybinding: input.keybinding,
        command: input.keybindingCommand,
      });

      if (isElectron && keybindingRule) {
        await api.server.upsertKeybinding({ rule: keybindingRule });
        await queryClient.invalidateQueries({ queryKey: serverQueryKeys.all });
      }
    },
    [queryClient],
  );
  const saveProjectScript = useCallback(
    async (input: NewProjectScriptInput) => {
      if (!activeProject) return;
      const nextId = nextProjectScriptId(
        input.name,
        activeProject.scripts.map((script) => script.id),
      );
      const nextScript: ProjectScript = {
        id: nextId,
        name: input.name,
        command: input.command,
        icon: input.icon,
        runOnWorktreeCreate: input.runOnWorktreeCreate,
      };
      const nextScripts = input.runOnWorktreeCreate
        ? [
            ...activeProject.scripts.map((script) =>
              script.runOnWorktreeCreate ? { ...script, runOnWorktreeCreate: false } : script,
            ),
            nextScript,
          ]
        : [...activeProject.scripts, nextScript];

      await persistProjectScripts({
        projectId: activeProject.id,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(nextId),
      });
    },
    [activeProject, persistProjectScripts],
  );
  const updateProjectScript = useCallback(
    async (scriptId: string, input: NewProjectScriptInput) => {
      if (!activeProject) return;
      const existingScript = activeProject.scripts.find((script) => script.id === scriptId);
      if (!existingScript) {
        throw new Error("Script not found.");
      }

      const updatedScript: ProjectScript = {
        ...existingScript,
        name: input.name,
        command: input.command,
        icon: input.icon,
        runOnWorktreeCreate: input.runOnWorktreeCreate,
      };
      const nextScripts = activeProject.scripts.map((script) =>
        script.id === scriptId
          ? updatedScript
          : input.runOnWorktreeCreate
            ? { ...script, runOnWorktreeCreate: false }
            : script,
      );

      await persistProjectScripts({
        projectId: activeProject.id,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(scriptId),
      });
    },
    [activeProject, persistProjectScripts],
  );
  const deleteProjectScript = useCallback(
    async (scriptId: string) => {
      if (!activeProject) return;
      const nextScripts = activeProject.scripts.filter((script) => script.id !== scriptId);

      const deletedName = activeProject.scripts.find((s) => s.id === scriptId)?.name;
      // Resolved before the `try`: a value block (`??`) inside a try body makes React
      // Compiler bail out on the whole component.
      const deletedScriptToastTitle = `Deleted action "${deletedName ?? "Unknown"}"`;

      try {
        await persistProjectScripts({
          projectId: activeProject.id,
          nextScripts,
          keybinding: null,
          keybindingCommand: commandForProjectScript(scriptId),
        });
        toastManager.add({
          type: "success",
          title: deletedScriptToastTitle,
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not delete action",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      }
    },
    [activeProject, persistProjectScripts],
  );
  return {
    runProjectScript,
    saveProjectScript,
    updateProjectScript,
    deleteProjectScript,
    lastInvokedScriptByProjectId,
  };
}
