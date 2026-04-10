// FILE: terminalRuntime.ts
// Purpose: Own the long-lived xterm runtime lifecycle behind the terminal runtime registry.
// Layer: Terminal runtime infrastructure

import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { ImageAddon } from "@xterm/addon-image";
import { LigaturesAddon } from "@xterm/addon-ligatures";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import {
  consumeTerminalIdentityInput,
  deriveTerminalOutputIdentity,
} from "@t3tools/shared/terminalThreads";
import { Terminal } from "@xterm/xterm";

import { readNativeApi } from "~/nativeApi";
import { suppressQueryResponses } from "~/lib/suppressQueryResponses";

import { openInPreferredEditor } from "../../editorPreferences";
import { isTerminalClearShortcut, terminalNavigationShortcutData } from "../../keybindings";
import {
  extractTerminalLinks,
  isTerminalLinkActivation,
  resolvePathLinkTarget,
} from "../../terminal-links";
import {
  getTerminalFontFamily,
  terminalThemeFromApp,
  writeSystemMessage,
} from "./terminalRuntimeAppearance";
import { terminalEventDispatcher } from "./terminalEventDispatcher";
import type {
  TerminalRuntimeConfig,
  TerminalRuntimeEntry,
  TerminalRuntimeViewState,
} from "./terminalRuntimeTypes";

const ENABLE_TERMINAL_WEBGL = true;
const VISUAL_RESIZE_MIN_INTERVAL_MS = 64;
const BACKEND_RESIZE_DEBOUNCE_MS = 120;
const WRITE_BATCH_SIZE_LIMIT = 262_144;
const WRITE_BATCH_MAX_LATENCY_MS = 50;

// Once WebGL fails, skip it for subsequent terminals in this renderer process.
let suggestedRendererType: "webgl" | "dom" | undefined;

function clearBackendResizeTimer(entry: TerminalRuntimeEntry): void {
  if (entry.resizeDispatchTimer !== null) {
    window.clearTimeout(entry.resizeDispatchTimer);
    entry.resizeDispatchTimer = null;
  }
}

function clearPendingWrites(entry: TerminalRuntimeEntry): void {
  if (entry.writeRafHandle !== null) {
    window.cancelAnimationFrame(entry.writeRafHandle);
    entry.writeRafHandle = null;
  }
  if (entry.writeFlushTimeout !== null) {
    window.clearTimeout(entry.writeFlushTimeout);
    entry.writeFlushTimeout = null;
  }
  entry.pendingWrites.length = 0;
  entry.pendingWriteLength = 0;
}

function clearDeferredWrites(entry: TerminalRuntimeEntry): void {
  entry.deferredWrites.length = 0;
  entry.deferredWriteLength = 0;
}

function flushPendingWrites(entry: TerminalRuntimeEntry): void {
  if (entry.writeRafHandle !== null) {
    window.cancelAnimationFrame(entry.writeRafHandle);
    entry.writeRafHandle = null;
  }
  if (entry.writeFlushTimeout !== null) {
    window.clearTimeout(entry.writeFlushTimeout);
    entry.writeFlushTimeout = null;
  }
  if (entry.pendingWrites.length === 0) {
    entry.pendingWriteLength = 0;
    return;
  }
  const combined = entry.pendingWrites.join("");
  entry.pendingWrites.length = 0;
  entry.pendingWriteLength = 0;
  entry.terminal.write(combined);
}

function deferWrite(entry: TerminalRuntimeEntry, data: string): void {
  entry.deferredWrites.push(data);
  entry.deferredWriteLength += data.length;
}

function flushDeferredWrites(entry: TerminalRuntimeEntry): void {
  if (entry.deferredWrites.length === 0) {
    entry.deferredWriteLength = 0;
    return;
  }

  const combined = entry.deferredWrites.join("");
  clearDeferredWrites(entry);
  scheduleWrite(entry, combined);
}

