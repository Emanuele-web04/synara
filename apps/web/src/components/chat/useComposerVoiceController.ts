// FILE: useComposerVoiceController.ts
// Purpose: Own the composer voice-note state machine for recording, cancellation, and transcription.
// Layer: Chat composer hook
// Depends on: useVoiceRecorder, the live dictation stream, ChatView voice helper logic, and the
// native API voice endpoints.

import {
  type ProviderInstanceId,
  type ProviderKind,
  type ServerProviderStatus,
  type ThreadId,
} from "@synara/contracts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { Project } from "../../types";
import {
  formatVoiceRecordingDuration,
  isVoiceRecordingCancelledError,
  useVoiceRecorder,
} from "../../lib/voiceRecorder";
import {
  startVoiceDictationStream,
  type VoiceDictationStream,
} from "../../lib/voiceDictationStream";
import { readNativeApi } from "../../nativeApi";
import type { RefreshProviderStatusesNow } from "../../hooks/useProviderStatusRefresh";
import { toastManager, reportToastIssue } from "../ui/toast";
import { diagnosticIssueReason } from "../../lib/rendererErrorDiagnostics";
import {
  deriveComposerVoiceState,
  describeVoiceRecordingStartError,
  isVoiceAuthExpiredMessage,
  sanitizeVoiceErrorMessage,
} from "../ChatView.logic";

export interface ComposerVoiceFailureCopy {
  transcriptionFailedTitle: string;
  fallbackDescription: string;
  authExpiredTitle: string;
  authExpiredDescription: string;
  refreshActionLabel: string;
}

interface ComposerVoiceGuardDetails {
  readonly [key: string]: unknown;
}

export interface UseComposerVoiceControllerOptions {
  activeProject: Project | undefined;
  activeThreadId: ThreadId | null;
  threadId: ThreadId;
  selectedProvider: ProviderKind;
  selectedProviderInstanceId: ProviderInstanceId;
  voiceProviderInstanceId: ProviderInstanceId;
  activeProviderStatus: ServerProviderStatus | null;
  pendingUserInputCount: number;
  onTranscriptReady: (transcript: string) => void;
  /**
   * Receives the live transcript while dictating, or null when it should be
   * dropped (cancel, failure). The final text still arrives via onTranscriptReady.
   */
  onLiveTranscript?: (transcript: string | null) => void;
  refreshVoiceStatus: RefreshProviderStatusesNow;
  actionArmDelayMs?: number;
  failureCopy?: Partial<ComposerVoiceFailureCopy>;
  onGuardWarning?: (message: string, details: ComposerVoiceGuardDetails) => void;
}

export interface UseComposerVoiceControllerResult {
  isVoiceRecording: boolean;
  // The microphone is opening; nothing is recording yet.
  isVoiceStarting: boolean;
  // Recording, but the device has not delivered real audio yet.
  isVoiceWaitingForAudio: boolean;
  isVoiceTranscribing: boolean;
  voiceWaveformLevels: readonly number[];
  voiceRecordingDurationLabel: string;
  showVoiceNotesControl: boolean;
  startComposerVoiceRecording: () => Promise<void>;
  // Resolves true only when a current transcript reached onTranscriptReady.
  submitComposerVoiceRecording: () => Promise<boolean>;
  cancelComposerVoiceRecording: () => void;
}

const DEFAULT_FAILURE_COPY: ComposerVoiceFailureCopy = {
  transcriptionFailedTitle: "Voice transcription failed",
  fallbackDescription: "The voice note could not be transcribed.",
  authExpiredTitle: "Sign in to ChatGPT again",
  authExpiredDescription:
    "Voice transcription uses your ChatGPT session in Codex. That session was rejected, so sign in again there and retry.",
  refreshActionLabel: "Refresh status",
};

