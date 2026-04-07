import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { ImageAddon } from "@xterm/addon-image";
import { LigaturesAddon } from "@xterm/addon-ligatures";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import {
  Maximize2,
  Minimize2,
  Plus,
  SquareSplitHorizontal,
  TerminalSquare,
  Trash2,
  XIcon,
} from "~/lib/icons";
import { type ThreadId } from "@t3tools/contracts";
import { Terminal, type ITheme } from "@xterm/xterm";
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { type TerminalContextSelection } from "~/lib/terminalContext";
import { openInPreferredEditor } from "../editorPreferences";
import {
  extractTerminalLinks,
  isTerminalLinkActivation,
  resolvePathLinkTarget,
} from "../terminal-links";
import { isTerminalClearShortcut, terminalNavigationShortcutData } from "../keybindings";
import {
  DEFAULT_THREAD_TERMINAL_HEIGHT,
  DEFAULT_THREAD_TERMINAL_ID,
  MAX_TERMINALS_PER_GROUP,
  type ThreadTerminalGroup,
  type ThreadTerminalPresentationMode,
} from "../types";
import { readNativeApi } from "~/nativeApi";
import { cn } from "~/lib/utils";
import { suppressQueryResponses } from "~/lib/suppressQueryResponses";
import { TerminalSearch } from "./TerminalSearch";
import { TerminalScrollToBottom } from "./TerminalScrollToBottom";

const MIN_DRAWER_HEIGHT = 180;
const MAX_DRAWER_HEIGHT_RATIO = 0.75;
const MULTI_CLICK_SELECTION_ACTION_DELAY_MS = 260;
const FALLBACK_MONO_FONT_FAMILY =
  '"JetBrainsMono NFM", "JetBrainsMono NF", "JetBrains Mono", monospace';
// Once WebGL fails, skip it for subsequent terminals in this renderer process.
let suggestedRendererType: "webgl" | "dom" | undefined;
const ENABLE_TERMINAL_WEBGL = true;
const VISUAL_RESIZE_MIN_INTERVAL_MS = 64;
const BACKEND_RESIZE_DEBOUNCE_MS = 120;
const WRITE_BATCH_SIZE_LIMIT = 262_144;
const WRITE_BATCH_MAX_LATENCY_MS = 50;

function getTerminalFontFamily(): string {
  if (typeof window === "undefined") {
    return FALLBACK_MONO_FONT_FAMILY;
  }

  const configuredFontFamily = getComputedStyle(document.documentElement)
    .getPropertyValue("--terminal-font-family")
    .trim();
  return configuredFontFamily || FALLBACK_MONO_FONT_FAMILY;
}

function maxDrawerHeight(): number {
  if (typeof window === "undefined") return DEFAULT_THREAD_TERMINAL_HEIGHT;
  return Math.max(MIN_DRAWER_HEIGHT, Math.floor(window.innerHeight * MAX_DRAWER_HEIGHT_RATIO));
}

function clampDrawerHeight(height: number): number {
  const safeHeight = Number.isFinite(height) ? height : DEFAULT_THREAD_TERMINAL_HEIGHT;
  const maxHeight = maxDrawerHeight();
  return Math.min(Math.max(Math.round(safeHeight), MIN_DRAWER_HEIGHT), maxHeight);
}

function writeSystemMessage(terminal: Terminal, message: string): void {
  terminal.write(`\r\n[terminal] ${message}\r\n`);
}

// Resolve the actual app surface colors from CSS tokens because the document body stays transparent.
function resolveTerminalSurfaceColors(): { background: string; foreground: string } {
  const isDark = document.documentElement.classList.contains("dark");
  const probe = document.createElement("div");
  probe.style.position = "fixed";
  probe.style.pointerEvents = "none";
  probe.style.opacity = "0";
  probe.style.backgroundColor = "var(--background)";
  probe.style.color = "var(--foreground)";
  document.body.append(probe);

  const computedProbeStyles = getComputedStyle(probe);
  const background = computedProbeStyles.backgroundColor;
  const foreground = computedProbeStyles.color;
  probe.remove();

  return {
    background: background || (isDark ? "rgb(14, 18, 24)" : "rgb(255, 255, 255)"),
    foreground: foreground || (isDark ? "rgb(237, 241, 247)" : "rgb(28, 33, 41)"),
  };
}

function terminalThemeFromApp(): ITheme {
  const isDark = document.documentElement.classList.contains("dark");
  const { background, foreground } = resolveTerminalSurfaceColors();

  if (isDark) {
    return {
      background,
      foreground,
      cursor: "rgb(180, 203, 255)",
      selectionBackground: "rgba(180, 203, 255, 0.25)",
      scrollbarSliderBackground: "rgba(255, 255, 255, 0.1)",
      scrollbarSliderHoverBackground: "rgba(255, 255, 255, 0.18)",
      scrollbarSliderActiveBackground: "rgba(255, 255, 255, 0.22)",
      black: "rgb(24, 30, 38)",
      red: "rgb(255, 122, 142)",
      green: "rgb(134, 231, 149)",
      yellow: "rgb(244, 205, 114)",
      blue: "rgb(137, 190, 255)",
      magenta: "rgb(208, 176, 255)",
      cyan: "rgb(124, 232, 237)",
      white: "rgb(210, 218, 230)",
      brightBlack: "rgb(110, 120, 136)",
      brightRed: "rgb(255, 168, 180)",
      brightGreen: "rgb(176, 245, 186)",
      brightYellow: "rgb(255, 224, 149)",
      brightBlue: "rgb(174, 210, 255)",
      brightMagenta: "rgb(229, 203, 255)",
      brightCyan: "rgb(167, 244, 247)",
      brightWhite: "rgb(244, 247, 252)",
    };
  }

  return {
    background,
    foreground,
    cursor: "rgb(38, 56, 78)",
    selectionBackground: "rgba(37, 63, 99, 0.2)",
    scrollbarSliderBackground: "rgba(0, 0, 0, 0.15)",
    scrollbarSliderHoverBackground: "rgba(0, 0, 0, 0.25)",
    scrollbarSliderActiveBackground: "rgba(0, 0, 0, 0.3)",
    black: "rgb(44, 53, 66)",
    red: "rgb(191, 70, 87)",
    green: "rgb(60, 126, 86)",
    yellow: "rgb(146, 112, 35)",
    blue: "rgb(72, 102, 163)",
    magenta: "rgb(132, 86, 149)",
    cyan: "rgb(53, 127, 141)",
    white: "rgb(210, 215, 223)",
    brightBlack: "rgb(112, 123, 140)",
    brightRed: "rgb(212, 95, 112)",
    brightGreen: "rgb(85, 148, 111)",
    brightYellow: "rgb(173, 133, 45)",
    brightBlue: "rgb(91, 124, 194)",
    brightMagenta: "rgb(153, 107, 172)",
    brightCyan: "rgb(70, 149, 164)",
    brightWhite: "rgb(236, 240, 246)",
  };
}

function serializeRuntimeEnv(runtimeEnv: Record<string, string> | undefined): string {
  if (!runtimeEnv) return "";
  const entries = Object.entries(runtimeEnv);
  if (entries.length === 0) return "";
  entries.sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(entries);
}

