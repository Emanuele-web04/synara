import type { ResolvedKeybindingsConfig } from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { isEditorFileSaveShortcut } from "../keybindings";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];

function isBrowserSaveChord(event: globalThis.KeyboardEvent): boolean {
  return (
    event.key.toLowerCase() === "s" &&
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey
  );
}

export function useWorkspaceFileEditorSaveShortcut({
  enabled,
  onSave,
}: {
  enabled: boolean;
  onSave: () => void;
}): void {
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const keybindings = serverConfigQuery.data?.keybindings ?? EMPTY_KEYBINDINGS;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const handler = (event: globalThis.KeyboardEvent) => {
      if (isBrowserSaveChord(event)) {
        event.preventDefault();
      }
      if (!isEditorFileSaveShortcut(event, keybindings)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onSaveRef.current();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [enabled, keybindings]);
}