function scheduleWrite(entry: TerminalRuntimeEntry, data: string): void {
  entry.pendingWrites.push(data);
  entry.pendingWriteLength += data.length;

  if (entry.pendingWriteLength >= WRITE_BATCH_SIZE_LIMIT) {
    flushPendingWrites(entry);
    return;
  }

  if (entry.writeRafHandle === null) {
    entry.writeRafHandle = window.requestAnimationFrame(() => {
      entry.writeRafHandle = null;
      flushPendingWrites(entry);
    });
  }
  if (entry.writeFlushTimeout === null) {
    entry.writeFlushTimeout = window.setTimeout(() => {
      entry.writeFlushTimeout = null;
      flushPendingWrites(entry);
    }, WRITE_BATCH_MAX_LATENCY_MS);
  }
}

function flushPendingResize(entry: TerminalRuntimeEntry): void {
  const api = readNativeApi();
  const pendingResize = entry.pendingResize;
  if (!api || !pendingResize) return;

  entry.pendingResize = null;
  entry.lastSentResize = pendingResize;
  void api.terminal
    .resize({
      threadId: entry.threadId,
      terminalId: entry.terminalId,
      cols: pendingResize.cols,
      rows: pendingResize.rows,
    })
    .catch(() => {
      const current = entry.lastSentResize;
      if (current && current.cols === pendingResize.cols && current.rows === pendingResize.rows) {
        entry.lastSentResize = null;
      }
    });
}

function queueBackendResize(entry: TerminalRuntimeEntry, cols: number, rows: number): void {
  const lastSentResize = entry.lastSentResize;
  const pendingResize = entry.pendingResize;
  if (
    (lastSentResize && lastSentResize.cols === cols && lastSentResize.rows === rows) ||
    (pendingResize && pendingResize.cols === cols && pendingResize.rows === rows)
  ) {
    return;
  }
  entry.pendingResize = { cols, rows };
  clearBackendResizeTimer(entry);
  entry.resizeDispatchTimer = window.setTimeout(() => {
    entry.resizeDispatchTimer = null;
    flushPendingResize(entry);
  }, BACKEND_RESIZE_DEBOUNCE_MS);
}

function runTerminalResize(
  entry: TerminalRuntimeEntry,
  options?: { clearTextureAtlas?: boolean; refresh?: boolean; dispatchBackend?: boolean },
): void {
  if (!entry.container || !entry.viewState.isVisible) return;

  const { clearTextureAtlas = false, refresh = false, dispatchBackend = true } = options ?? {};
  const wasAtBottom = entry.terminal.buffer.active.viewportY >= entry.terminal.buffer.active.baseY;

  if (clearTextureAtlas) {
    (
      entry.webglAddon as unknown as {
        clearTextureAtlas?: () => void;
      } | null
    )?.clearTextureAtlas?.();
  }

  entry.fitAddon.fit();
  if (wasAtBottom) {
    entry.terminal.scrollToBottom();
  }
  if (dispatchBackend) {
    queueBackendResize(entry, entry.terminal.cols, entry.terminal.rows);
  }
  if (refresh) {
    entry.terminal.refresh(0, Math.max(0, entry.terminal.rows - 1));
  }
}

function cancelScheduledVisualResize(entry: TerminalRuntimeEntry): void {
  if (entry.visualResizeFrame !== null) {
    window.cancelAnimationFrame(entry.visualResizeFrame);
    entry.visualResizeFrame = null;
  }
  if (entry.visualResizeTimer !== null) {
    window.clearTimeout(entry.visualResizeTimer);
    entry.visualResizeTimer = null;
  }
}

function scheduleVisualResize(entry: TerminalRuntimeEntry): void {
  if (!entry.viewState.isVisible || entry.visualResizeTimer !== null) {
    return;
  }

  const now = Date.now();
  const remaining = Math.max(0, VISUAL_RESIZE_MIN_INTERVAL_MS - (now - entry.lastVisualResizeAt));

  const run = () => {
    entry.visualResizeTimer = null;
    if (entry.visualResizeFrame !== null) {
      window.cancelAnimationFrame(entry.visualResizeFrame);
    }
    entry.visualResizeFrame = window.requestAnimationFrame(() => {
      entry.visualResizeFrame = null;
      entry.lastVisualResizeAt = Date.now();
      runTerminalResize(entry);
    });
  };

  if (remaining === 0) {
    run();
    return;
  }

  entry.visualResizeTimer = window.setTimeout(run, remaining);
}