function runtimeEnvFromSerialized(
  serializedRuntimeEnv: string,
): Record<string, string> | undefined {
  if (!serializedRuntimeEnv) return undefined;
  const entries = JSON.parse(serializedRuntimeEnv) as Array<[string, string]>;
  return Object.fromEntries(entries);
}

function getTerminalSelectionRect(mountElement: HTMLElement): DOMRect | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const commonAncestor = range.commonAncestorContainer;
  const selectionRoot =
    commonAncestor instanceof Element ? commonAncestor : commonAncestor.parentElement;
  if (!(selectionRoot instanceof Element) || !mountElement.contains(selectionRoot)) {
    return null;
  }

  const rects = Array.from(range.getClientRects()).filter(
    (rect) => rect.width > 0 || rect.height > 0,
  );
  if (rects.length > 0) {
    return rects[rects.length - 1] ?? null;
  }

  const boundingRect = range.getBoundingClientRect();
  return boundingRect.width > 0 || boundingRect.height > 0 ? boundingRect : null;
}

export function resolveTerminalSelectionActionPosition(options: {
  bounds: { left: number; top: number; width: number; height: number };
  selectionRect: { right: number; bottom: number } | null;
  pointer: { x: number; y: number } | null;
  viewport?: { width: number; height: number } | null;
}): { x: number; y: number } {
  const { bounds, selectionRect, pointer, viewport } = options;
  const viewportWidth =
    viewport?.width ??
    (typeof window === "undefined" ? bounds.left + bounds.width + 8 : window.innerWidth);
  const viewportHeight =
    viewport?.height ??
    (typeof window === "undefined" ? bounds.top + bounds.height + 8 : window.innerHeight);
  const drawerLeft = Math.round(bounds.left);
  const drawerTop = Math.round(bounds.top);
  const drawerRight = Math.round(bounds.left + bounds.width);
  const drawerBottom = Math.round(bounds.top + bounds.height);
  const preferredX =
    selectionRect !== null
      ? Math.round(selectionRect.right)
      : pointer === null
        ? Math.round(bounds.left + bounds.width - 140)
        : Math.max(drawerLeft, Math.min(Math.round(pointer.x), drawerRight));
  const preferredY =
    selectionRect !== null
      ? Math.round(selectionRect.bottom + 4)
      : pointer === null
        ? Math.round(bounds.top + 12)
        : Math.max(drawerTop, Math.min(Math.round(pointer.y), drawerBottom));
  return {
    x: Math.max(8, Math.min(preferredX, Math.max(viewportWidth - 8, 8))),
    y: Math.max(8, Math.min(preferredY, Math.max(viewportHeight - 8, 8))),
  };
}

export function terminalSelectionActionDelayForClickCount(clickCount: number): number {
  return clickCount >= 2 ? MULTI_CLICK_SELECTION_ACTION_DELAY_MS : 0;
}

export function shouldHandleTerminalSelectionMouseUp(
  selectionGestureActive: boolean,
  button: number,
): boolean {
  return selectionGestureActive && button === 0;
}

interface TerminalViewportProps {
  threadId: ThreadId;
  terminalId: string;
  terminalLabel: string;
  cwd: string;
  runtimeEnv?: Record<string, string>;
  onSessionExited: () => void;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
  focusRequestId: number;
  autoFocus: boolean;
  isVisible: boolean;
}

