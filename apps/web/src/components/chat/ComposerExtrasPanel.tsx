// FILE: ComposerExtrasPanel.tsx
// Purpose: Composer `+` panel — attachments, window capture, and mode/speed switches rendered with
//   the shared command-menu panel chrome above the composer instead of a nested dropdown.
// Layer: Chat composer presentation
// Depends on: ComposerMenuPanel chrome, the AppSnap window picker hook, caller-owned composer state.

import type { ProviderInteractionMode, ThreadId } from "@synara/contracts";
import { useEffect, useId, useRef, useState, type ChangeEvent, type ReactNode } from "react";

import {
  ArrowLeftIcon,
  BugIcon,
  CheckIcon,
  ChevronRightIcon,
  ListTodoIcon,
  MessageCircleIcon,
  PaperclipIcon,
  WindowIcon,
  ZapIcon,
} from "~/lib/icons";
import {
  COMPOSER_MENU_PANEL_GLYPH_CLASS_NAME,
  ComposerMenuPanel,
  type ComposerMenuPanelGroup,
  type ComposerMenuPanelRow,
} from "./ComposerMenuPanel";
import { useAppSnapWindows } from "./useAppSnapWindows";

/** Marks the `+` trigger so the panel's outside-press close does not fight the trigger's toggle. */
export const COMPOSER_EXTRAS_TRIGGER_ATTRIBUTE = "data-composer-extras-trigger";

const GLYPH = COMPOSER_MENU_PANEL_GLYPH_CLASS_NAME;

const ROW_FILES = "extras:files";
const ROW_WINDOW = "extras:window";
const ROW_BACK = "extras:back";
const ROW_FAST = "extras:fast";
const WINDOW_ROW_PREFIX = "extras:window:";

const INTERACTION_MODE_ROWS: ReadonlyArray<{
  mode: ProviderInteractionMode;
  id: string;
  title: string;
  secondary: string;
  icon: ReactNode;
}> = [
  {
    mode: "default",
    id: "extras:mode:default",
    title: "Default",
    secondary: "Chat and edit as usual",
    icon: <MessageCircleIcon className={GLYPH} />,
  },
  {
    mode: "plan",
    id: "extras:mode:plan",
    title: "Plan",
    secondary: "Plan the work before changing files",
    icon: <ListTodoIcon className={GLYPH} />,
  },
  {
    mode: "debug",
    id: "extras:mode:debug",
    title: "Debug",
    secondary: "Investigate before proposing a fix",
    icon: <BugIcon className={GLYPH} />,
  },
];

function selectedMarker(selected: boolean): ReactNode {
  return selected ? <CheckIcon className="size-3.5 text-foreground/70" /> : null;
}

