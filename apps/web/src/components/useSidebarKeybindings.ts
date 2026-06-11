// Purpose: Global keydown/keyup/blur listeners that drive Sidebar search palette + thread-jump hints.
// Layer: web hook (effect-only). Registers window listeners with the same order/deps as the inline effect.
// Exports: useSidebarKeybindings, SidebarKeybindingsDeps.

import { useEffect } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { ResolvedKeybindingsConfig, ThreadId } from "@t3tools/contracts";
import {
  resolveShortcutCommand,
  shouldShowThreadJumpHints,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
  type ShortcutMatchContext,
} from "../keybindings";
import {
  EMPTY_THREAD_JUMP_LABELS,
  buildThreadJumpLabelMap,
  getNextVisibleSidebarThreadId,
  threadJumpLabelMapsEqual,
} from "./Sidebar.logic";
import { getInitialBrowseQuery } from "~/lib/projectPaths";
import type { SidebarSearchPaletteMode } from "./SidebarSearchPalette";

type ThreadJumpCommand = NonNullable<ReturnType<typeof threadJumpCommandForIndex>>;

interface SidebarShortcutContext extends ShortcutMatchContext {
  terminalWorkspaceOpen: boolean;
}

export interface SidebarKeybindingsDeps {
  keybindings: ResolvedKeybindingsConfig;
  homeDir: string | null;
  searchPaletteMode: SidebarSearchPaletteMode;
  threadJumpCommandByThreadId: ReadonlyMap<ThreadId, ThreadJumpCommand>;
  threadJumpThreadIds: readonly ThreadId[];
  visibleSidebarThreadIds: readonly ThreadId[];
  activeSidebarThreadId: ThreadId | null;
  showThreadJumpHintsRef: RefObject<boolean>;
  threadJumpLabelsRef: RefObject<ReadonlyMap<ThreadId, string>>;
  getCurrentSidebarShortcutContext: () => SidebarShortcutContext;
  activateThreadFromSidebarIntent: (threadId: ThreadId) => void;
  setSearchPaletteMode: Dispatch<SetStateAction<SidebarSearchPaletteMode>>;
  setSearchPaletteOpen: Dispatch<SetStateAction<boolean>>;
  setSearchPaletteInitialQuery: Dispatch<SetStateAction<string | null>>;
  setThreadJumpLabelByThreadId: Dispatch<SetStateAction<ReadonlyMap<ThreadId, string>>>;
  setShowThreadJumpHints: Dispatch<SetStateAction<boolean>>;
}

