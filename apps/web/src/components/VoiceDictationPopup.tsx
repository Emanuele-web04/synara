// FILE: VoiceDictationPopup.tsx
// Purpose: Floating voice dictation popup triggered by holding right-Option.
// Layer: Web UI overlay (position: fixed, z-50)
// Why: Lets users dictate into ANY text field, not just the composer. Hold
//      right-Option → popup appears at cursor → click mic → record → transcribe
//      → text inserted at the currently focused element.

import { useCallback, useEffect, useRef, useState } from "react";

import { useAppSettings } from "~/appSettings";
import { Button } from "~/components/ui/button";
import { formatVoiceRecordingDuration, useVoiceRecorder } from "~/lib/voiceRecorder";
import { readNativeApi } from "~/nativeApi";
import { toastManager } from "~/components/ui/toast";
import { sanitizeVoiceErrorMessage } from "~/components/ChatView.logic";
import { cn } from "~/lib/utils";

const POPUP_WIDTH = 280;
const POPUP_HEIGHT = 120;

function isRightOptionKey(event: KeyboardEvent): boolean {
  // Right Alt = AltGraph on Windows, Alt on Mac with event.code "AltRight".
  // On Mac, left Option is "AltLeft", right Option is "AltRight".
  return event.code === "AltRight" && event.altKey;
}

export function VoiceDictationPopup() {
  const { settings } = useAppSettings();
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isTranscribing, setIsTranscribing] = useState(false);
  const lastFocusedElementRef = useRef<HTMLElement | null>(null);
  const rightOptionHeldRef = useRef(false);
  const rightOptionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mousePosRef = useRef({ x: 100, y: 100 });

  const {
    isRecording,
    durationMs,
    waveformLevels,
    startRecording,
    stopRecording,
    cancelRecording,
  } = useVoiceRecorder();

  // Show popup on right-Option hold (200ms threshold to distinguish from quick taps).
  useEffect(() => {
    if (!settings.voiceDictationEnabled) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (!isRightOptionKey(event) || rightOptionHeldRef.current) return;
      rightOptionHeldRef.current = true;
      // Remember the currently focused element for text insertion.
      lastFocusedElementRef.current = document.activeElement as HTMLElement | null;
      // Position popup near last known mouse position.
      const x = Math.min(mousePosRef.current.x, window.innerWidth - POPUP_WIDTH - 16);
      const y = Math.min(mousePosRef.current.y, window.innerHeight - POPUP_HEIGHT - 16);
      setPosition({ x: Math.max(16, x), y: Math.max(16, y) });
      // Hold threshold: show popup after 200ms.
      if (rightOptionTimerRef.current) clearTimeout(rightOptionTimerRef.current);
      rightOptionTimerRef.current = setTimeout(() => {
        setVisible(true);
      }, 200);
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (!isRightOptionKey(event)) return;
      rightOptionHeldRef.current = false;
      if (rightOptionTimerRef.current) {
        clearTimeout(rightOptionTimerRef.current);
        rightOptionTimerRef.current = null;
      }
    };

    const onMouseMove = (event: MouseEvent) => {
      mousePosRef.current = { x: event.clientX, y: event.clientY };
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("mousemove", onMouseMove);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("mousemove", onMouseMove);
      if (rightOptionTimerRef.current) clearTimeout(rightOptionTimerRef.current);
    };
  }, [settings.voiceDictationEnabled]);

  const insertTextAtCursor = useCallback((text: string) => {
    const el = lastFocusedElementRef.current;
    if (!el) return;

    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      const newValue = el.value.slice(0, start) + text + el.value.slice(end);
      el.value = newValue;
      el.setSelectionRange(start + text.length, start + text.length);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }

    // contentEditable: insert at cursor via document.execCommand (deprecated but
    // still works in all browsers; the alternative is a complex Range API dance).
    if (el.isContentEditable) {
      el.focus();
      document.execCommand("insertText", false, text);
      return;
    }
  }, []);

  const handleTranscribe = useCallback(async () => {
    const api = readNativeApi();
    if (!api) {
      toastManager.add({ type: "error", title: "Voice transcription is unavailable." });
      return;
    }
    setIsTranscribing(true);
    try {
      const payload = await stopRecording();
      if (!payload) {
        toastManager.add({ type: "warning", title: "No audio was captured." });
        return;
      }
      // The popup always uses local whisper — it's for dictating into any text
      // field, not tied to a specific thread/provider. No auth needed.
      const result = await api.server.transcribeVoice({
        provider: "claudeAgent",
        cwd: ".",
        ...payload,
        voiceDictationModel: settings.voiceDictationModel,
        ...(settings.voiceDictionary.length > 0
          ? { voiceDictionary: settings.voiceDictionary }
          : {}),
      });
      insertTextAtCursor(result.text);
    } catch (error) {
      const description =
        error instanceof Error
          ? sanitizeVoiceErrorMessage(error.message)
          : "The voice note could not be transcribed.";
      toastManager.add({ type: "error", title: description });
    } finally {
      setIsTranscribing(false);
      setVisible(false);
    }
  }, [stopRecording, insertTextAtCursor, settings]);

  const handleCancel = useCallback(() => {
    void cancelRecording();
    setVisible(false);
  }, [cancelRecording]);

  if (!settings.voiceDictationEnabled) return null;

  return (
    <>
      {visible && (
        <div
          className="pointer-events-auto fixed z-50 flex flex-col gap-2 rounded-lg border border-border/60 bg-background/95 p-3 shadow-lg backdrop-blur-md"
          style={{ left: position.x, top: position.y, width: POPUP_WIDTH }}
        >
          <div className="flex items-center gap-2">
            <MicIcon className="size-4 text-muted-foreground" />
            <span className="text-xs font-medium text-foreground">
              {isRecording
                ? "Recording..."
                : isTranscribing
                  ? "Transcribing..."
                  : "Voice dictation"}
            </span>
            {isRecording && (
              <span className="ml-auto text-xs text-muted-foreground">
                {formatVoiceRecordingDuration(durationMs)}
              </span>
            )}
          </div>
          {isRecording && waveformLevels.length > 0 && (
            <div className="flex h-6 items-center gap-0.5">
              {/* eslint-disable react/no-array-index-key -- waveform bars are transient, index keys are correct */}
              {waveformLevels.slice(0, 32).map((level, i) => (
                <div
                  key={i}
                  className="w-1 rounded-full bg-accent"
                  style={{ height: `${Math.max(2, level * 24)}px` }}
                />
              ))}
              {/* eslint-enable react/no-array-index-key */}
            </div>
          )}
          <div className="flex gap-2">
            {!isRecording && !isTranscribing && (
              <Button
                size="sm"
                variant="default"
                className="flex-1"
                onClick={() => void startRecording()}
              >
                Start recording
              </Button>
            )}
            {isRecording && (
              <Button
                size="sm"
                variant="default"
                className="flex-1"
                onClick={() => void handleTranscribe()}
              >
                Stop & transcribe
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={handleCancel}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

function MicIcon({ className }: { className?: string }) {
  return (
    <svg
      className={cn("shrink-0", className)}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" x2="12" y1="19" y2="22" />
    </svg>
  );
}