function startVisibilityRecovery(entry: TerminalRuntimeEntry): void {
  if (!entry.container || !entry.viewState.isVisible || entry.visibilityCleanup) {
    return;
  }

  let recoveryFrame = 0;
  let throttleTimer: number | null = null;
  let lastRunAt = 0;
  const RECOVERY_THROTTLE_MS = 120;

  const runRecovery = () => {
    const mount = entry.container;
    if (!mount) return;
    if (!mount.isConnected) return;

    const style = window.getComputedStyle(mount);
    if (style.display === "none" || style.visibility === "hidden") {
      return;
    }
    const rect = mount.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) {
      return;
    }

    cancelScheduledVisualResize(entry);
    entry.lastVisualResizeAt = Date.now();
    runTerminalResize(entry, {
      clearTextureAtlas: true,
      refresh: true,
    });
  };

  const scheduleRecovery = () => {
    if (recoveryFrame !== 0) return;

    recoveryFrame = window.requestAnimationFrame(() => {
      recoveryFrame = 0;
      const now = Date.now();
      if (now - lastRunAt < RECOVERY_THROTTLE_MS) {
        const remaining = RECOVERY_THROTTLE_MS - (now - lastRunAt);
        if (throttleTimer !== null) {
          window.clearTimeout(throttleTimer);
        }
        throttleTimer = window.setTimeout(() => {
          throttleTimer = null;
          scheduleRecovery();
        }, remaining + 1);
        return;
      }
      lastRunAt = now;
      runRecovery();
    });
  };

  const handleVisibilityChange = () => {
    if (document.hidden) return;
    scheduleRecovery();
  };
  const handleWindowFocus = () => {
    scheduleRecovery();
  };

  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("focus", handleWindowFocus);
  entry.visibilityCleanup = () => {
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    window.removeEventListener("focus", handleWindowFocus);
    if (recoveryFrame !== 0) {
      window.cancelAnimationFrame(recoveryFrame);
    }
    if (throttleTimer !== null) {
      window.clearTimeout(throttleTimer);
    }
    entry.visibilityCleanup = null;
  };
}

function stopVisibilityRecovery(entry: TerminalRuntimeEntry): void {
  entry.visibilityCleanup?.();
  entry.visibilityCleanup = null;
}

function syncTheme(entry: TerminalRuntimeEntry): void {
  const nextTheme = terminalThemeFromApp();
  const nextThemeKey = JSON.stringify(nextTheme);
  const previousThemeKey = (entry.wrapper.dataset.themeKey ?? "") as string;
  if (nextThemeKey === previousThemeKey) {
    return;
  }
  entry.wrapper.dataset.themeKey = nextThemeKey;
  entry.terminal.options.theme = nextTheme;
  entry.terminal.options.fontFamily = getTerminalFontFamily();
  if (entry.viewState.isVisible) {
    runTerminalResize(entry, { refresh: true });
  } else {
    entry.terminal.refresh(0, Math.max(0, entry.terminal.rows - 1));
  }
}

function cancelPendingWebglLoad(entry: TerminalRuntimeEntry): void {
  if (entry.webglLoadFrame !== null) {
    window.cancelAnimationFrame(entry.webglLoadFrame);
    entry.webglLoadFrame = null;
  }
}

function disposeWebglAddon(entry: TerminalRuntimeEntry): void {
  cancelPendingWebglLoad(entry);
  entry.webglAddon?.dispose();
  entry.webglAddon = null;
}

function maybeLoadWebglAddon(entry: TerminalRuntimeEntry): void {
  if (
    entry.disposed ||
    !ENABLE_TERMINAL_WEBGL ||
    suggestedRendererType === "dom" ||
    entry.webglAddon !== null ||
    entry.webglLoadFrame !== null ||
    !entry.viewState.isVisible
  ) {
    return;
  }

  entry.webglLoadFrame = window.requestAnimationFrame(() => {
    entry.webglLoadFrame = null;
    if (
      entry.disposed ||
      !ENABLE_TERMINAL_WEBGL ||
      suggestedRendererType === "dom" ||
      entry.webglAddon !== null ||
      !entry.viewState.isVisible
    ) {
      return;
    }

    try {
      const nextWebglAddon = new WebglAddon();
      nextWebglAddon.onContextLoss(() => {
        nextWebglAddon.dispose();
        if (entry.webglAddon === nextWebglAddon) {
          entry.webglAddon = null;
        }
        entry.terminal.refresh(0, Math.max(0, entry.terminal.rows - 1));
      });
      entry.terminal.loadAddon(nextWebglAddon);
      entry.webglAddon = nextWebglAddon;
    } catch {
      suggestedRendererType = "dom";
      entry.webglAddon = null;
    }
  });
}

