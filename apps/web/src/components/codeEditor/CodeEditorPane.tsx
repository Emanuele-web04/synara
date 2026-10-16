import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useRef,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { useQuery } from "@tanstack/react-query";
import type { ResolvedKeybindingsConfig } from "@synara/contracts";
import type { ChatFileReference } from "~/lib/chatReferences";
import { isBrowserSaveChord } from "~/hooks/useWorkspaceFileEditorShortcuts";
import { isEditorFileSaveShortcut } from "~/keybindings";
import { serverConfigQueryOptions } from "~/lib/serverReactQuery";
import type { CodeEditHistoryControls, CodeEditHistoryState } from "./pierreEdit";

let loadedSurface: typeof import("./MonacoEditorSurface").default | undefined;
let surfacePromise: Promise<typeof import("./MonacoEditorSurface")> | undefined;
export function preloadCodeEditorSurface() {
  surfacePromise ??= import("./MonacoEditorSurface").then((module) => {
    loadedSurface = module.default;
    return module;
  });
  return surfacePromise;
}
const MonacoEditorSurface = lazy(preloadCodeEditorSurface);
export interface CodeEditorPaneProps {
  value: string;
  valueVersion: number;
  fileName: string;
  workspaceRoot?: string | null | undefined;
  resolvedTheme: "light" | "dark";
  onChange: (value: string) => void;
  onSave: () => void;
  onReferenceInChat?: ((reference: ChatFileReference) => void) | undefined;
  historyControlsRef?: RefObject<CodeEditHistoryControls | null> | undefined;
  onHistoryChange?: ((history: CodeEditHistoryState) => void) | undefined;
}

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];

// Capture-phase save handling for the editor: the editor hosts its own
// key handling, so saves are dispatched from the container. The chord is
// matched against the configured `editor.file.save` binding (not hard-coded
// Mod+S) so rebinds are honored, while the browser save dialog stays
// suppressed for the default chord regardless of the binding.
export function useCodeEditorSaveKeyDownHandler(onSave: () => void) {
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const keybindings = serverConfigQuery.data?.keybindings ?? EMPTY_KEYBINDINGS;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  return useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (isBrowserSaveChord(event)) {
        event.preventDefault();
      }
      if (!isEditorFileSaveShortcut(event, keybindings)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onSaveRef.current();
    },
    [keybindings],
  );
}

export class EditorSurfaceBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function CodeEditorPane(props: CodeEditorPaneProps) {
  const saveKeyDownHandler = useCodeEditorSaveKeyDownHandler(props.onSave);
  // Keep the chosen component type for the lifetime of this pane. Switching
  // from React.lazy to its resolved component on an edit remounts the surface.
  const Surface = useRef(loadedSurface ?? MonacoEditorSurface).current;
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      onKeyDownCapture={saveKeyDownHandler}
    >
      <EditorSurfaceBoundary
        fallback={
          <>
            <p role="status" className="p-3 text-ui-sm">
              The editor engine could not load. Your draft is preserved; plain-text editing is
              available.
            </p>
            <textarea
              aria-label={`Edit ${props.fileName}`}
              className="min-h-0 flex-1 resize-none bg-transparent p-3 font-mono text-chat-code"
              value={props.value}
              onChange={(event) => props.onChange(event.currentTarget.value)}
            />
          </>
        }
      >
        <Suspense
          fallback={
            <p role="status" className="p-3 text-ui-sm text-muted-foreground">
              Loading editor…
            </p>
          }
        >
          <Surface {...props} />
        </Suspense>
      </EditorSurfaceBoundary>
    </div>
  );
}