export function ComposerExtrasPanel(props: {
  interactionMode: ProviderInteractionMode;
  supportsFastMode: boolean;
  fastModeEnabled: boolean;
  threadId?: ThreadId;
  onAddAttachments: (files: File[]) => void;
  onToggleFastMode: () => void;
  onInteractionModeChange: (mode: ProviderInteractionMode) => void;
  onClose: () => void;
  panelId: string;
}) {
  const inputId = useId();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<"root" | "windows">("root");
  const [activeRowId, setActiveRowId] = useState<string | null>(ROW_FILES);

  const appSnap = useAppSnapWindows({
    open: view === "windows",
    ...(props.threadId === undefined ? {} : { threadId: props.threadId }),
  });

  const groups: ComposerMenuPanelGroup[] =
    view === "windows"
      ? [
          {
            id: "windows",
            label: "Attach window",
            rows: [
              {
                id: ROW_BACK,
                icon: <ArrowLeftIcon className={GLYPH} />,
                title: "Back",
              },
              ...appSnapWindowRows(appSnap),
            ],
          },
        ]
      : [
          {
            id: "add",
            label: "Add",
            rows: [
              {
                id: ROW_FILES,
                icon: <PaperclipIcon className={GLYPH} />,
                title: "Files and folders",
                secondary: "Attach from this computer",
              },
              ...(appSnap.available
                ? [
                    {
                      id: ROW_WINDOW,
                      icon: <WindowIcon className={GLYPH} />,
                      title: "Attach window",
                      secondary: "Capture an open app window",
                      trailing: <ChevronRightIcon className="size-3.5" />,
                    },
                  ]
                : []),
            ],
          },
          {
            id: "mode",
            label: "Mode",
            rows: INTERACTION_MODE_ROWS.map((entry) => ({
              id: entry.id,
              icon: entry.icon,
              title: entry.title,
              secondary: entry.secondary,
              trailing: selectedMarker(props.interactionMode === entry.mode),
            })),
          },
          ...(props.supportsFastMode
            ? [
                {
                  id: "speed",
                  label: "Speed",
                  rows: [
                    {
                      id: ROW_FAST,
                      icon: <ZapIcon className={GLYPH} />,
                      title: "Fast mode",
                      secondary: "Trade depth for a quicker answer",
                      trailing: selectedMarker(props.fastModeEnabled),
                    },
                  ],
                },
              ]
            : []),
        ];

  const selectableRowIds = groups.flatMap((group) =>
    group.rows.filter((row) => !row.disabled).map((row) => row.id),
  );
  // Keep the highlight on a row that still exists after navigating between views.
  const highlightedRowId =
    activeRowId && selectableRowIds.includes(activeRowId)
      ? activeRowId
      : (selectableRowIds[0] ?? null);

  const goBack = () => {
    setView("root");
    setActiveRowId(ROW_WINDOW);
  };

  const selectRow = (rowId: string) => {
    if (rowId === ROW_FILES) {
      fileInputRef.current?.click();
      return;
    }
    if (rowId === ROW_WINDOW) {
      setView("windows");
      setActiveRowId(ROW_BACK);
      return;
    }
    if (rowId === ROW_BACK) {
      goBack();
      return;
    }
    if (rowId === ROW_FAST) {
      props.onToggleFastMode();
      props.onClose();
      return;
    }
    if (rowId.startsWith(WINDOW_ROW_PREFIX)) {
      const windowId = Number.parseInt(rowId.slice(WINDOW_ROW_PREFIX.length), 10);
      if (Number.isFinite(windowId)) {
        appSnap.captureWindow(windowId);
        props.onClose();
      }
      return;
    }
    const modeEntry = INTERACTION_MODE_ROWS.find((entry) => entry.id === rowId);
    if (modeEntry) {
      props.onInteractionModeChange(modeEntry.mode);
      props.onClose();
    }
  };

  // The composer editor keeps focus while the panel is open so the user can keep typing;
  // the panel therefore claims only its own navigation keys, in capture phase, so Enter
  // cannot reach the composer form and send the draft.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (view === "windows") {
          goBack();
        } else {
          props.onClose();
        }
        return;
      }

      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (selectableRowIds.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        const currentIndex = highlightedRowId ? selectableRowIds.indexOf(highlightedRowId) : -1;
        const offset = event.key === "ArrowDown" ? 1 : -1;
        const nextIndex =
          (currentIndex + offset + selectableRowIds.length) % selectableRowIds.length;
        setActiveRowId(selectableRowIds[nextIndex] ?? null);
        return;
      }

      if (event.key === "Enter" || event.key === "Tab") {
        if (!highlightedRowId) return;
        event.preventDefault();
        event.stopPropagation();
        selectRow(highlightedRowId);
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  });

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (containerRef.current?.contains(target)) return;
      if (
        target instanceof Element &&
        target.closest(`[${COMPOSER_EXTRAS_TRIGGER_ATTRIBUTE}]`) !== null
      ) {
        return;
      }
      props.onClose();
    };

    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  });

  // Reset the hidden input so selecting the same file twice still emits a change event.
  const handleFileInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (files.length > 0) {
      props.onAddAttachments(files);
    }
    event.target.value = "";
    props.onClose();
  };

  return (
    <div ref={containerRef} id={props.panelId} data-testid="composer-extras-panel">
      <input
        id={inputId}
        ref={fileInputRef}
        data-testid="composer-file-input"
        type="file"
        multiple
        className="sr-only"
        onChange={handleFileInputChange}
      />
      <ComposerMenuPanel
        groups={groups}
        activeRowId={highlightedRowId}
        onHighlightRow={setActiveRowId}
        onSelectRow={selectRow}
      />
    </div>
  );
}

function appSnapWindowRows(appSnap: ReturnType<typeof useAppSnapWindows>): ComposerMenuPanelRow[] {
  if (appSnap.unavailableMessage) {
    return [{ id: "extras:window-status", title: appSnap.unavailableMessage, disabled: true }];
  }
  if (appSnap.windows === null) {
    return [{ id: "extras:window-status", title: "Loading windows…", disabled: true }];
  }
  if (appSnap.windows.length === 0) {
    return [
      {
        id: "extras:window-status",
        title: "No other app windows are visible.",
        disabled: true,
      },
    ];
  }

  return appSnap.windows.map((entry) => {
    const appName = entry.appName?.trim() || "Captured app";
    const windowTitle = entry.windowTitle?.trim() || null;
    return {
      id: `${WINDOW_ROW_PREFIX}${entry.windowId}`,
      icon: entry.appIconDataUrl ? (
        <img src={entry.appIconDataUrl} alt="" className="size-4 shrink-0 rounded-[4px]" />
      ) : (
        <WindowIcon className={GLYPH} />
      ),
      title: appName,
      secondary: windowTitle,
      disabled: appSnap.busy,
    };
  });
}