function maybePromoteTerminalIdentityFromOutput(entry: TerminalRuntimeEntry, output: string): void {
  if (entry.terminalCliKind !== null) {
    return;
  }
  const nextOutputBuffer = `${entry.outputIdentityBuffer}${output}`;
  const outputIdentity =
    deriveTerminalOutputIdentity(output) ?? deriveTerminalOutputIdentity(nextOutputBuffer);
  entry.outputIdentityBuffer = nextOutputBuffer.slice(-8192);
  if (!outputIdentity?.cliKind) {
    return;
  }
  entry.terminalCliKind = outputIdentity.cliKind;
  entry.callbacks.onTerminalMetadataChange(entry.terminalId, {
    cliKind: outputIdentity.cliKind,
    label: outputIdentity.title,
  });
}

function applyInitialVisualResize(entry: TerminalRuntimeEntry): void {
  if (!entry.viewState.isVisible) return;

  let firstFrame = 0;
  let secondFrame = 0;

  firstFrame = window.requestAnimationFrame(() => {
    cancelScheduledVisualResize(entry);
    entry.lastVisualResizeAt = Date.now();
    runTerminalResize(entry, {
      clearTextureAtlas: true,
      refresh: true,
    });

    secondFrame = window.requestAnimationFrame(() => {
      entry.lastVisualResizeAt = Date.now();
      runTerminalResize(entry, { refresh: true });
    });
  });

  entry.attachDisposables.push(() => {
    if (firstFrame !== 0) {
      window.cancelAnimationFrame(firstFrame);
    }
    if (secondFrame !== 0) {
      window.cancelAnimationFrame(secondFrame);
    }
  });
}

function ensureResizeObserver(entry: TerminalRuntimeEntry): void {
  if (!entry.container || !entry.viewState.isVisible || entry.resizeObserver) {
    return;
  }

  let frame = 0;
  const observer = new ResizeObserver(() => {
    if (frame !== 0) {
      window.cancelAnimationFrame(frame);
    }
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      scheduleVisualResize(entry);
    });
  });

  observer.observe(entry.container);
  entry.resizeObserver = observer;
  entry.attachDisposables.push(() => {
    observer.disconnect();
    if (frame !== 0) {
      window.cancelAnimationFrame(frame);
    }
    if (entry.resizeObserver === observer) {
      entry.resizeObserver = null;
    }
  });
}

function clearAttachDisposables(entry: TerminalRuntimeEntry): void {
  const disposables = [...entry.attachDisposables];
  entry.attachDisposables.length = 0;
  for (const dispose of disposables) {
    dispose();
  }
  entry.resizeObserver = null;
}

async function sendTerminalInput(
  entry: TerminalRuntimeEntry,
  data: string,
  fallbackError: string,
): Promise<void> {
  const api = readNativeApi();
  if (!api) return;
  try {
    await api.terminal.write({ threadId: entry.threadId, terminalId: entry.terminalId, data });
  } catch (error) {
    writeSystemMessage(entry.terminal, error instanceof Error ? error.message : fallbackError);
  }
}

export function syncRuntimeConfig(
  entry: TerminalRuntimeEntry,
  config: TerminalRuntimeConfig,
): void {
  entry.runtimeKey = config.runtimeKey;
  entry.threadId = config.threadId;
  entry.terminalId = config.terminalId;
  entry.terminalLabel = config.terminalLabel;
  entry.terminalCliKind = config.terminalCliKind ?? entry.terminalCliKind ?? null;
  entry.cwd = config.cwd;
  if (config.runtimeEnv === undefined) {
    delete entry.runtimeEnv;
  } else {
    entry.runtimeEnv = config.runtimeEnv;
  }
  entry.callbacks = config.callbacks;
}

