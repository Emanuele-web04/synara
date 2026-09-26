import {
  ThreadId,
  type ModelSlug,
  type ProviderKind,
  type ResolvedKeybindingsConfig,
} from "@synara/contracts";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useEffect } from "react";
import { readStarredModelSlugs } from "~/lib/starredModels";
import { isMacNavigatorPlatform } from "~/lib/utils";
import { projectScriptIdFromCommand } from "~/projectScripts";
import { isElectron } from "../../env";
import { resolveShortcutCommand } from "../../keybindings";
import { isEditableEventTarget } from "../../lib/editableEventTarget";
import { isTerminalFocused } from "../../lib/terminalFocus";
import type { Project } from "../../types";
import { type Thread } from "../../types";
import { resolveCycledModelSlug } from "../ChatView.logic";
import { collectForegroundRunningSubagentStripItems } from "./ComposerSubagentStrip.logic";
import { eventTargetsInAppBrowser, shouldCaptureChatFindShortcut } from "./threadFind.logic";
import { useChatProjectScripts } from "./useChatProjectScripts";
import { useChatProviderModels } from "./useChatProviderModels";
import { useChatTerminalController } from "./useChatTerminalController";
import { useChatWorkLog } from "./useChatWorkLog";
import { useComposerVoiceController } from "./useComposerVoiceController";
import { toastManager } from "../ui/toast";
function eventTargetsComposer(
  event: globalThis.KeyboardEvent,
  composerForm: HTMLFormElement | null,
): boolean {
  if (!composerForm) return false;
  const target = event.target;
  return target instanceof Node ? composerForm.contains(target) : false;
}

// Escape-as-interrupt must stay out of open layers: dialogs, sheets, menus,
// and popovers all own their own Escape. Their popups unmount when closed, so
// presence in the DOM is enough.
const INTERRUPT_BLOCKING_OVERLAY_SELECTOR = [
  "[data-slot='dialog-popup']",
  "[data-slot='alert-dialog-popup']",
  "[data-slot='command-dialog-popup']",
  "[data-slot='sheet-popup']",
  "[data-slot='menu-popup']",
  "[data-slot='popover-popup']",
  "[data-slot='preview-card-popup']",
  "[data-slot='select-popup']",
  "[data-slot='combobox-popup']",
  "[data-slot='autocomplete-popup']",
  "[data-slot='context-menu-popup']",
  // Non-modal dialogs (DiffLineBlamePopover, SelectionNewChatComposer) own
  // their Escape too — the modal qualifier would let interrupt steal it.
  "[role='dialog']",
].join(", ");

function hasInterruptBlockingOverlayOpen(): boolean {
  return document.querySelector(INTERRUPT_BLOCKING_OVERLAY_SELECTOR) !== null;
}

// Composer focus is covered separately (the editor is contenteditable, which
// isEditableEventTarget would reject); everywhere else the event must land on
// a non-editable surface — body, the document root, or the transcript pane.
function eventTargetsInterruptibleChatSurface(
  event: globalThis.KeyboardEvent,
  composerForm: HTMLFormElement | null,
): boolean {
  if (eventTargetsComposer(event, composerForm)) return true;
  if (isEditableEventTarget(event)) return false;
  const target = event.target;
  if (!(target instanceof Element)) return false;
  return (
    target === document.body ||
    target === document.documentElement ||
    target.closest("[data-chat-scroll-container]") !== null
  );
}