export function useSidebarKeybindings(deps: SidebarKeybindingsDeps): void {
  const {
    keybindings,
    homeDir,
    searchPaletteMode,
    threadJumpCommandByThreadId,
    threadJumpThreadIds,
    visibleSidebarThreadIds,
    activeSidebarThreadId,
    showThreadJumpHintsRef,
    threadJumpLabelsRef,
    getCurrentSidebarShortcutContext,
    activateThreadFromSidebarIntent,
    setSearchPaletteMode,
    setSearchPaletteOpen,
    setSearchPaletteInitialQuery,
    setThreadJumpLabelByThreadId,
    setShowThreadJumpHints,
  } = deps;

  useEffect(() => {
    const clearThreadJumpHints = () => {
      setThreadJumpLabelByThreadId((current) =>
        current === EMPTY_THREAD_JUMP_LABELS ? current : EMPTY_THREAD_JUMP_LABELS,
      );
      setShowThreadJumpHints(false);
    };
    const shouldIgnoreThreadJumpHintUpdate = (event: KeyboardEvent) =>
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey &&
      event.key !== "Meta" &&
      event.key !== "Control" &&
      event.key !== "Alt" &&
      event.key !== "Shift" &&
      !showThreadJumpHintsRef.current &&
      threadJumpLabelsRef.current === EMPTY_THREAD_JUMP_LABELS;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;

      if (
        (event.metaKey || event.ctrlKey) &&
        event.key === "k" &&
        !event.shiftKey &&
        !event.altKey
      ) {
        event.preventDefault();
        event.stopPropagation();
        setSearchPaletteMode("search");
        setSearchPaletteInitialQuery(null);
        setSearchPaletteOpen((prev) => !prev || searchPaletteMode !== "search");
        return;
      }

      const shortcutContext = getCurrentSidebarShortcutContext();
      if (!shouldIgnoreThreadJumpHintUpdate(event)) {
        const shouldShowHints = shouldShowThreadJumpHints(event, keybindings, {
          platform: navigator.platform,
          context: shortcutContext,
        });
        if (!shouldShowHints) {
          if (
            showThreadJumpHintsRef.current ||
            threadJumpLabelsRef.current !== EMPTY_THREAD_JUMP_LABELS
          ) {
            clearThreadJumpHints();
          }
        } else {
          setThreadJumpLabelByThreadId((current) => {
            const nextLabelMap = buildThreadJumpLabelMap({
              keybindings,
              platform: navigator.platform,
              terminalOpen: shortcutContext.terminalOpen,
              threadJumpCommandByThreadId,
            });
            return threadJumpLabelMapsEqual(current, nextLabelMap) ? current : nextLabelMap;
          });
          setShowThreadJumpHints(true);
        }
      }

      const command = resolveShortcutCommand(event, keybindings, {
        context: shortcutContext,
      });
      if (command === "sidebar.search") {
        event.preventDefault();
        event.stopPropagation();
        setSearchPaletteMode("search");
        setSearchPaletteInitialQuery(null);
        setSearchPaletteOpen((prev) => !prev || searchPaletteMode !== "search");
        return;
      }
      if (command === "sidebar.addProject") {
        event.preventDefault();
        event.stopPropagation();
        setSearchPaletteMode("search");
        setSearchPaletteInitialQuery(getInitialBrowseQuery(homeDir));
        setSearchPaletteOpen(true);
        return;
      }
      if (command === "sidebar.importThread") {
        event.preventDefault();
        event.stopPropagation();
        setSearchPaletteMode("import");
        setSearchPaletteInitialQuery(null);
        setSearchPaletteOpen((prev) => !prev || searchPaletteMode !== "import");
        return;
      }
      const jumpIndex = threadJumpIndexFromCommand(command ?? "");
      if (jumpIndex !== null) {
        event.preventDefault();
        event.stopPropagation();
        const threadJumpTargetId = threadJumpThreadIds[jumpIndex];
        if (threadJumpTargetId) {
          activateThreadFromSidebarIntent(threadJumpTargetId);
        }
        return;
      }
      if (command !== "chat.visible.next" && command !== "chat.visible.previous") {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      const nextThreadId = getNextVisibleSidebarThreadId({
        visibleThreadIds: visibleSidebarThreadIds,
        activeThreadId: activeSidebarThreadId ?? undefined,
        direction: command === "chat.visible.previous" ? "backward" : "forward",
      });
      if (nextThreadId && nextThreadId !== activeSidebarThreadId) {
        activateThreadFromSidebarIntent(nextThreadId);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (shouldIgnoreThreadJumpHintUpdate(event)) {
        return;
      }
      const shortcutContext = getCurrentSidebarShortcutContext();
      const shouldShowHints = shouldShowThreadJumpHints(event, keybindings, {
        platform: navigator.platform,
        context: shortcutContext,
      });
      if (!shouldShowHints) {
        clearThreadJumpHints();
        return;
      }
      setThreadJumpLabelByThreadId((current) => {
        const nextLabelMap = buildThreadJumpLabelMap({
          keybindings,
          platform: navigator.platform,
          terminalOpen: shortcutContext.terminalOpen,
          threadJumpCommandByThreadId,
        });
        return threadJumpLabelMapsEqual(current, nextLabelMap) ? current : nextLabelMap;
      });
      setShowThreadJumpHints(true);
    };
    const onWindowBlur = () => {
      clearThreadJumpHints();
    };

    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("keyup", onKeyUp, { capture: true });
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      window.removeEventListener("keyup", onKeyUp, { capture: true });
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [
    activateThreadFromSidebarIntent,
    activeSidebarThreadId,
    keybindings,
    getCurrentSidebarShortcutContext,
    homeDir,
    searchPaletteMode,
    threadJumpCommandByThreadId,
    threadJumpThreadIds,
    visibleSidebarThreadIds,
    setSearchPaletteInitialQuery,
    setSearchPaletteMode,
    setSearchPaletteOpen,
    setShowThreadJumpHints,
    setThreadJumpLabelByThreadId,
    showThreadJumpHintsRef,
    threadJumpLabelsRef,
  ]);
}