export function createRuntimeEntry(config: TerminalRuntimeConfig): TerminalRuntimeEntry {
  const wrapper = document.createElement("div");
  wrapper.className = "h-full w-full";

  const fitAddon = new FitAddon();
  const clipboardAddon = new ClipboardAddon();
  const imageAddon = new ImageAddon();
  const searchAddon = new SearchAddon();
  const unicode11Addon = new Unicode11Addon();
  const terminal = new Terminal({
    cursorBlink: true,
    fontSize: 12,
    scrollback: 5_000,
    fontFamily: getTerminalFontFamily(),
    theme: terminalThemeFromApp(),
    allowProposedApi: true,
    customGlyphs: true,
    macOptionIsMeta: false,
    cursorStyle: "block",
    cursorInactiveStyle: "outline",
    screenReaderMode: false,
  });
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(clipboardAddon);
  terminal.loadAddon(imageAddon);
  terminal.loadAddon(searchAddon);
  terminal.loadAddon(unicode11Addon);
  terminal.unicode.activeVersion = "11";
  try {
    terminal.loadAddon(new LigaturesAddon());
  } catch {
    // Keep terminal startup resilient when the active font doesn't support ligatures.
  }
  terminal.open(wrapper);

  const entry: TerminalRuntimeEntry = {
    runtimeKey: config.runtimeKey,
    threadId: config.threadId,
    terminalId: config.terminalId,
    terminalLabel: config.terminalLabel,
    terminalCliKind: config.terminalCliKind ?? null,
    cwd: config.cwd,
    callbacks: config.callbacks,
    wrapper,
    container: null,
    terminal,
    fitAddon,
    searchAddon,
    webglAddon: null,
    outputIdentityBuffer: "",
    titleInputBuffer: "",
    hasHandledExit: false,
    opened: false,
    disposed: false,
    resizeObserver: null,
    resizeDispatchTimer: null,
    visualResizeFrame: null,
    visualResizeTimer: null,
    lastVisualResizeAt: 0,
    lastSentResize: null,
    pendingResize: null,
    writeRafHandle: null,
    writeFlushTimeout: null,
    pendingWrites: [],
    pendingWriteLength: 0,
    deferredWrites: [],
    deferredWriteLength: 0,
    webglLoadFrame: null,
    themeRefreshFrame: 0,
    themeObserver: null,
    visibilityCleanup: null,
    terminalDisposables: [],
    attachDisposables: [],
    persistentDisposables: [],
    querySuppressionDispose: null,
    viewState: {
      autoFocus: false,
      isVisible: false,
    },
    unsubscribeTerminalEvents: null,
  };
  if (config.runtimeEnv !== undefined) {
    entry.runtimeEnv = config.runtimeEnv;
  }

  entry.querySuppressionDispose = suppressQueryResponses(terminal);

  const handleCopy = (event: ClipboardEvent) => {
    const selection = terminal.getSelection();
    if (!selection) return;
    const trimmed = selection.replace(/[^\S\n]+$/gm, "");
    if (trimmed === selection) return;

    if (event.clipboardData) {
      event.preventDefault();
      event.clipboardData.setData("text/plain", trimmed);
      return;
    }

    void navigator.clipboard?.writeText(trimmed).catch(() => undefined);
  };
  wrapper.addEventListener("copy", handleCopy);
  entry.persistentDisposables.push(() => {
    wrapper.removeEventListener("copy", handleCopy);
  });

  terminal.attachCustomKeyEventHandler((event) => {
    if (
      event.type === "keydown" &&
      event.key === "Enter" &&
      event.shiftKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      event.preventDefault();
      event.stopPropagation();
      void sendTerminalInput(entry, "\n", "Failed to insert newline");
      return false;
    }

    if (
      event.type === "keydown" &&
      event.key.toLowerCase() === "f" &&
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      !event.shiftKey
    ) {
      return true;
    }

    const navigationData = terminalNavigationShortcutData(event);
    if (navigationData !== null) {
      event.preventDefault();
      event.stopPropagation();
      void sendTerminalInput(entry, navigationData, "Failed to move cursor");
      return false;
    }

    if (!isTerminalClearShortcut(event)) return true;
    event.preventDefault();
    event.stopPropagation();
    void sendTerminalInput(entry, "\u000c", "Failed to clear terminal");
    return false;
  });

  entry.terminalDisposables.push(
    terminal.registerLinkProvider({
      provideLinks: (bufferLineNumber, callback) => {
        const line = terminal.buffer.active.getLine(bufferLineNumber - 1);
        if (!line) {
          callback(undefined);
          return;
        }

        const lineText = line.translateToString(true);
        const matches = extractTerminalLinks(lineText);
        if (matches.length === 0) {
          callback(undefined);
          return;
        }

        callback(
          matches.map((match) => ({
            text: match.text,
            range: {
              start: { x: match.start + 1, y: bufferLineNumber },
              end: { x: match.end, y: bufferLineNumber },
            },
            activate: (event: MouseEvent) => {
              if (!isTerminalLinkActivation(event)) return;
              const api = readNativeApi();
              if (!api) return;

              if (match.kind === "url") {
                void api.shell.openExternal(match.text).catch((error) => {
                  writeSystemMessage(
                    terminal,
                    error instanceof Error ? error.message : "Unable to open link",
                  );
                });
                return;
              }

              const target = resolvePathLinkTarget(match.text, entry.cwd);
              void openInPreferredEditor(api, target).catch((error) => {
                writeSystemMessage(
                  terminal,
                  error instanceof Error ? error.message : "Unable to open path",
                );
              });
            },
          })),
        );
      },
    }),
  );

  entry.terminalDisposables.push(
    terminal.onData((data) => {
      const nextIdentityState = consumeTerminalIdentityInput(entry.titleInputBuffer, data);
      entry.titleInputBuffer = nextIdentityState.buffer;
      if (nextIdentityState.identity?.cliKind && entry.terminalCliKind === null) {
        entry.terminalCliKind = nextIdentityState.identity.cliKind;
        entry.callbacks.onTerminalMetadataChange(entry.terminalId, {
          cliKind: nextIdentityState.identity.cliKind,
          label: nextIdentityState.identity.title,
        });
      }
      const api = readNativeApi();
      if (!api) return;
      void api.terminal
        .write({ threadId: entry.threadId, terminalId: entry.terminalId, data })
        .catch((error) =>
          writeSystemMessage(
            terminal,
            error instanceof Error ? error.message : "Terminal write failed",
          ),
        );
    }),
  );

  entry.themeObserver = new MutationObserver(() => {
    if (entry.themeRefreshFrame !== 0) return;
    entry.themeRefreshFrame = window.requestAnimationFrame(() => {
      entry.themeRefreshFrame = 0;
      syncTheme(entry);
    });
  });
  entry.themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style"],
  });

  entry.unsubscribeTerminalEvents = terminalEventDispatcher.subscribe(
    entry.threadId,
    entry.terminalId,
    (event) => {
      if (event.type === "output") {
        maybePromoteTerminalIdentityFromOutput(entry, event.data);
        if (entry.viewState.isVisible) {
          flushDeferredWrites(entry);
          scheduleWrite(entry, event.data);
        } else {
          deferWrite(entry, event.data);
        }
        return;
      }

      if (event.type === "started" || event.type === "restarted") {
        entry.hasHandledExit = false;
        entry.titleInputBuffer = "";
        entry.outputIdentityBuffer = "";
        clearPendingWrites(entry);
        clearDeferredWrites(entry);
        terminal.write("\u001bc");
        if (event.snapshot.history.length > 0) {
          maybePromoteTerminalIdentityFromOutput(entry, event.snapshot.history);
          terminal.write(event.snapshot.history);
        }
        return;
      }

      if (event.type === "cleared") {
        entry.titleInputBuffer = "";
        entry.outputIdentityBuffer = "";
        clearPendingWrites(entry);
        clearDeferredWrites(entry);
        terminal.clear();
        terminal.write("\u001bc");
        return;
      }

      if (event.type === "error") {
        writeSystemMessage(terminal, event.message);
        return;
      }

      if (event.type === "exited") {
        flushPendingWrites(entry);
        const details = [
          typeof event.exitCode === "number" ? `code ${event.exitCode}` : null,
          typeof event.exitSignal === "number" ? `signal ${event.exitSignal}` : null,
        ]
          .filter((value): value is string => value !== null)
          .join(", ");
        writeSystemMessage(
          terminal,
          details.length > 0 ? `Process exited (${details})` : "Process exited",
        );
        if (entry.hasHandledExit) {
          return;
        }
        entry.hasHandledExit = true;
        window.setTimeout(() => {
          if (!entry.hasHandledExit) {
            return;
          }
          entry.callbacks.onSessionExited();
        }, 0);
      }
    },
  );

  return entry;
}