// Keeps the async transcription lifecycle out of ChatView so the component can stay UI-focused.
export function useComposerVoiceController(
  options: UseComposerVoiceControllerOptions,
): UseComposerVoiceControllerResult {
  const {
    activeProject,
    activeThreadId,
    threadId,
    selectedProvider,
    selectedProviderInstanceId,
    voiceProviderInstanceId,
    activeProviderStatus,
    pendingUserInputCount,
    onTranscriptReady,
    onLiveTranscript,
    refreshVoiceStatus,
    actionArmDelayMs: actionArmDelayMsProp,
    failureCopy: failureCopyOverrides,
    onGuardWarning,
  } = options;
  const actionArmDelayMs = actionArmDelayMsProp ?? 0;
  const {
    isRecording: isVoiceRecording,
    isStarting: isVoiceStarting,
    hasAudioSignal: hasVoiceAudioSignal,
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
  const composerProviderInstanceRef = useRef<ProviderInstanceId>(selectedProviderInstanceId);
  const voiceProviderInstanceRef = useRef<ProviderInstanceId>(voiceProviderInstanceId);
  const voiceRecordingStartedAtRef = useRef<number | null>(null);
  // The live stream of the current recording; null when the server cannot stream.
  const dictationStreamRef = useRef<VoiceDictationStream | null>(null);
  const onLiveTranscriptRef = useRef(onLiveTranscript);
  const failureCopy = {
    ...DEFAULT_FAILURE_COPY,
    ...failureCopyOverrides,
  };
  // A transcription can resolve immediately after navigation commits, so stamp
  // its identity before passive effects and browser events can observe it.
  useLayoutEffect(() => {
    voiceThreadIdRef.current = threadId;
    voiceProviderRef.current = selectedProvider;
    composerProviderInstanceRef.current = selectedProviderInstanceId;
    voiceProviderInstanceRef.current = voiceProviderInstanceId;
    onLiveTranscriptRef.current = onLiveTranscript;
  }, [
    threadId,
    selectedProvider,
    selectedProviderInstanceId,
    voiceProviderInstanceId,
    onLiveTranscript,
  ]);

  // Drops the live stream of the current recording and any text it showed.
  const discardDictationStream = () => {
    const stream = dictationStreamRef.current;
    dictationStreamRef.current = null;
    if (!stream) return;
    stream.cancel();
    onLiveTranscriptRef.current?.(null);
  };

  const voiceRecordingDurationLabel = formatVoiceRecordingDuration(voiceRecordingDurationMs);
  const { canStartVoiceNotes, showVoiceNotesControl } = deriveComposerVoiceState({
    enabled: activeProviderStatus?.enabled,
    available: activeProviderStatus?.available === true,
    authStatus: activeProviderStatus?.authStatus,
    voiceTranscriptionAvailable: activeProviderStatus?.voiceTranscriptionAvailable,
    isRecording: isVoiceRecording,
    isTranscribing: isVoiceTranscribing,
  });

  useEffect(() => {
    const invalidatedRequestId = voiceTranscriptionRequestIdRef.current + 1;
    voiceTranscriptionRequestIdRef.current = invalidatedRequestId;
    voiceRecordingStartedAtRef.current = null;
    discardDictationStream();
    // The spinner reset rides the cancel promise so no state is written
    // synchronously inside the effect (keeps the hook compiler-eligible).
    void cancelVoiceRecording().finally(() => {
      if (voiceTranscriptionRequestIdRef.current === invalidatedRequestId) {
        setIsVoiceTranscribing(false);
      }
    });
  }, [
    cancelVoiceRecording,
    selectedProvider,
    selectedProviderInstanceId,
    threadId,
    voiceProviderInstanceId,
  ]);

  useEffect(
    () => () => {
      voiceTranscriptionRequestIdRef.current += 1;
      voiceRecordingStartedAtRef.current = null;
      dictationStreamRef.current?.cancel();
      dictationStreamRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (canStartVoiceNotes || !isVoiceRecording) {
      return;
    }
    onGuardWarning?.("cancelled active voice recording because voice became unavailable", {
      authStatus: activeProviderStatus?.authStatus ?? null,
      voiceTranscriptionAvailable: activeProviderStatus?.voiceTranscriptionAvailable ?? null,
      isVoiceRecording,
    });
    const invalidatedRequestId = voiceTranscriptionRequestIdRef.current + 1;
    voiceTranscriptionRequestIdRef.current = invalidatedRequestId;
    voiceRecordingStartedAtRef.current = null;
    discardDictationStream();
    void cancelVoiceRecording().finally(() => {
      if (voiceTranscriptionRequestIdRef.current === invalidatedRequestId) {
        setIsVoiceTranscribing(false);
      }
    });
  }, [
    activeProviderStatus?.authStatus,
    activeProviderStatus?.voiceTranscriptionAvailable,
    canStartVoiceNotes,
    cancelVoiceRecording,
    isVoiceRecording,
    onGuardWarning,
  ]);

  const isVoiceActionArmed = () => {
    if (actionArmDelayMs <= 0 || voiceRecordingStartedAtRef.current === null) {
      return true;
    }
    const recordedForMs = Math.round(performance.now() - voiceRecordingStartedAtRef.current);
    if (recordedForMs < 0 || recordedForMs >= actionArmDelayMs) {
      return true;
    }
    onGuardWarning?.("ignored recorder action immediately after start", {
      recordedForMs,
    });
    return false;
  };

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

    discardDictationStream();
    const api = readNativeApi();
    const voiceRequest = {
      provider: "codex" as const,
      providerInstanceId: voiceProviderInstanceId,
      cwd: activeProject.cwd,
      ...(activeThreadId ? { threadId: activeThreadId } : {}),
    };
    // Connect while the microphone opens; audio captured before the session
    // is ready waits in the stream's buffer.
    const stream = api
      ? startVoiceDictationStream({
          api: api.server,
          request: voiceRequest,
          onTranscript: (text) => {
            if (dictationStreamRef.current === stream) {
              onLiveTranscriptRef.current?.(text);
            }
          },
        })
      : null;
    dictationStreamRef.current = stream;
    try {
      await startVoiceRecording(
        stream ? { onAudioChunk: (samples, rate) => stream.pushAudio(samples, rate) } : undefined,
      );
      voiceRecordingStartedAtRef.current = performance.now();
      void api?.server.prewarmVoice?.(voiceRequest).catch(() => undefined);
    } catch (error) {
      if (dictationStreamRef.current === stream) {
        discardDictationStream();
      }
      if (isVoiceRecordingCancelledError(error)) {
        return;
      }
      const toastId = toastManager.add({
        type: "error",
        title: "Could not start recording",
        description: describeVoiceRecordingStartError(error),
      });
      reportToastIssue(toastId, {
        code: "voice.record.failed",
        reason: diagnosticIssueReason(error),
      });
    }
  };

  const submitComposerVoiceRecording = (): Promise<boolean> => {
    if (!activeProject || !isVoiceRecording) {
      return Promise.resolve(false);
    }
    if (!isVoiceActionArmed()) {
      return Promise.resolve(false);
    }

    const api = readNativeApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Voice transcription is unavailable right now.",
      });
      void cancelVoiceRecording();
      return Promise.resolve(false);
    }

    setIsVoiceTranscribing(true);
    const startedAt = performance.now();
    let transcriptionStarted = false;
    const requestId = voiceTranscriptionRequestIdRef.current + 1;
    voiceTranscriptionRequestIdRef.current = requestId;
    const requestThreadId = threadId;
    const requestProvider = selectedProvider;
    const requestProviderInstanceId = selectedProviderInstanceId;
    const requestVoiceProviderInstanceId = voiceProviderInstanceId;
    const isCurrentVoiceRequest = () =>
      voiceTranscriptionRequestIdRef.current === requestId &&
      voiceThreadIdRef.current === requestThreadId &&
      voiceProviderRef.current === requestProvider &&
      composerProviderInstanceRef.current === requestProviderInstanceId &&
      voiceProviderInstanceRef.current === requestVoiceProviderInstanceId;
    const dictationStream = dictationStreamRef.current;
    const discardLiveTranscript = () => {
      if (dictationStreamRef.current !== dictationStream) return;
      dictationStreamRef.current = null;
      if (dictationStream) {
        dictationStream.cancel();
        onLiveTranscriptRef.current?.(null);
      }
    };

    // Promise chain instead of async/try-catch-finally: React Compiler does
    // not yet support try/finally, and it would skip optimizing this hook.
    return stopVoiceRecording()
      .then((payload): Promise<boolean> | boolean => {
        if (!isCurrentVoiceRequest()) {
          dictationStream?.cancel();
          return false;
        }
        if (!payload) {
          discardLiveTranscript();
          toastManager.add({
            type: "warning",
            title: "No audio was captured.",
          });
          return false;
        }
        transcriptionStarted = true;
        const uploadRecording = () =>
          api.server
            .transcribeVoice({
              provider: "codex",
              providerInstanceId: requestVoiceProviderInstanceId,
              cwd: activeProject.cwd,
              ...(activeThreadId ? { threadId: activeThreadId } : {}),
              ...payload,
            })
            .then((result) => result.text);
        // The live stream already heard everything, so its final text is
        // usually ready right away; a failed or empty stream uploads the clip once.
        const transcript = dictationStream
          ? dictationStream
              .finish()
              .catch(() => "")
              .then((text) => text.trim() || (isCurrentVoiceRequest() ? uploadRecording() : ""))
          : uploadRecording();
        return transcript.then((text) => {
          if (!isCurrentVoiceRequest()) {
            return false;
          }
          if (dictationStreamRef.current === dictationStream) {
            dictationStreamRef.current = null;
          }
          onTranscriptReady(text);
          return true;
        });
      })
      .catch((error: unknown) => {
        if (!isCurrentVoiceRequest()) {
          return false;
        }
        discardLiveTranscript();

        const description =
          error instanceof Error
            ? sanitizeVoiceErrorMessage(error.message)
            : failureCopy.fallbackDescription;
        const authExpired = isVoiceAuthExpiredMessage(description);
        if (authExpired) {
          void refreshVoiceStatus();
        }
        const toastId = toastManager.add({
          type: "error",
          title: authExpired ? failureCopy.authExpiredTitle : failureCopy.transcriptionFailedTitle,
          description: authExpired ? failureCopy.authExpiredDescription : description,
          ...(authExpired
            ? {
                actionProps: {
                  children: failureCopy.refreshActionLabel,
                  onClick: () => {
                    void refreshVoiceStatus();
                  },
                },
              }
            : {}),
        });
        reportToastIssue(toastId, {
          code: transcriptionStarted ? "voice.transcribe.failed" : "voice.record.failed",
          reason: authExpired ? "auth" : diagnosticIssueReason(error),
          durationMs: performance.now() - startedAt,
        });
        return false;
      })
      .finally(() => {
        if (isCurrentVoiceRequest()) {
          voiceRecordingStartedAtRef.current = null;
          setIsVoiceTranscribing(false);
        }
      });
  };

  const cancelComposerVoiceRecording = () => {
    if (!isVoiceActionArmed()) {
      return;
    }
    voiceTranscriptionRequestIdRef.current += 1;
    voiceRecordingStartedAtRef.current = null;
    discardDictationStream();
    setIsVoiceTranscribing(false);
    void cancelVoiceRecording();
  };

  return {
    isVoiceRecording,
    isVoiceStarting,
    isVoiceWaitingForAudio: isVoiceRecording && !hasVoiceAudioSignal,
    isVoiceTranscribing,
    voiceWaveformLevels,
    voiceRecordingDurationLabel,
    showVoiceNotesControl,
    startComposerVoiceRecording,
    submitComposerVoiceRecording,
    cancelComposerVoiceRecording,
  };
}
