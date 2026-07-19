// FILE: useComposerVoiceController.ts
// Purpose: Own the composer voice-note state machine for recording, cancellation, and transcription.
// Layer: Chat composer hook
// Depends on: useVoiceRecorder, ChatView voice helper logic, and the native API voice endpoint.

import { type ProviderKind, type ServerProviderStatus, type ThreadId } from "@synara/contracts";
import { useEffect, useRef, useState } from "react";

import type { Project } from "../../types";
import { formatVoiceRecordingDuration, useVoiceRecorder } from "../../lib/voiceRecorder";
import { readNativeApi } from "../../nativeApi";
import { toastManager } from "../ui/toast";
import {
  deriveComposerVoiceState,
  describeVoiceRecordingStartError,
  isVoiceAuthExpiredMessage,
  sanitizeVoiceErrorMessage,
} from "../ChatView.logic";

interface UseComposerVoiceControllerOptions {
  activeProject: Project | undefined;
  activeThreadId: ThreadId | null;
  threadId: ThreadId;
  selectedProvider: ProviderKind;
  activeProviderStatus: ServerProviderStatus | null;
  pendingUserInputCount: number;
  onTranscriptReady: (transcript: string) => void;
  refreshVoiceStatus: () => void;
}

interface UseComposerVoiceControllerResult {
  isVoiceRecording: boolean;
  isVoiceTranscribing: boolean;
  voiceWaveformLevels: readonly number[];
  voiceRecordingDurationLabel: string;
  showVoiceNotesControl: boolean;
  startComposerVoiceRecording: () => Promise<void>;
  submitComposerVoiceRecording: () => Promise<void>;
  cancelComposerVoiceRecording: () => void;
}