function openTerminal(entry: TerminalRuntimeEntry): void {
  const api = readNativeApi();
  if (!api || entry.opened) return;

  entry.fitAddon.fit();
  entry.lastSentResize = null;
  entry.opened = true;

  void api.terminal
    .open({
      threadId: entry.threadId,
      terminalId: entry.terminalId,
      cwd: entry.cwd,
      cols: entry.terminal.cols,
      rows: entry.terminal.rows,
      ...(entry.runtimeEnv ? { env: entry.runtimeEnv } : {}),
    })
    .then((snapshot) => {
      if (entry.disposed) return;
      entry.terminal.write("\u001bc");
      if (snapshot.history.length > 0) {
        maybePromoteTerminalIdentityFromOutput(entry, snapshot.history);
        entry.terminal.write(snapshot.history);
      }
      if (entry.viewState.autoFocus) {
        window.requestAnimationFrame(() => {
          entry.terminal.focus();
        });
      }
    })
    .catch((error) => {
      if (entry.disposed) return;
      entry.opened = false;
      writeSystemMessage(
        entry.terminal,
        error instanceof Error ? error.message : "Failed to open terminal",
      );
    });
}

export function attachRuntimeToContainer(
  entry: TerminalRuntimeEntry,
  viewState: TerminalRuntimeViewState,
  container: HTMLDivElement,
): void {
  if (entry.container !== container) {
    detachRuntimeFromContainer(entry);
    entry.container = container;
    container.append(entry.wrapper);
  }

  updateRuntimeViewState(entry, viewState);
  maybeLoadWebglAddon(entry);
  ensureResizeObserver(entry);
  startVisibilityRecovery(entry);
  openTerminal(entry);
}