function canHandleComposerPickerShortcut(
  event: globalThis.KeyboardEvent,
  composerForm: HTMLFormElement | null,
): boolean {
  if (!composerForm) return false;
  if (eventTargetsComposer(event, composerForm)) return true;
  const target = event.target;
  return (
    target === document.body ||
    target === document.documentElement ||
    document.activeElement === document.body ||
    document.activeElement === document.documentElement
  );
}
interface ChatKeyboardShortcutsInput {
  onToggleDevicePanel: (() => void) | undefined;
  onSplitSurface: (() => void) | undefined;
  surfaceMode: "single" | "split";
  isFocusedPane: boolean;
  activeThreadId: ThreadId | null;
  hasLiveTurn: boolean;
  /** The Stop control's visibility rule — Escape mirrors exactly that affordance. */
  canInterruptTurn: boolean;
  /** Interrupt already dispatched; Escape must not fire repeat interrupts. */
  isStoppingTurn: boolean;
  composerOverlayOpen: boolean;
  expandedImageOpen: boolean;
  composerFormRef: RefObject<HTMLFormElement | null>;
  onInterruptFromStopControl: () => void;
  composerSubagentStripItems: ReturnType<typeof useChatWorkLog>["composerSubagentStripItems"];
  onBackgroundAllForegroundSubagentStripItems: () => Promise<void>;
  isVoiceRecording: ReturnType<typeof useComposerVoiceController>["isVoiceRecording"];
  isVoiceTranscribing: ReturnType<typeof useComposerVoiceController>["isVoiceTranscribing"];
  isComposerApprovalState: boolean;
  terminalState: ReturnType<typeof useChatTerminalController>["terminalState"];
  terminalWorkspaceOpen: ReturnType<typeof useChatTerminalController>["terminalWorkspaceOpen"];
  terminalWorkspaceTerminalTabActive: ReturnType<
    typeof useChatTerminalController
  >["terminalWorkspaceTerminalTabActive"];
  terminalWorkspaceChatTabActive: ReturnType<
    typeof useChatTerminalController
  >["terminalWorkspaceChatTabActive"];
  keybindings: ResolvedKeybindingsConfig;
  toggleComposerFocus: () => void;
  shouldRenderChatPaneContent: boolean;
  setThreadFindOpen: Dispatch<SetStateAction<boolean>>;
  setThreadFindFocusNonce: Dispatch<SetStateAction<number>>;
  handleModelPickerOpenChange: (open: boolean) => void;
  scheduleComposerFocus: () => void;
  modelOptionsByProvider: ReturnType<typeof useChatProviderModels>["modelOptionsByProvider"];
  selectedProvider: ProviderKind;
  selectedModel: string;
  onProviderModelSelect: (provider: ProviderKind, model: ModelSlug) => Promise<void>;
  handleTraitsPickerOpenChange: (open: boolean) => void;
  toggleTerminalVisibility: ReturnType<
    typeof useChatTerminalController
  >["toggleTerminalVisibility"];
  setTerminalOpen: ReturnType<typeof useChatTerminalController>["setTerminalOpen"];
  splitTerminalRight: ReturnType<typeof useChatTerminalController>["splitTerminalRight"];
  splitTerminalLeft: ReturnType<typeof useChatTerminalController>["splitTerminalLeft"];
  splitTerminalDown: ReturnType<typeof useChatTerminalController>["splitTerminalDown"];
  splitTerminalUp: ReturnType<typeof useChatTerminalController>["splitTerminalUp"];
  closeTerminal: ReturnType<typeof useChatTerminalController>["closeTerminal"];
  createTerminalFromShortcut: ReturnType<
    typeof useChatTerminalController
  >["createTerminalFromShortcut"];
  openNewFullWidthTerminal: ReturnType<
    typeof useChatTerminalController
  >["openNewFullWidthTerminal"];
  closeActiveWorkspaceView: ReturnType<
    typeof useChatTerminalController
  >["closeActiveWorkspaceView"];
  setTerminalWorkspaceTab: ReturnType<typeof useChatTerminalController>["setTerminalWorkspaceTab"];
  onToggleDiff: () => void;
  commitAndPushTriggerRef: RefObject<(() => void) | null>;
  showGitActions: boolean;
  isGitRepo: boolean;
  onToggleBrowser: () => void;
  copyThreadIdToClipboard: (threadId: string) => void;
  activeProject: Project | undefined;
  runProjectScript: ReturnType<typeof useChatProjectScripts>["runProjectScript"];
  activeThread: Thread | undefined;
}