// Keeps the async transcription lifecycle out of ChatView so the component can stay UI-focused.
export function useComposerVoiceController(
  options: UseComposerVoiceControllerOptions,
): UseComposerVoiceControllerResult {
  const {
    activeProject,
    activeThreadId,
    threadId,
    selectedProvider,
    activeProviderStatus,
    pendingUserInputCount,
    onTranscriptReady,
    refreshVoiceStatus,
  } = options;
  const {
    isRecording: isVoiceRecording,
    durationMs: voiceRecordingDurationMs,
    waveformLevels: voiceWaveformLevels,
    startRecording: startVoiceRecording,
    stopRecording: stopVoiceRecording,
    cancelRecording: cancelVoiceRecording,
  } = useVoiceRecorder();
  const [isVoiceTranscribing, setIsVoiceTranscribing] = useState(false);
  const voiceTranscriptionRequestIdRef = useRef(0);
  const voiceThreadIdRef = useRef(threadId);
  const voiceProviderRef = useRef<ProviderKind>(selectedProvider);
  // Mirrored in an effect (not during render) so the hook stays eligible for
  // React Compiler; the transcription flow only reads these post-commit.
  useEffect(() => {
    voiceThreadIdRef.current = threadId;
    voiceProviderRef.current = selectedProvider;
  }, [threadId, selectedProvider]);

  const voiceRecordingDurationLabel = formatVoiceRecordingDuration(voiceRecordingDurationMs);
  const { canStartVoiceNotes, showVoiceNotesControl } = deriveComposerVoiceState({
    authStatus: activeProviderStatus?.authStatus,
    voiceTranscriptionAvailable: activeProviderStatus?.voiceTranscriptionAvailable,
    isRecording: isVoiceRecording,
    isTranscribing: isVoiceTranscribing,
  });

  useEffect(() => {
    voiceTranscriptionRequestIdRef.current += 1;
    // The spinner reset rides the cancel promise so no state is written
    // synchronously inside the effect (keeps the hook compiler-eligible).
    void cancelVoiceRecording().finally(() => setIsVoiceTranscribing(false));
  }, [cancelVoiceRecording, threadId]);

  useEffect(() => {
    if (canStartVoiceNotes || !isVoiceRecording) {
      return;
    }
    voiceTranscriptionRequestIdRef.current += 1;
    void cancelVoiceRecording().finally(() => setIsVoiceTranscribing(false));
  }, [canStartVoiceNotes, cancelVoiceRecording, isVoiceRecording]);

  const startComposerVoiceRecording = async () => {
    if (!activeProject) {
      return;
    }
    if (activeProviderStatus?.authStatus === "unauthenticated") {
      toastManager.add({
        type: "error",
        title: "Sign in to ChatGPT in Codex before using voice notes.",
      });
      return;
    }
    if (!canStartVoiceNotes) {
      toastManager.add({
        type: "error",
        title: "Voice notes require a ChatGPT-authenticated Codex session.",
      });
      return;
    }
    if (pendingUserInputCount > 0) {
      toastManager.add({
        type: "error",
        title: "Answer plan questions before recording a voice note.",
      });
      return;
    }

    try {
      await startVoiceRecording();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not start recording",
        description: describeVoiceRecordingStartError(error),
      });
    }
  };

  const submitComposerVoiceRecording = (): Promise<void> => {
    if (!activeProject || !isVoiceRecording) {
      return Promise.resolve();
    }

    const api = readNativeApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Voice transcription is unavailable right now.",
      });
      void cancelVoiceRecording();
      return Promise.resolve();
    }

    setIsVoiceTranscribing(true);
    const requestId = voiceTranscriptionRequestIdRef.current + 1;
    voiceTranscriptionRequestIdRef.current = requestId;
    const requestThreadId = threadId;
    const requestProvider = selectedProvider;
    const isCurrentVoiceRequest = () =>
      voiceTranscriptionRequestIdRef.current === requestId &&
      voiceThreadIdRef.current === requestThreadId &&
      voiceProviderRef.current === requestProvider;

    // Promise chain instead of async/try-catch-finally: React Compiler does
    // not yet support try/finally, and it would skip optimizing this hook.
    return stopVoiceRecording()
      .then((payload) => {
        if (!isCurrentVoiceRequest()) {
          return;
        }
        if (!payload) {
          toastManager.add({
            type: "warning",
            title: "No audio was captured.",
          });
          return;
        }
        return api.server
          .transcribeVoice({
            provider: "codex",
            cwd: activeProject.cwd,
            ...(activeThreadId ? { threadId: activeThreadId } : {}),
            ...payload,
          })
          .then((result) => {
            if (!isCurrentVoiceRequest()) {
              return;
            }
            onTranscriptReady(result.text);
          });
      })
      .catch((error: unknown) => {
        if (!isCurrentVoiceRequest()) {
          return;
        }

        const description =
          error instanceof Error
            ? sanitizeVoiceErrorMessage(error.message)
            : "The voice note could not be transcribed.";
        const authExpired = isVoiceAuthExpiredMessage(description);
        if (authExpired) {
          refreshVoiceStatus();
        }
        toastManager.add({
          type: "error",
          title: authExpired ? "Sign in to ChatGPT again" : "Voice transcription failed",
          description: authExpired
            ? "Voice transcription uses your ChatGPT session in Codex. That session was rejected, so sign in again there and retry."
            : description,
          ...(authExpired
            ? {
                actionProps: {
                  children: "Refresh status",
                  onClick: refreshVoiceStatus,
                },
              }
            : {}),
        });
      })
      .finally(() => {
        if (isCurrentVoiceRequest()) {
          setIsVoiceTranscribing(false);
        }
      })
      .then(() => undefined);
  };

  const cancelComposerVoiceRecording = () => {
    voiceTranscriptionRequestIdRef.current += 1;
    setIsVoiceTranscribing(false);
    void cancelVoiceRecording();
  };

  return {
    isVoiceRecording,
    isVoiceTranscribing,
    voiceWaveformLevels,
    voiceRecordingDurationLabel,
    showVoiceNotesControl,
    startComposerVoiceRecording,
    submitComposerVoiceRecording,
    cancelComposerVoiceRecording,
  };
}