function TerminalViewport({
  threadId,
  terminalId,
  terminalLabel,
  cwd,
  runtimeEnv,
  onSessionExited,
  onAddTerminalContext,
  focusRequestId,
  autoFocus,
  isVisible,
}: TerminalViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const webglAddonRef = useRef<WebglAddon | null>(null);
  const lastSentResizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const pendingResizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const resizeDispatchTimerRef = useRef<number | null>(null);
  const visualResizeFrameRef = useRef<number | null>(null);
  const visualResizeTimerRef = useRef<number | null>(null);
  const lastVisualResizeAtRef = useRef(0);
  const onSessionExitedRef = useRef(onSessionExited);
  const onAddTerminalContextRef = useRef(onAddTerminalContext);
  const terminalLabelRef = useRef(terminalLabel);
  const hasHandledExitRef = useRef(false);
  const selectionPointerRef = useRef<{ x: number; y: number } | null>(null);
  const selectionGestureActiveRef = useRef(false);
  const selectionActionRequestIdRef = useRef(0);
  const selectionActionOpenRef = useRef(false);
  const selectionActionTimerRef = useRef<number | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [terminalInstance, setTerminalInstance] = useState<Terminal | null>(null);
  const [searchAddonInstance, setSearchAddonInstance] = useState<SearchAddon | null>(null);
  const runtimeEnvSerialized = useMemo(() => serializeRuntimeEnv(runtimeEnv), [runtimeEnv]);
  const runtimeEnvPayload = useMemo(
    () => runtimeEnvFromSerialized(runtimeEnvSerialized),
    [runtimeEnvSerialized],
  );

  useEffect(() => {
    onSessionExitedRef.current = onSessionExited;
  }, [onSessionExited]);

  const flushPendingResize = useCallback(() => {
    const api = readNativeApi();
    const pendingResize = pendingResizeRef.current;
    if (!api || !pendingResize) return;

    pendingResizeRef.current = null;
    lastSentResizeRef.current = pendingResize;
    void api.terminal
      .resize({
        threadId,
        terminalId,
        cols: pendingResize.cols,
        rows: pendingResize.rows,
      })
      .catch(() => {
        const current = lastSentResizeRef.current;
        if (current && current.cols === pendingResize.cols && current.rows === pendingResize.rows) {
          lastSentResizeRef.current = null;
        }
      });
  }, [terminalId, threadId]);

  const queueBackendResize = useCallback(
    (cols: number, rows: number) => {
      const lastSentResize = lastSentResizeRef.current;
      const pendingResize = pendingResizeRef.current;
      if (
        (lastSentResize && lastSentResize.cols === cols && lastSentResize.rows === rows) ||
        (pendingResize && pendingResize.cols === cols && pendingResize.rows === rows)
      ) {
        return;
      }
      pendingResizeRef.current = { cols, rows };
      if (resizeDispatchTimerRef.current !== null) {
        window.clearTimeout(resizeDispatchTimerRef.current);
      }
      resizeDispatchTimerRef.current = window.setTimeout(() => {
        resizeDispatchTimerRef.current = null;
        flushPendingResize();
      }, BACKEND_RESIZE_DEBOUNCE_MS);
    },
    [flushPendingResize],
  );

  const runTerminalResize = useCallback(
    (options?: { clearTextureAtlas?: boolean; refresh?: boolean; dispatchBackend?: boolean }) => {
      const terminal = terminalRef.current;
      const fitAddon = fitAddonRef.current;
      if (!terminal || !fitAddon) return;

      const { clearTextureAtlas = false, refresh = false, dispatchBackend = true } = options ?? {};
      const wasAtBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;

      if (clearTextureAtlas) {
        (
          webglAddonRef.current as unknown as {
            clearTextureAtlas?: () => void;
          } | null
        )?.clearTextureAtlas?.();
      }

      fitAddon.fit();
      if (wasAtBottom) {
        terminal.scrollToBottom();
      }
      if (dispatchBackend) {
        queueBackendResize(terminal.cols, terminal.rows);
      }
      if (refresh) {
        terminal.refresh(0, Math.max(0, terminal.rows - 1));
      }
    },
    [queueBackendResize],
  );

  const cancelScheduledVisualResize = useCallback(() => {
    if (visualResizeFrameRef.current !== null) {
      window.cancelAnimationFrame(visualResizeFrameRef.current);
      visualResizeFrameRef.current = null;
    }
    if (visualResizeTimerRef.current !== null) {
      window.clearTimeout(visualResizeTimerRef.current);
      visualResizeTimerRef.current = null;
    }
  }, []);

  const scheduleVisualResize = useCallback(() => {
    if (visualResizeTimerRef.current !== null) {
      return;
    }

    const now = Date.now();
    const remaining = Math.max(
      0,
      VISUAL_RESIZE_MIN_INTERVAL_MS - (now - lastVisualResizeAtRef.current),
    );

    const run = () => {
      visualResizeTimerRef.current = null;
      if (visualResizeFrameRef.current !== null) {
        window.cancelAnimationFrame(visualResizeFrameRef.current);
      }
      visualResizeFrameRef.current = window.requestAnimationFrame(() => {
        visualResizeFrameRef.current = null;
        lastVisualResizeAtRef.current = Date.now();
        runTerminalResize();
      });
    };

    if (remaining === 0) {
      run();
      return;
    }

    visualResizeTimerRef.current = window.setTimeout(run, remaining);
  }, [runTerminalResize]);

  useEffect(() => {
    onAddTerminalContextRef.current = onAddTerminalContext;
  }, [onAddTerminalContext]);

  useEffect(() => {
    terminalLabelRef.current = terminalLabel;
  }, [terminalLabel]);

  useEffect(() => {
    const mount = containerRef.current;
    if (!mount) return;
    const api = readNativeApi();
    if (!api) return;

    let disposed = false;

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
    terminal.open(mount);

    // Suppress terminal query responses that would leak as visible garbage
    const disposeQuerySuppression = suppressQueryResponses(terminal);

    // Trim trailing whitespace on copy
    const handleCopy = (e: ClipboardEvent) => {
      const sel = terminal.getSelection();
      if (!sel) return;
      const trimmed = sel.replace(/[^\S\n]+$/gm, "");
      if (trimmed === sel) return;

      // On some Linux/Wayland Electron setups clipboardData may be null.
      // Only cancel default copy if we can write directly to event clipboardData.
      if (e.clipboardData) {
        e.preventDefault();
        e.clipboardData.setData("text/plain", trimmed);
        return;
      }

      // Keep default behavior and best-effort write trimmed content.
      void navigator.clipboard?.writeText(trimmed).catch(() => undefined);
    };
    mount.addEventListener("copy", handleCopy);

    // Deferred WebGL loading — wait one frame so xterm viewport is synced.
    const webglRaf = requestAnimationFrame(() => {
      if (disposed || !ENABLE_TERMINAL_WEBGL || suggestedRendererType === "dom") return;
      try {
        const nextWebglAddon = new WebglAddon();
        nextWebglAddon.onContextLoss(() => {
          nextWebglAddon.dispose();
          if (webglAddonRef.current === nextWebglAddon) {
            webglAddonRef.current = null;
          }
          terminal.refresh(0, Math.max(0, terminal.rows - 1));
        });
        terminal.loadAddon(nextWebglAddon);
        webglAddonRef.current = nextWebglAddon;
      } catch {
        suggestedRendererType = "dom";
        webglAddonRef.current = null;
      }
    });

    fitAddon.fit();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    lastSentResizeRef.current = null;
    setTerminalInstance(terminal);
    setSearchAddonInstance(searchAddon);

    const clearSelectionAction = () => {
      selectionActionRequestIdRef.current += 1;
      if (selectionActionTimerRef.current !== null) {
        window.clearTimeout(selectionActionTimerRef.current);
        selectionActionTimerRef.current = null;
      }
    };

    const readSelectionAction = (): {
      position: { x: number; y: number };
      selection: TerminalContextSelection;
    } | null => {
      const activeTerminal = terminalRef.current;
      const mountElement = containerRef.current;
      if (!activeTerminal || !mountElement || !activeTerminal.hasSelection()) {
        return null;
      }
      const selectionText = activeTerminal.getSelection();
      const selectionPosition = activeTerminal.getSelectionPosition();
      const normalizedText = selectionText.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
      if (!selectionPosition || normalizedText.length === 0) {
        return null;
      }
      const lineStart = selectionPosition.start.y + 1;
      const lineCount = normalizedText.split("\n").length;
      const lineEnd = Math.max(lineStart, lineStart + lineCount - 1);
      const bounds = mountElement.getBoundingClientRect();
      const selectionRect = getTerminalSelectionRect(mountElement);
      const position = resolveTerminalSelectionActionPosition({
        bounds,
        selectionRect:
          selectionRect === null
            ? null
            : { right: selectionRect.right, bottom: selectionRect.bottom },
        pointer: selectionPointerRef.current,
      });
      return {
        position,
        selection: {
          terminalId,
          terminalLabel: terminalLabelRef.current,
          lineStart,
          lineEnd,
          text: normalizedText,
        },
      };
    };

    const showSelectionAction = async () => {
      if (selectionActionOpenRef.current) {
        return;
      }
      const nextAction = readSelectionAction();
      if (!nextAction) {
        clearSelectionAction();
        return;
      }
      const requestId = ++selectionActionRequestIdRef.current;
      selectionActionOpenRef.current = true;
      try {
        const clicked = await api.contextMenu.show(
          [{ id: "add-to-chat", label: "Add to chat" }],
          nextAction.position,
        );
        if (requestId !== selectionActionRequestIdRef.current || clicked !== "add-to-chat") {
          return;
        }
        onAddTerminalContextRef.current(nextAction.selection);
        terminalRef.current?.clearSelection();
        terminalRef.current?.focus();
      } finally {
        selectionActionOpenRef.current = false;
      }
    };

    const sendTerminalInput = async (data: string, fallbackError: string) => {
      const activeTerminal = terminalRef.current;
      if (!activeTerminal) return;
      try {
        await api.terminal.write({ threadId, terminalId, data });
      } catch (error) {
        writeSystemMessage(activeTerminal, error instanceof Error ? error.message : fallbackError);
      }
    };

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
        void sendTerminalInput("\n", "Failed to insert newline");
        return false;
      }

      // Cmd+F / Ctrl+F → open search
      if (
        event.type === "keydown" &&
        event.key.toLowerCase() === "f" &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey
      ) {
        event.preventDefault();
        event.stopPropagation();
        setSearchOpen(true);
        return false;
      }

      const navigationData = terminalNavigationShortcutData(event);
      if (navigationData !== null) {
        event.preventDefault();
        event.stopPropagation();
        void sendTerminalInput(navigationData, "Failed to move cursor");
        return false;
      }

      if (!isTerminalClearShortcut(event)) return true;
      event.preventDefault();
      event.stopPropagation();
      void sendTerminalInput("\u000c", "Failed to clear terminal");
      return false;
    });

    const terminalLinksDisposable = terminal.registerLinkProvider({
      provideLinks: (bufferLineNumber, callback) => {
        const activeTerminal = terminalRef.current;
        if (!activeTerminal) {
          callback(undefined);
          return;
        }

        const line = activeTerminal.buffer.active.getLine(bufferLineNumber - 1);
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

              const latestTerminal = terminalRef.current;
              if (!latestTerminal) return;

              if (match.kind === "url") {
                void api.shell.openExternal(match.text).catch((error) => {
                  writeSystemMessage(
                    latestTerminal,
                    error instanceof Error ? error.message : "Unable to open link",
                  );
                });
                return;
              }

              const target = resolvePathLinkTarget(match.text, cwd);
              void openInPreferredEditor(api, target).catch((error) => {
                writeSystemMessage(
                  latestTerminal,
                  error instanceof Error ? error.message : "Unable to open path",
                );
              });
            },
          })),
        );
      },
    });

    const inputDisposable = terminal.onData((data) => {
      void api.terminal
        .write({ threadId, terminalId, data })
        .catch((err) =>
          writeSystemMessage(
            terminal,
            err instanceof Error ? err.message : "Terminal write failed",
          ),
        );
    });

    let themeRefreshFrame = 0;
    let previousThemeKey = JSON.stringify(terminal.options.theme ?? {});
    const selectionDisposable = terminal.onSelectionChange(() => {
      if (terminalRef.current?.hasSelection()) {
        return;
      }
      clearSelectionAction();
    });

    const handleMouseUp = (event: MouseEvent) => {
      const shouldHandle = shouldHandleTerminalSelectionMouseUp(
        selectionGestureActiveRef.current,
        event.button,
      );
      selectionGestureActiveRef.current = false;
      if (!shouldHandle) {
        return;
      }
      selectionPointerRef.current = { x: event.clientX, y: event.clientY };
      const delay = terminalSelectionActionDelayForClickCount(event.detail);
      selectionActionTimerRef.current = window.setTimeout(() => {
        selectionActionTimerRef.current = null;
        window.requestAnimationFrame(() => {
          void showSelectionAction();
        });
      }, delay);
    };
    const handlePointerDown = (event: PointerEvent) => {
      clearSelectionAction();
      selectionGestureActiveRef.current = event.button === 0;
    };
    window.addEventListener("mouseup", handleMouseUp);
    mount.addEventListener("pointerdown", handlePointerDown);

    const themeObserver = new MutationObserver(() => {
      if (themeRefreshFrame !== 0) return;
      themeRefreshFrame = window.requestAnimationFrame(() => {
        themeRefreshFrame = 0;
        const activeTerminal = terminalRef.current;
        if (!activeTerminal) return;
        const nextTheme = terminalThemeFromApp();
        const nextThemeKey = JSON.stringify(nextTheme);
        if (nextThemeKey === previousThemeKey) {
          return;
        }
        previousThemeKey = nextThemeKey;
        activeTerminal.options.theme = nextTheme;
        activeTerminal.refresh(0, activeTerminal.rows - 1);
      });
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });

    const openTerminal = async () => {
      try {
        const activeTerminal = terminalRef.current;
        const activeFitAddon = fitAddonRef.current;
        if (!activeTerminal || !activeFitAddon) return;
        activeFitAddon.fit();
        const snapshot = await api.terminal.open({
          threadId,
          terminalId,
          cwd,
          cols: activeTerminal.cols,
          rows: activeTerminal.rows,
          ...(runtimeEnvPayload ? { env: runtimeEnvPayload } : {}),
        });
        if (disposed) return;
        activeTerminal.write("\u001bc");
        if (snapshot.history.length > 0) {
          activeTerminal.write(snapshot.history);
        }
        if (autoFocus) {
          window.requestAnimationFrame(() => {
            activeTerminal.focus();
          });
        }
      } catch (err) {
        if (disposed) return;
        writeSystemMessage(
          terminal,
          err instanceof Error ? err.message : "Failed to open terminal",
        );
      }
    };

    // --- Write coalescing: batch incoming output into a single write per frame ---
    const pendingWrites: string[] = [];
    let pendingWriteLength = 0;
    let writeRafHandle: number | null = null;
    let writeFlushTimeout: number | null = null;

    function flushPendingWrites() {
      if (writeRafHandle !== null) {
        cancelAnimationFrame(writeRafHandle);
        writeRafHandle = null;
      }
      if (writeFlushTimeout !== null) {
        window.clearTimeout(writeFlushTimeout);
        writeFlushTimeout = null;
      }
      const t = terminalRef.current;
      if (!t || pendingWrites.length === 0) {
        pendingWrites.length = 0;
        pendingWriteLength = 0;
        return;
      }
      const combined = pendingWrites.join("");
      pendingWrites.length = 0;
      pendingWriteLength = 0;
      t.write(combined);
    }

    function scheduleWrite(data: string) {
      pendingWrites.push(data);
      pendingWriteLength += data.length;

      // Avoid unbounded memory growth when rAF is heavily throttled
      // (for example in background tabs).
      if (pendingWriteLength >= WRITE_BATCH_SIZE_LIMIT) {
        flushPendingWrites();
        return;
      }

      if (writeRafHandle === null) {
        writeRafHandle = requestAnimationFrame(() => {
          writeRafHandle = null;
          flushPendingWrites();
        });
      }
      if (writeFlushTimeout === null) {
        writeFlushTimeout = window.setTimeout(() => {
          writeFlushTimeout = null;
          flushPendingWrites();
        }, WRITE_BATCH_MAX_LATENCY_MS);
      }
    }

    function clearPendingWrites() {
      if (writeRafHandle !== null) {
        cancelAnimationFrame(writeRafHandle);
        writeRafHandle = null;
      }
      if (writeFlushTimeout !== null) {
        window.clearTimeout(writeFlushTimeout);
        writeFlushTimeout = null;
      }
      pendingWrites.length = 0;
      pendingWriteLength = 0;
    }

    const unsubscribe = api?.terminal.onEvent((event) => {
      if (event.threadId !== threadId || event.terminalId !== terminalId) return;
      const activeTerminal = terminalRef.current;
      if (!activeTerminal) return;

      if (event.type === "output") {
        scheduleWrite(event.data);
        clearSelectionAction();
        return;
      }

      if (event.type === "started" || event.type === "restarted") {
        hasHandledExitRef.current = false;
        clearSelectionAction();
        // Flush any pending writes before resetting the terminal.
        clearPendingWrites();
        activeTerminal.write("\u001bc");
        if (event.snapshot.history.length > 0) {
          activeTerminal.write(event.snapshot.history);
        }
        return;
      }

      if (event.type === "cleared") {
        clearSelectionAction();
        clearPendingWrites();
        activeTerminal.clear();
        activeTerminal.write("\u001bc");
        return;
      }

      if (event.type === "error") {
        writeSystemMessage(activeTerminal, event.message);
        return;
      }

      if (event.type === "exited") {
        // Flush any remaining output before displaying the exit message.
        flushPendingWrites();
        const details = [
          typeof event.exitCode === "number" ? `code ${event.exitCode}` : null,
          typeof event.exitSignal === "number" ? `signal ${event.exitSignal}` : null,
        ]
          .filter((value): value is string => value !== null)
          .join(", ");
        writeSystemMessage(
          activeTerminal,
          details.length > 0 ? `Process exited (${details})` : "Process exited",
        );
        if (hasHandledExitRef.current) {
          return;
        }
        hasHandledExitRef.current = true;
        window.setTimeout(() => {
          if (!hasHandledExitRef.current) {
            return;
          }
          onSessionExitedRef.current();
        }, 0);
      }
    });

    void openTerminal();

    return () => {
      disposed = true;
      // Flush any remaining batched writes before tearing down.
      flushPendingWrites();
      cancelAnimationFrame(webglRaf);
      cancelScheduledVisualResize();
      unsubscribe();
      inputDisposable.dispose();
      mount.removeEventListener("copy", handleCopy);
      selectionDisposable.dispose();
      terminalLinksDisposable.dispose();
      disposeQuerySuppression();
      if (selectionActionTimerRef.current !== null) {
        window.clearTimeout(selectionActionTimerRef.current);
      }
      if (themeRefreshFrame !== 0) {
        window.cancelAnimationFrame(themeRefreshFrame);
      }
      window.removeEventListener("mouseup", handleMouseUp);
      mount.removeEventListener("pointerdown", handlePointerDown);
      themeObserver.disconnect();
      webglAddonRef.current?.dispose();
      webglAddonRef.current = null;
      pendingResizeRef.current = null;
      if (resizeDispatchTimerRef.current !== null) {
        window.clearTimeout(resizeDispatchTimerRef.current);
      }
      resizeDispatchTimerRef.current = null;
      lastVisualResizeAtRef.current = 0;
      terminalRef.current = null;
      fitAddonRef.current = null;
      lastSentResizeRef.current = null;
      setTerminalInstance(null);
      setSearchAddonInstance(null);
      terminal.dispose();
    };
    // autoFocus is intentionally omitted;
    // it is only read at mount time and must not trigger terminal teardown/recreation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cancelScheduledVisualResize, cwd, runtimeEnvPayload, terminalId, threadId]);

  useEffect(() => {
    if (!autoFocus) return;
    const terminal = terminalRef.current;
    if (!terminal) return;
    const frame = window.requestAnimationFrame(() => {
      terminal.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [autoFocus, focusRequestId]);

  useEffect(() => {
    if (!isVisible) return;

    let firstFrame = 0;
    let secondFrame = 0;

    firstFrame = window.requestAnimationFrame(() => {
      cancelScheduledVisualResize();
      lastVisualResizeAtRef.current = Date.now();
      runTerminalResize({
        clearTextureAtlas: true,
        refresh: true,
      });

      secondFrame = window.requestAnimationFrame(() => {
        lastVisualResizeAtRef.current = Date.now();
        runTerminalResize({ refresh: true });
      });
    });

    return () => {
      if (firstFrame !== 0) {
        window.cancelAnimationFrame(firstFrame);
      }
      if (secondFrame !== 0) {
        window.cancelAnimationFrame(secondFrame);
      }
    };
  }, [cancelScheduledVisualResize, isVisible, runTerminalResize]);

  useEffect(() => {
    const mount = containerRef.current;
    if (!mount || typeof ResizeObserver === "undefined") return;

    let frame = 0;

    const observer = new ResizeObserver(() => {
      if (frame !== 0) {
        window.cancelAnimationFrame(frame);
      }
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        scheduleVisualResize();
      });
    });

    observer.observe(mount);
    return () => {
      observer.disconnect();
      if (frame !== 0) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [scheduleVisualResize]);

  useEffect(() => {
    const RECOVERY_THROTTLE_MS = 120;
    let frame = 0;
    let throttleTimer: number | null = null;
    let lastRunAt = 0;

    const runRecovery = () => {
      const mount = containerRef.current;
      const terminal = terminalRef.current;
      if (!mount || !terminal) return;
      if (!mount.isConnected) return;

      const style = window.getComputedStyle(mount);
      if (style.display === "none" || style.visibility === "hidden") {
        return;
      }
      const rect = mount.getBoundingClientRect();
      if (rect.width <= 1 || rect.height <= 1) {
        return;
      }

      cancelScheduledVisualResize();
      lastVisualResizeAtRef.current = Date.now();
      runTerminalResize({
        clearTextureAtlas: true,
        refresh: true,
      });
    };

    const scheduleRecovery = () => {
      if (frame !== 0) return;

      frame = window.requestAnimationFrame(() => {
        frame = 0;
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
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleWindowFocus);
      if (frame !== 0) {
        window.cancelAnimationFrame(frame);
      }
      if (throttleTimer !== null) {
        window.clearTimeout(throttleTimer);
      }
    };
  }, [cancelScheduledVisualResize, runTerminalResize]);

  return (
    <div className="h-full min-h-0 w-full rounded-[8px] bg-background p-3">
      <div className="relative h-full min-h-0 w-full overflow-hidden rounded-[4px]">
        <TerminalSearch
          searchAddon={searchAddonInstance}
          isOpen={searchOpen}
          onClose={() => {
            setSearchOpen(false);
            terminalRef.current?.focus();
          }}
        />
        <TerminalScrollToBottom terminal={terminalInstance} />
        <div ref={containerRef} className="h-full w-full" />
      </div>
    </div>
  );
}

interface ThreadTerminalDrawerProps {
  threadId: ThreadId;
  cwd: string;
  runtimeEnv?: Record<string, string>;
  height: number;
  presentationMode: ThreadTerminalPresentationMode;
  isVisible?: boolean;
  terminalIds: string[];
  activeTerminalId: string;
  terminalGroups: ThreadTerminalGroup[];
  activeTerminalGroupId: string;
  focusRequestId: number;
  onSplitTerminal: () => void;
  onNewTerminal: () => void;
  splitShortcutLabel?: string | undefined;
  newShortcutLabel?: string | undefined;
  closeShortcutLabel?: string | undefined;
  workspaceCloseShortcutLabel?: string | undefined;
  onActiveTerminalChange: (terminalId: string) => void;
  onCloseTerminal: (terminalId: string) => void;
  onHeightChange: (height: number) => void;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
  onTogglePresentationMode: () => void;
}

interface TerminalActionButtonProps {
  label: string;
  className: string;
  onClick: () => void;
  children: ReactNode;
}

interface TerminalChromeActionItem {
  disabled?: boolean;
  label: string;
  onClick: () => void;
  children: ReactNode;
}

function TerminalActionButton({ label, className, onClick, children }: TerminalActionButtonProps) {
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        render={<button type="button" className={className} onClick={onClick} aria-label={label} />}
      >
        {children}
      </PopoverTrigger>
      <PopoverPopup
        tooltipStyle
        side="bottom"
        sideOffset={6}
        align="center"
        className="pointer-events-none select-none"
      >
        {label}
      </PopoverPopup>
    </Popover>
  );
}

function TerminalChromeActions(props: {
  actions: ReadonlyArray<TerminalChromeActionItem>;
  variant: "compact" | "workspace" | "sidebar";
}) {
  const itemClassName =
    props.variant === "workspace"
      ? "rounded-md px-2 py-1 text-foreground/90 transition-colors hover:bg-accent/80"
      : props.variant === "sidebar"
        ? "inline-flex h-full items-center px-1 text-foreground/90 transition-colors hover:bg-accent/70"
        : "p-1 text-foreground/90 transition-colors hover:bg-accent";

  return (
    <div
      className={cn(
        "inline-flex items-center",
        props.variant === "compact"
          ? "overflow-hidden rounded-md border border-border/80 bg-background/70"
          : props.variant === "workspace"
            ? "gap-1.5"
            : "h-full items-stretch",
      )}
    >
      {props.actions.map((action, index) => {
        const shouldRenderDivider = props.variant === "compact" && index > 0;
        return (
          <div key={action.label} className={cn(props.variant === "workspace" ? "" : "contents")}>
            {shouldRenderDivider ? <div className="h-4 w-px bg-border/80" /> : null}
            <TerminalActionButton
              className={cn(
                itemClassName,
                props.variant === "sidebar" && index > 0 ? "border-l border-border/70" : "",
                action.disabled ? "cursor-not-allowed opacity-45 hover:bg-transparent" : "",
              )}
              onClick={() => {
                if (action.disabled) return;
                action.onClick();
              }}
              label={action.label}
            >
              {action.children}
            </TerminalActionButton>
          </div>
        );
      })}
    </div>
  );
}

export default function ThreadTerminalDrawer({
  threadId,
  cwd,
  runtimeEnv,
  height,
  presentationMode,
  isVisible = true,
  terminalIds,
  activeTerminalId,
  terminalGroups,
  activeTerminalGroupId,
  focusRequestId,
  onSplitTerminal,
  onNewTerminal,
  splitShortcutLabel,
  newShortcutLabel,
  closeShortcutLabel,
  workspaceCloseShortcutLabel,
  onActiveTerminalChange,
  onCloseTerminal,
  onHeightChange,
  onAddTerminalContext,
  onTogglePresentationMode,
}: ThreadTerminalDrawerProps) {
  const isWorkspaceMode = presentationMode === "workspace";
  const [drawerHeight, setDrawerHeight] = useState(() => clampDrawerHeight(height));
  const drawerHeightRef = useRef(drawerHeight);
  const lastSyncedHeightRef = useRef(clampDrawerHeight(height));
  const onHeightChangeRef = useRef(onHeightChange);
  const resizeStateRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
  } | null>(null);
  const didResizeDuringDragRef = useRef(false);

  const normalizedTerminalIds = useMemo(() => {
    const cleaned = [...new Set(terminalIds.map((id) => id.trim()).filter((id) => id.length > 0))];
    return cleaned.length > 0 ? cleaned : [DEFAULT_THREAD_TERMINAL_ID];
  }, [terminalIds]);

  const resolvedActiveTerminalId = normalizedTerminalIds.includes(activeTerminalId)
    ? activeTerminalId
    : (normalizedTerminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID);

  const resolvedTerminalGroups = useMemo(() => {
    const validTerminalIdSet = new Set(normalizedTerminalIds);
    const assignedTerminalIds = new Set<string>();
    const usedGroupIds = new Set<string>();
    const nextGroups: ThreadTerminalGroup[] = [];

    const assignUniqueGroupId = (groupId: string): string => {
      if (!usedGroupIds.has(groupId)) {
        usedGroupIds.add(groupId);
        return groupId;
      }
      let suffix = 2;
      while (usedGroupIds.has(`${groupId}-${suffix}`)) {
        suffix += 1;
      }
      const uniqueGroupId = `${groupId}-${suffix}`;
      usedGroupIds.add(uniqueGroupId);
      return uniqueGroupId;
    };

    for (const terminalGroup of terminalGroups) {
      const nextTerminalIds = [
        ...new Set(terminalGroup.terminalIds.map((id) => id.trim()).filter((id) => id.length > 0)),
      ].filter((terminalId) => {
        if (!validTerminalIdSet.has(terminalId)) return false;
        if (assignedTerminalIds.has(terminalId)) return false;
        return true;
      });
      if (nextTerminalIds.length === 0) continue;

      for (const terminalId of nextTerminalIds) {
        assignedTerminalIds.add(terminalId);
      }

      const baseGroupId =
        terminalGroup.id.trim().length > 0
          ? terminalGroup.id.trim()
          : `group-${nextTerminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID}`;
      nextGroups.push({
        id: assignUniqueGroupId(baseGroupId),
        terminalIds: nextTerminalIds,
      });
    }

    for (const terminalId of normalizedTerminalIds) {
      if (assignedTerminalIds.has(terminalId)) continue;
      nextGroups.push({
        id: assignUniqueGroupId(`group-${terminalId}`),
        terminalIds: [terminalId],
      });
    }

    if (nextGroups.length > 0) {
      return nextGroups;
    }

    return [
      {
        id: `group-${resolvedActiveTerminalId}`,
        terminalIds: [resolvedActiveTerminalId],
      },
    ];
  }, [normalizedTerminalIds, resolvedActiveTerminalId, terminalGroups]);

  const resolvedActiveGroupIndex = useMemo(() => {
    const indexById = resolvedTerminalGroups.findIndex(
      (terminalGroup) => terminalGroup.id === activeTerminalGroupId,
    );
    if (indexById >= 0) return indexById;
    const indexByTerminal = resolvedTerminalGroups.findIndex((terminalGroup) =>
      terminalGroup.terminalIds.includes(resolvedActiveTerminalId),
    );
    return indexByTerminal >= 0 ? indexByTerminal : 0;
  }, [activeTerminalGroupId, resolvedActiveTerminalId, resolvedTerminalGroups]);

  const visibleTerminalIds = resolvedTerminalGroups[resolvedActiveGroupIndex]?.terminalIds ?? [
    resolvedActiveTerminalId,
  ];
  const workspaceTerminalIds = normalizedTerminalIds;
  const hasTerminalSidebar = normalizedTerminalIds.length > 1;
  const isSplitView = visibleTerminalIds.length > 1;
  const showGroupHeaders =
    resolvedTerminalGroups.length > 1 ||
    resolvedTerminalGroups.some((terminalGroup) => terminalGroup.terminalIds.length > 1);
  const hasReachedSplitLimit = visibleTerminalIds.length >= MAX_TERMINALS_PER_GROUP;
  const terminalLabelById = useMemo(
    () =>
      new Map(
        normalizedTerminalIds.map((terminalId, index) => [terminalId, `Terminal ${index + 1}`]),
      ),
    [normalizedTerminalIds],
  );
  const splitTerminalActionLabel = hasReachedSplitLimit
    ? `Split Terminal (max ${MAX_TERMINALS_PER_GROUP} per group)`
    : splitShortcutLabel
      ? `Split Terminal (${splitShortcutLabel})`
      : "Split Terminal";
  const newTerminalActionLabel = newShortcutLabel
    ? `New Terminal (${newShortcutLabel})`
    : "New Terminal";
  const resolvedCloseShortcutLabel = isWorkspaceMode
    ? (workspaceCloseShortcutLabel ?? closeShortcutLabel)
    : closeShortcutLabel;
  const closeTerminalActionLabel = resolvedCloseShortcutLabel
    ? `Close Terminal (${resolvedCloseShortcutLabel})`
    : "Close Terminal";
  const onSplitTerminalAction = useCallback(() => {
    if (hasReachedSplitLimit) return;
    onSplitTerminal();
  }, [hasReachedSplitLimit, onSplitTerminal]);
  const onNewTerminalAction = useCallback(() => {
    onNewTerminal();
  }, [onNewTerminal]);

  useEffect(() => {
    onHeightChangeRef.current = onHeightChange;
  }, [onHeightChange]);

  useEffect(() => {
    drawerHeightRef.current = drawerHeight;
  }, [drawerHeight]);

  const syncHeight = useCallback((nextHeight: number) => {
    const clampedHeight = clampDrawerHeight(nextHeight);
    if (lastSyncedHeightRef.current === clampedHeight) return;
    lastSyncedHeightRef.current = clampedHeight;
    onHeightChangeRef.current(clampedHeight);
  }, []);

  useEffect(() => {
    const clampedHeight = clampDrawerHeight(height);
    setDrawerHeight(clampedHeight);
    drawerHeightRef.current = clampedHeight;
    lastSyncedHeightRef.current = clampedHeight;
  }, [height, threadId]);

  const handleResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    didResizeDuringDragRef.current = false;
    resizeStateRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: drawerHeightRef.current,
    };
  }, []);

  const handleResizePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const resizeState = resizeStateRef.current;
    if (!resizeState || resizeState.pointerId !== event.pointerId) return;
    event.preventDefault();
    const clampedHeight = clampDrawerHeight(
      resizeState.startHeight + (resizeState.startY - event.clientY),
    );
    if (clampedHeight === drawerHeightRef.current) {
      return;
    }
    didResizeDuringDragRef.current = true;
    drawerHeightRef.current = clampedHeight;
    setDrawerHeight(clampedHeight);
  }, []);

  const handleResizePointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const resizeState = resizeStateRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId) return;
      resizeStateRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (!didResizeDuringDragRef.current) {
        return;
      }
      syncHeight(drawerHeightRef.current);
    },
    [syncHeight],
  );

  useEffect(() => {
    const onWindowResize = () => {
      const clampedHeight = clampDrawerHeight(drawerHeightRef.current);
      const changed = clampedHeight !== drawerHeightRef.current;
      if (changed) {
        setDrawerHeight(clampedHeight);
        drawerHeightRef.current = clampedHeight;
      }
      if (!resizeStateRef.current) {
        syncHeight(clampedHeight);
      }
    };
    window.addEventListener("resize", onWindowResize);
    return () => {
      window.removeEventListener("resize", onWindowResize);
    };
  }, [syncHeight]);

  useEffect(() => {
    return () => {
      syncHeight(drawerHeightRef.current);
    };
  }, [syncHeight]);
  const presentationToggleLabel = isWorkspaceMode
    ? "Collapse terminal workspace"
    : "Expand terminal workspace";
  const presentationToggleIcon = isWorkspaceMode ? (
    <Minimize2 className="size-3.25" />
  ) : (
    <Maximize2 className="size-3.25" />
  );
  const drawerChromeActions: TerminalChromeActionItem[] = [
    {
      label: splitTerminalActionLabel,
      onClick: onSplitTerminalAction,
      disabled: hasReachedSplitLimit,
      children: <SquareSplitHorizontal className="size-3.25" />,
    },
    {
      label: newTerminalActionLabel,
      onClick: onNewTerminalAction,
      children: <Plus className="size-3.25" />,
    },
    {
      label: presentationToggleLabel,
      onClick: onTogglePresentationMode,
      children: presentationToggleIcon,
    },
    {
      label: closeTerminalActionLabel,
      onClick: () => onCloseTerminal(resolvedActiveTerminalId),
      children: <Trash2 className="size-3.25" />,
    },
  ];
  // Workspace mode behaves like flat browser tabs, so we keep only shell-level
  // actions here and leave split groups as a drawer-only concept.
  const workspaceChromeActions: TerminalChromeActionItem[] = [
    {
      label: newTerminalActionLabel,
      onClick: onNewTerminalAction,
      children: <Plus className="size-3.25" />,
    },
    {
      label: presentationToggleLabel,
      onClick: onTogglePresentationMode,
      children: presentationToggleIcon,
    },
    {
      label: closeTerminalActionLabel,
      onClick: () => onCloseTerminal(resolvedActiveTerminalId),
      children: <Trash2 className="size-3.25" />,
    },
  ];
  const showWorkspaceTerminalTabs = isWorkspaceMode && workspaceTerminalIds.length > 1;
  const workspaceTerminalTabs = showWorkspaceTerminalTabs && (
    <div className="flex min-w-0 items-center justify-between gap-3 border-b border-border/70 bg-muted/10 px-2 pt-1.5">
      <div className="flex min-w-0 items-end gap-1 overflow-x-auto pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {workspaceTerminalIds.map((terminalId) => {
          const isActive = terminalId === resolvedActiveTerminalId;
          const closeTabLabel = `Close ${terminalLabelById.get(terminalId) ?? "Terminal"}`;
          return (
            <div
              key={terminalId}
              className={cn(
                "group relative -mb-px flex h-8 shrink-0 items-center gap-2 rounded-t-[11px] border border-b-0 px-3 transition-colors",
                isActive
                  ? "z-[1] border-border/70 bg-background text-foreground"
                  : "border-transparent bg-transparent text-muted-foreground hover:bg-background/60 hover:text-foreground",
              )}
            >
              <button
                type="button"
                className="flex min-w-0 items-center gap-2 text-left"
                onClick={() => onActiveTerminalChange(terminalId)}
              >
                <TerminalSquare className="size-3 shrink-0" />
                <span className="truncate font-mono text-[11px] tracking-[0.08em]">
                  {terminalLabelById.get(terminalId) ?? "Terminal"}
                </span>
              </button>
              <button
                type="button"
                className={cn(
                  "inline-flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground transition hover:bg-accent/80 hover:text-foreground",
                  workspaceTerminalIds.length <= 1 ? "hidden" : "",
                )}
                onClick={(event) => {
                  event.stopPropagation();
                  onCloseTerminal(terminalId);
                }}
                aria-label={closeTabLabel}
              >
                <XIcon className="size-2.75" />
              </button>
            </div>
          );
        })}
      </div>
      <div className="shrink-0 pb-0.5">
        <TerminalChromeActions actions={workspaceChromeActions} variant="workspace" />
      </div>
    </div>
  );

  return (
    <aside
      className={cn(
        "thread-terminal-drawer relative flex min-w-0 flex-col overflow-hidden bg-background",
        isWorkspaceMode
          ? "h-full min-h-0 border-t border-border/70"
          : "shrink-0 border-t border-border/80",
      )}
      style={isWorkspaceMode ? undefined : { height: `${drawerHeight}px` }}
    >
      {!isWorkspaceMode ? (
        <div
          className="absolute inset-x-0 top-0 z-20 h-1.5 cursor-row-resize"
          onPointerDown={handleResizePointerDown}
          onPointerMove={handleResizePointerMove}
          onPointerUp={handleResizePointerEnd}
          onPointerCancel={handleResizePointerEnd}
        />
      ) : null}

      {workspaceTerminalTabs}

      {isWorkspaceMode && !showWorkspaceTerminalTabs ? (
        <div className="pointer-events-none absolute right-2 top-2 z-20">
          <div className="pointer-events-auto">
            <TerminalChromeActions actions={workspaceChromeActions} variant="compact" />
          </div>
        </div>
      ) : null}

      {!hasTerminalSidebar && !isWorkspaceMode && (
        <div className="pointer-events-none absolute right-2 top-2 z-20">
          <div className="pointer-events-auto">
            <TerminalChromeActions actions={drawerChromeActions} variant="compact" />
          </div>
        </div>
      )}

      <div className="min-h-0 w-full flex-1">
        <div
          className={cn(
            "flex h-full min-h-0",
            hasTerminalSidebar && !isWorkspaceMode ? "gap-1.5" : "",
          )}
        >
          <div className="min-w-0 flex-1">
            {!isWorkspaceMode && isSplitView ? (
              <div
                className="grid h-full w-full min-w-0 gap-0 overflow-hidden"
                style={{
                  gridTemplateColumns: `repeat(${visibleTerminalIds.length}, minmax(0, 1fr))`,
                }}
              >
                {visibleTerminalIds.map((terminalId) => (
                  <div
                    key={terminalId}
                    className={`min-h-0 min-w-0 border-l first:border-l-0 ${
                      terminalId === resolvedActiveTerminalId ? "border-border" : "border-border/70"
                    }`}
                    onMouseDown={() => {
                      if (terminalId !== resolvedActiveTerminalId) {
                        onActiveTerminalChange(terminalId);
                      }
                    }}
                  >
                    <div className="h-full p-1">
                      <TerminalViewport
                        threadId={threadId}
                        terminalId={terminalId}
                        terminalLabel={terminalLabelById.get(terminalId) ?? "Terminal"}
                        cwd={cwd}
                        {...(runtimeEnv ? { runtimeEnv } : {})}
                        onSessionExited={() => onCloseTerminal(terminalId)}
                        onAddTerminalContext={onAddTerminalContext}
                        focusRequestId={focusRequestId}
                        autoFocus={terminalId === resolvedActiveTerminalId}
                        isVisible={isVisible}
                      />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className={cn("h-full", isWorkspaceMode ? "" : "p-1")}>
                <TerminalViewport
                  key={resolvedActiveTerminalId}
                  threadId={threadId}
                  terminalId={resolvedActiveTerminalId}
                  terminalLabel={terminalLabelById.get(resolvedActiveTerminalId) ?? "Terminal"}
                  cwd={cwd}
                  {...(runtimeEnv ? { runtimeEnv } : {})}
                  onSessionExited={() => onCloseTerminal(resolvedActiveTerminalId)}
                  onAddTerminalContext={onAddTerminalContext}
                  focusRequestId={focusRequestId}
                  autoFocus
                  isVisible={isVisible}
                />
              </div>
            )}
          </div>

          {hasTerminalSidebar && !isWorkspaceMode && (
            <aside
              className={cn(
                "flex w-36 min-w-36 flex-col border border-border/70 bg-muted/10",
                isWorkspaceMode ? "border-y-0 border-r-0" : "",
              )}
            >
              <div className="flex h-[22px] items-stretch justify-end border-b border-border/70">
                <TerminalChromeActions actions={drawerChromeActions} variant="sidebar" />
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
                {resolvedTerminalGroups.map((terminalGroup, groupIndex) => {
                  const isGroupActive =
                    terminalGroup.terminalIds.includes(resolvedActiveTerminalId);
                  const groupActiveTerminalId = isGroupActive
                    ? resolvedActiveTerminalId
                    : (terminalGroup.terminalIds[0] ?? resolvedActiveTerminalId);

                  return (
                    <div key={terminalGroup.id} className="pb-0.5">
                      {showGroupHeaders && (
                        <button
                          type="button"
                          className={`flex w-full items-center rounded px-1 py-0.5 text-[10px] uppercase tracking-[0.08em] ${
                            isGroupActive
                              ? "bg-accent/70 text-foreground"
                              : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                          }`}
                          onClick={() => onActiveTerminalChange(groupActiveTerminalId)}
                        >
                          {terminalGroup.terminalIds.length > 1
                            ? `Split ${groupIndex + 1}`
                            : `Terminal ${groupIndex + 1}`}
                        </button>
                      )}

                      <div
                        className={showGroupHeaders ? "ml-1 border-l border-border/60 pl-1.5" : ""}
                      >
                        {terminalGroup.terminalIds.map((terminalId) => {
                          const isActive = terminalId === resolvedActiveTerminalId;
                          const terminalCloseLabelShortcut = isActive
                            ? resolvedCloseShortcutLabel
                            : null;
                          const closeTerminalLabel = `Close ${
                            terminalLabelById.get(terminalId) ?? "terminal"
                          }${terminalCloseLabelShortcut ? ` (${terminalCloseLabelShortcut})` : ""}`;
                          return (
                            <div
                              key={terminalId}
                              className={`group flex items-center gap-1 rounded px-1 py-0.5 text-[11px] ${
                                isActive
                                  ? "bg-accent text-foreground"
                                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                              }`}
                            >
                              {showGroupHeaders && (
                                <span className="text-[10px] text-muted-foreground/80">└</span>
                              )}
                              <button
                                type="button"
                                className="flex min-w-0 flex-1 items-center gap-1 text-left"
                                onClick={() => onActiveTerminalChange(terminalId)}
                              >
                                <TerminalSquare className="size-3 shrink-0" />
                                <span className="truncate">
                                  {terminalLabelById.get(terminalId) ?? "Terminal"}
                                </span>
                              </button>
                              {normalizedTerminalIds.length > 1 && (
                                <Popover>
                                  <PopoverTrigger
                                    openOnHover
                                    render={
                                      <button
                                        type="button"
                                        className="inline-flex size-3.5 items-center justify-center rounded text-xs font-medium leading-none text-muted-foreground opacity-0 transition hover:bg-accent hover:text-foreground group-hover:opacity-100"
                                        onClick={() => onCloseTerminal(terminalId)}
                                        aria-label={closeTerminalLabel}
                                      />
                                    }
                                  >
                                    <XIcon className="size-2.5" />
                                  </PopoverTrigger>
                                  <PopoverPopup
                                    tooltipStyle
                                    side="bottom"
                                    sideOffset={6}
                                    align="center"
                                    className="pointer-events-none select-none"
                                  >
                                    {closeTerminalLabel}
                                  </PopoverPopup>
                                </Popover>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </aside>
          )}
        </div>
      </div>
    </aside>
  );
}