export function useChatKeyboardShortcuts({
  onToggleDevicePanel,
  onSplitSurface,
  surfaceMode,
  isFocusedPane,
  activeThreadId,
  hasLiveTurn,
  canInterruptTurn,
  isStoppingTurn,
  composerOverlayOpen,
  expandedImageOpen,
  composerFormRef,
  onInterruptFromStopControl,
  composerSubagentStripItems,
  onBackgroundAllForegroundSubagentStripItems,
  isVoiceRecording,
  isVoiceTranscribing,
  isComposerApprovalState,
  terminalState,
  terminalWorkspaceOpen,
  terminalWorkspaceTerminalTabActive,
  terminalWorkspaceChatTabActive,
  keybindings,
  toggleComposerFocus,
  shouldRenderChatPaneContent,
  setThreadFindOpen,
  setThreadFindFocusNonce,
  handleModelPickerOpenChange,
  scheduleComposerFocus,
  modelOptionsByProvider,
  selectedProvider,
  selectedModel,
  onProviderModelSelect,
  handleTraitsPickerOpenChange,
  toggleTerminalVisibility,
  setTerminalOpen,
  splitTerminalRight,
  splitTerminalLeft,
  splitTerminalDown,
  splitTerminalUp,
  closeTerminal,
  createTerminalFromShortcut,
  openNewFullWidthTerminal,
  closeActiveWorkspaceView,
  setTerminalWorkspaceTab,
  onToggleDiff,
  commitAndPushTriggerRef,
  showGitActions,
  isGitRepo,
  onToggleBrowser,
  copyThreadIdToClipboard,
  activeProject,
  runProjectScript,
  activeThread,
}: ChatKeyboardShortcutsInput) {
  useEffect(() => {
    if (surfaceMode === "split" && !isFocusedPane) {
      return;
    }

    const handler = (event: globalThis.KeyboardEvent) => {
      if (!activeThreadId || event.defaultPrevented) return;
      // Mirror terminal interrupt semantics without stealing regular copy shortcuts.
      if (
        hasLiveTurn &&
        !isStoppingTurn &&
        isMacNavigatorPlatform() &&
        event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "c" &&
        eventTargetsComposer(event, composerFormRef.current)
      ) {
        event.preventDefault();
        event.stopPropagation();
        onInterruptFromStopControl();
        return;
      }
      // Escape mirrors the Stop control: same visibility rule, no repeats while
      // a stop is in flight, and it stays out of overlays, the terminal, and
      // non-composer text inputs.
      if (
        event.key === "Escape" &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey &&
        !event.isComposing &&
        canInterruptTurn &&
        !isStoppingTurn &&
        !isComposerApprovalState &&
        !composerOverlayOpen &&
        !expandedImageOpen &&
        !isTerminalFocused() &&
        !hasInterruptBlockingOverlayOpen() &&
        eventTargetsInterruptibleChatSurface(event, composerFormRef.current)
      ) {
        event.preventDefault();
        event.stopPropagation();
        onInterruptFromStopControl();
        return;
      }
      // Ctrl+B mirrors the native CLI: background all foreground running
      // subagents. Literal Ctrl on every platform, but stays out of the
      // terminal, where Ctrl+B is real shell input (readline cursor-back,
      // tmux prefix), and out of text-editing surfaces, where Ctrl+B is the
      // native macOS "move cursor back" binding. Silent no-op (event
      // untouched) when nothing qualifies.
      if (
        event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "b" &&
        !isTerminalFocused() &&
        !isEditableEventTarget(event) &&
        collectForegroundRunningSubagentStripItems(composerSubagentStripItems).length > 0
      ) {
        event.preventDefault();
        event.stopPropagation();
        void onBackgroundAllForegroundSubagentStripItems();
        return;
      }
      const composerPickerShortcutActive =
        !isTerminalFocused() &&
        !isVoiceRecording &&
        !isVoiceTranscribing &&
        !isComposerApprovalState &&
        canHandleComposerPickerShortcut(event, composerFormRef.current);
      const shortcutContext = {
        terminalFocus: isTerminalFocused(),
        terminalOpen: Boolean(terminalState.terminalOpen),
        terminalWorkspaceOpen,
        terminalWorkspaceTerminalOnly: terminalState.workspaceLayout === "terminal-only",
        terminalWorkspaceTerminalTabActive,
        terminalWorkspaceChatTabActive,
      };

      const command = resolveShortcutCommand(event, keybindings, {
        context: shortcutContext,
      });
      if (!command) return;

      if (command === "composer.focus.toggle") {
        if (isComposerApprovalState || isVoiceRecording || isVoiceTranscribing) return;
        event.preventDefault();
        event.stopPropagation();
        toggleComposerFocus();
        return;
      }

      if (command === "chat.find") {
        if (
          !shouldCaptureChatFindShortcut({
            shouldRenderChatPaneContent,
            terminalWorkspaceTerminalTabActive,
            inAppBrowserFocused: eventTargetsInAppBrowser(event.target),
          })
        ) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        setThreadFindOpen(true);
        setThreadFindFocusNonce((current) => current + 1);
        return;
      }

      if (command === "modelPicker.toggle") {
        if (!composerPickerShortcutActive) return;
        event.preventDefault();
        event.stopPropagation();
        handleModelPickerOpenChange(true);
        scheduleComposerFocus();
        return;
      }

      if (command === "model.next" || command === "model.previous") {
        if (!composerPickerShortcutActive) return;
        event.preventDefault();
        event.stopPropagation();
        const direction = command === "model.next" ? "next" : "previous";
        const providerOptions = modelOptionsByProvider[selectedProvider] ?? [];
        const nextSlug = resolveCycledModelSlug({
          currentModel: selectedModel,
          options: providerOptions,
          favoriteSlugs: readStarredModelSlugs(selectedProvider),
          direction,
        });
        if (!nextSlug) return;
        onProviderModelSelect(selectedProvider, nextSlug as ModelSlug);
        return;
      }

      if (command === "traitsPicker.toggle") {
        if (!composerPickerShortcutActive) return;
        event.preventDefault();
        event.stopPropagation();
        handleTraitsPickerOpenChange(true);
        scheduleComposerFocus();
        return;
      }

      if (command === "terminal.toggle") {
        event.preventDefault();
        event.stopPropagation();
        toggleTerminalVisibility();
        return;
      }

      if (command === "terminal.split" || command === "terminal.splitRight") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) {
          setTerminalOpen(true);
        }
        splitTerminalRight();
        return;
      }

      if (command === "terminal.splitLeft") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) {
          setTerminalOpen(true);
        }
        splitTerminalLeft();
        return;
      }

      if (command === "terminal.splitDown") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) {
          setTerminalOpen(true);
        }
        splitTerminalDown();
        return;
      }

      if (command === "terminal.splitUp") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) {
          setTerminalOpen(true);
        }
        splitTerminalUp();
        return;
      }

      if (command === "terminal.close") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) return;
        closeTerminal(terminalState.activeTerminalId);
        return;
      }

      if (command === "terminal.new") {
        event.preventDefault();
        event.stopPropagation();
        createTerminalFromShortcut();
        return;
      }

      if (command === "terminal.workspace.newFullWidth") {
        event.preventDefault();
        event.stopPropagation();
        openNewFullWidthTerminal();
        return;
      }

      if (command === "terminal.workspace.closeActive") {
        event.preventDefault();
        event.stopPropagation();
        closeActiveWorkspaceView();
        return;
      }

      if (command === "terminal.workspace.terminal") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalWorkspaceOpen) return;
        setTerminalWorkspaceTab("terminal");
        return;
      }

      if (command === "terminal.workspace.chat") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalWorkspaceOpen) return;
        setTerminalWorkspaceTab("chat");
        return;
      }

      if (command === "diff.toggle") {
        event.preventDefault();
        event.stopPropagation();
        onToggleDiff();
        return;
      }

      if (command === "git.commitAndPush") {
        if (commitAndPushTriggerRef.current) {
          event.preventDefault();
          event.stopPropagation();
          commitAndPushTriggerRef.current();
          return;
        }
        // No registered trigger inside a git-enabled thread means the action just
        // isn't runnable right now (clean tree, behind upstream, action in flight)
        // — tell the user instead of eating the chord silently. Outside git threads
        // the chord falls through untouched.
        if (showGitActions && isGitRepo) {
          event.preventDefault();
          event.stopPropagation();
          toastManager.add({
            type: "info",
            title: "Nothing to commit or push.",
          });
        }
        return;
      }

      if (command === "browser.toggle") {
        event.preventDefault();
        event.stopPropagation();
        if (!isElectron) return;
        onToggleBrowser();
        return;
      }

      if (command === "device.toggle") {
        event.preventDefault();
        event.stopPropagation();
        // Unlike the browser this works in a plain tab, but only against a macOS
        // server; the surface leaves the handler unwired when it cannot host one.
        onToggleDevicePanel?.();
        return;
      }

      if (command === "chat.split") {
        event.preventDefault();
        event.stopPropagation();
        if (surfaceMode === "single" && onSplitSurface) {
          onSplitSurface();
        }
        return;
      }

      // The handler already bailed out when no thread is open, so the active thread id
      // is always the one the user is looking at (the focused pane when split).
      if (command === "thread.copyId") {
        event.preventDefault();
        event.stopPropagation();
        copyThreadIdToClipboard(activeThreadId);
        return;
      }

      const scriptId = projectScriptIdFromCommand(command);
      if (!scriptId || !activeProject) return;
      const script = activeProject.scripts.find((entry) => entry.id === scriptId);
      if (!script) return;
      event.preventDefault();
      event.stopPropagation();
      void runProjectScript(script);
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () => window.removeEventListener("keydown", handler, { capture: true });
  }, [
    composerFormRef,
    setThreadFindOpen,
    setThreadFindFocusNonce,
    commitAndPushTriggerRef,
    activeProject,
    terminalState.terminalOpen,
    terminalState.activeTerminalId,
    terminalState.workspaceLayout,
    activeThreadId,
    closeTerminal,
    closeActiveWorkspaceView,
    createTerminalFromShortcut,
    setTerminalOpen,
    openNewFullWidthTerminal,
    runProjectScript,
    keybindings,
    splitTerminalDown,
    splitTerminalLeft,
    splitTerminalRight,
    splitTerminalUp,
    terminalWorkspaceChatTabActive,
    terminalWorkspaceOpen,
    terminalWorkspaceTerminalTabActive,
    onToggleBrowser,
    onToggleDevicePanel,
    onToggleDiff,
    onInterruptFromStopControl,
    canInterruptTurn,
    isStoppingTurn,
    composerOverlayOpen,
    expandedImageOpen,
    onSplitSurface,
    showGitActions,
    isGitRepo,
    composerSubagentStripItems,
    onBackgroundAllForegroundSubagentStripItems,
    isFocusedPane,
    hasLiveTurn,
    handleModelPickerOpenChange,
    handleTraitsPickerOpenChange,
    shouldRenderChatPaneContent,
    isComposerApprovalState,
    isVoiceRecording,
    isVoiceTranscribing,
    setTerminalWorkspaceTab,
    surfaceMode,
    scheduleComposerFocus,
    toggleComposerFocus,
    toggleTerminalVisibility,
    activeThread,
    selectedProvider,
    selectedModel,
    modelOptionsByProvider,
    onProviderModelSelect,
    copyThreadIdToClipboard,
  ]);
}
