// FILE: editorSaveShortcut.ts
// Purpose: The capture-phase save chord shared by every editing surface and engine.
// Layer: Web editor runtime
// Exports: useCodeEditorSaveKeyDownHandler

import { useQuery } from "@tanstack/react-query";
import type { ResolvedKeybindingsConfig } from "@synara/contracts";
import { useCallback, useRef, type KeyboardEvent } from "react";

import { isBrowserSaveChord } from "~/hooks/useWorkspaceFileEditorShortcuts";
import { isEditorFileSaveShortcut } from "~/keybindings";
import { serverConfigQueryOptions } from "~/lib/serverReactQuery";

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];

// Capture-phase save handling: the engine hosts its own key handling, so saves
// are dispatched from the container. The chord is matched against the
// configured `editor.file.save` binding (not hard-coded Mod+S) so rebinds are
// honored, while the browser save dialog stays suppressed for the default chord.
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