export function updateRuntimeViewState(
  entry: TerminalRuntimeEntry,
  nextViewState: TerminalRuntimeViewState,
): void {
  const wasVisible = entry.viewState.isVisible;
  entry.viewState = nextViewState;

  if (entry.container) {
    if (nextViewState.isVisible && !wasVisible) {
      maybeLoadWebglAddon(entry);
      flushDeferredWrites(entry);
      applyInitialVisualResize(entry);
      ensureResizeObserver(entry);
      startVisibilityRecovery(entry);
    } else if (!nextViewState.isVisible && wasVisible) {
      cancelScheduledVisualResize(entry);
      stopVisibilityRecovery(entry);
      disposeWebglAddon(entry);
      clearAttachDisposables(entry);
    }
  }

  if (nextViewState.autoFocus) {
    window.requestAnimationFrame(() => {
      entry.terminal.focus();
    });
  }
}

export function detachRuntimeFromContainer(entry: TerminalRuntimeEntry): void {
  cancelScheduledVisualResize(entry);
  stopVisibilityRecovery(entry);
  disposeWebglAddon(entry);
  clearAttachDisposables(entry);
  clearBackendResizeTimer(entry);
  entry.pendingResize = null;
  entry.lastSentResize = null;
  entry.lastVisualResizeAt = 0;
  entry.wrapper.remove();
  entry.container = null;
}

export function disposeRuntimeEntry(entry: TerminalRuntimeEntry): void {
  detachRuntimeFromContainer(entry);
  entry.disposed = true;
  flushPendingWrites(entry);
  clearDeferredWrites(entry);
  entry.unsubscribeTerminalEvents?.();
  entry.unsubscribeTerminalEvents = null;
  entry.querySuppressionDispose?.();
  entry.querySuppressionDispose = null;
  if (entry.themeRefreshFrame !== 0) {
    window.cancelAnimationFrame(entry.themeRefreshFrame);
    entry.themeRefreshFrame = 0;
  }
  entry.themeObserver?.disconnect();
  entry.themeObserver = null;
  for (const disposable of entry.terminalDisposables) {
    disposable.dispose();
  }
  entry.terminalDisposables.length = 0;
  for (const dispose of entry.persistentDisposables) {
    dispose();
  }
  entry.persistentDisposables.length = 0;
  disposeWebglAddon(entry);
  entry.terminal.dispose();
}
