import type { ResolvedKeybindingsConfig } from "@synara/contracts";
import { useEffect, useLayoutEffect, useRef } from "react";
import { resolveShortcutCommand, type ShortcutMatchContext } from "../../keybindings";

interface ComposerVoiceShortcutOptions {
  enabled: boolean;
  sessionId: string;
  keybindings: ResolvedKeybindingsConfig;
  context: Partial<ShortcutMatchContext>;
  canHandleEvent: (event: KeyboardEvent) => boolean;
  isRecording: boolean;
  isStarting: boolean;
  isTranscribing: boolean;
  onStart: () => Promise<void>;
  onSubmit: () => void;
  onCancel: () => void;
}

// Keep listeners and the held key alive across recorder state updates.
export function useComposerVoiceShortcut(options: ComposerVoiceShortcutOptions) {
  const latest = useRef(options);
  useLayoutEffect(() => {
    latest.current = options;
  });
  const { enabled, sessionId } = options;
  useEffect(() => {
    if (!enabled) return;
    let starting = false;
    let generation = 0;
    let held: { code: string; key: string; modifiers: string[]; cancel: () => void } | null = null;
    const cancelHeld = () => {
      const recording = held;
      held = null;
      if (recording) {
        generation += 1;
        starting = false;
        recording.cancel();
      }
    };
    const down = (event: KeyboardEvent) => {
      const current = latest.current;
      if (event.defaultPrevented || event.isComposing || !current.canHandleEvent(event)) return;
      if (
        event.key === "Escape" &&
        !current.isTranscribing &&
        (held || starting || current.isStarting || current.isRecording)
      ) {
        event.preventDefault();
        event.stopPropagation();
        held = null;
        generation += 1;
        starting = false;
        current.onCancel();
        return;
      }
      const command = resolveShortcutCommand(event, current.keybindings, {
        context: current.context,
      });
      if (command !== "composer.voice.toggle" && command !== "composer.voice.hold") return;
      if (current.isTranscribing) return;
      event.preventDefault();
      event.stopPropagation();
      // Do consume repeats: Option+Space must not insert spaces into the draft.
      if (event.repeat || held || starting || current.isStarting) return;
      if (current.isRecording) {
        if (command === "composer.voice.toggle") current.onSubmit();
        return;
      }
      if (command === "composer.voice.hold") {
        held = {
          code: event.code,
          key: event.key,
          modifiers: [
            ...(event.altKey ? ["Alt"] : []),
            ...(event.ctrlKey ? ["Control"] : []),
            ...(event.metaKey ? ["Meta"] : []),
            ...(event.shiftKey ? ["Shift"] : []),
          ],
          cancel: current.onCancel,
        };
      }
      const requestGeneration = ++generation;
      starting = true;
      void current.onStart().then(
        () => {
          if (generation !== requestGeneration) return;
          starting = false;
        },
        () => {
          if (generation !== requestGeneration) return;
          starting = false;
          cancelHeld();
        },
      );
    };
    const up = (event: KeyboardEvent) => {
      if (!held) return;
      const baseReleased = held.code ? event.code === held.code : event.key === held.key;
      if (!baseReleased && !held.modifiers.includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      const current = latest.current;
      if (starting || current.isStarting || !current.isRecording) {
        cancelHeld();
      } else {
        held = null;
        current.onSubmit();
      }
    };
    const visibility = () => {
      if (document.hidden) cancelHeld();
    };
    window.addEventListener("keydown", down, { capture: true });
    window.addEventListener("keyup", up, { capture: true });
    window.addEventListener("blur", cancelHeld);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("keydown", down, { capture: true });
      window.removeEventListener("keyup", up, { capture: true });
      window.removeEventListener("blur", cancelHeld);
      document.removeEventListener("visibilitychange", visibility);
      cancelHeld();
    };
  }, [enabled, sessionId]);
}
