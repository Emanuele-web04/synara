// FILE: RunningChatsQuitCoordinator.tsx
// Purpose: Answers Electron quit requests with the running-chats confirmation.
// Layer: Root web coordinator
// Depends on: Desktop bridge quit IPC, the orchestration store, and the quit-resume RPC.

import { ThreadId } from "@synara/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { useAppSettings } from "~/appSettings";
import { APP_DISPLAY_NAME } from "~/branding";
import { desktopQuitAsks, useDesktopQuitPreference } from "~/hooks/useDesktopQuitPreference";
import {
  listRunningChatsFromDesktopStore,
  quitResumeContinuationPrompt,
  stopRunningChatsForQuit,
  verifyDesktopChatsIdle,
  type RunningChatQuitSummary,
} from "~/lib/runningChatsQuitConfirmation";
import { newCommandId } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { useStore } from "~/store";

import { RunningChatsQuitDialog, type RunningChatsQuitDecision } from "./RunningChatsQuitDialog";

export function RunningChatsQuitCoordinator() {
  const { settings } = useAppSettings();
  const [chats, setChats] = useState<ReadonlyArray<RunningChatQuitSummary> | null>(null);
  // True while the resume record is being written: the dialog stays up (inert) so the
  // user does not see a bare window for the bounded wait before the desktop hides it.
  const [quitting, setQuitting] = useState(false);
  const pendingRequestIdRef = useRef<string | null>(null);
  const settlingRequestIdRef = useRef<string | null>(null);
  const chatsRef = useRef<ReadonlyArray<RunningChatQuitSummary> | null>(null);
  const readyRequestIdRef = useRef<string | null>(null);
  const settleRef = useRef<(decision: RunningChatsQuitDecision | null) => void>(() => {});

  // Loads the idle-quit choice once and keeps this renderer's copy current.
  useDesktopQuitPreference();

  const clearQuestion = useCallback((requestId: string) => {
    if (pendingRequestIdRef.current !== requestId) return;
    pendingRequestIdRef.current = null;
    settlingRequestIdRef.current = null;
    chatsRef.current = null;
    setChats(null);
    setQuitting(false);
  }, []);

  const settle = useCallback(
    async (decision: RunningChatsQuitDecision | null) => {
      const requestId = pendingRequestIdRef.current;
      if (!requestId || settlingRequestIdRef.current === requestId) {
        return;
      }
      settlingRequestIdRef.current = requestId;

      const reply = (allow: boolean) => {
        window.desktopBridge?.replyQuitConfirmation({
          requestId,
          phase: "decision",
          allow,
        });
      };

      if (!decision) {
        clearQuestion(requestId);
        reply(false);
        return;
      }

      const chatsToStop = chatsRef.current;
      if (!chatsToStop || chatsToStop.length === 0) {
        clearQuestion(requestId);
        reply(true);
        return;
      }

      // Main accepts the answer before any interrupt or resume write starts. A
      // question that expired or was withdrawn returns false, so a late click
      // cannot stop chats while Synara stays open. Without the handshake, quit
      // plainly and let desktop shutdown stop the work.
      const begin = window.desktopBridge?.beginQuitConfirmation;
      if (typeof begin !== "function") {
        clearQuestion(requestId);
        reply(true);
        return;
      }
      const accepted = await begin({ requestId }).catch(() => false);
      if (!accepted || pendingRequestIdRef.current !== requestId) {
        clearQuestion(requestId);
        return;
      }

      setQuitting(true);
      const stopped = stopRunningChatsForQuit({
        chats: chatsToStop,
        dispatchInterrupt: (threadId) => {
          const api = readNativeApi();
          if (!api) {
            return;
          }
          return api.orchestration.dispatchCommand({
            type: "thread.turn.interrupt",
            commandId: newCommandId(),
            threadId: ThreadId.makeUnsafe(threadId),
            createdAt: new Date().toISOString(),
          });
        },
        ...(decision.resume
          ? {
              resume: {
                prepare: (threadIds: ReadonlyArray<string>) => {
                  const api = readNativeApi();
                  if (!api) {
                    return Promise.reject(new Error("Native API unavailable"));
                  }
                  return api.orchestration.prepareQuitResume({
                    threadIds: threadIds.map((threadId) => ThreadId.makeUnsafe(threadId)),
                    continuationPrompt: quitResumeContinuationPrompt(APP_DISPLAY_NAME),
                  });
                },
              },
            }
          : {}),
      });

      if (decision.resume) {
        // The resume record must be durable before the desktop is allowed to stop the
        // backend; the wait is bounded so quit stays snappy even if the server is slow.
        await stopped;
      } else {
        // Interrupt in the background so the window can close immediately.
        void stopped;
      }

      if (pendingRequestIdRef.current !== requestId) {
        clearQuestion(requestId);
        return;
      }
      clearQuestion(requestId);
      reply(true);
    },
    [clearQuestion],
  );

  useEffect(() => {
    settleRef.current = (decision) => {
      void settle(decision);
    };
  }, [settle]);

  // Only acknowledge once the dialog is mounted. The repeat quit is gated on
  // this ack, so a second keypress cannot confirm a question nobody saw.
  useEffect(() => {
    const requestId = readyRequestIdRef.current;
    if (!chats || !requestId || pendingRequestIdRef.current !== requestId) return;
    readyRequestIdRef.current = null;
    window.desktopBridge?.replyQuitConfirmation({
      requestId,
      phase: "ready",
      runningCount: chats.length,
      chats,
    });
  }, [chats]);

  useEffect(() => {
    const subscribe = window.desktopBridge?.onQuitConfirmationRequest;
    const reply = window.desktopBridge?.replyQuitConfirmation;
    if (typeof subscribe !== "function" || typeof reply !== "function") {
      return;
    }

    return subscribe((request) => {
      const state = useStore.getState();
      const running = listRunningChatsFromDesktopStore(state);
      pendingRequestIdRef.current = request.requestId;
      settlingRequestIdRef.current = null;

      const showQuestion = () => {
        if (pendingRequestIdRef.current !== request.requestId) return;
        chatsRef.current = running;
        readyRequestIdRef.current = request.requestId;
        window.desktopBridge?.revealQuitConfirmation?.(request.requestId);
        setChats(running);
      };

      // The question can be turned off for an idle quit. Answer before showing
      // anything, so the window is not brought up for a quit nobody sees. Wait
      // for hydration: an unloaded store is not proof that nothing is running,
      // and the server check catches queued or background work the store missed.
      if (running.length === 0 && state.threadsHydrated && !desktopQuitAsks()) {
        void verifyDesktopChatsIdle().then((idle) => {
          if (pendingRequestIdRef.current !== request.requestId) return;
          if (!idle) {
            showQuestion();
            return;
          }
          pendingRequestIdRef.current = null;
          chatsRef.current = null;
          reply({
            requestId: request.requestId,
            phase: "ready",
            runningCount: 0,
            chats: [],
          });
          reply({ requestId: request.requestId, phase: "decision", allow: true });
        });
        return;
      }
      showQuestion();
    });
  }, []);

  // A repeated ⌘Q asks the page to answer the same open question, so the
  // resume choice and preparation run exactly as if the user clicked Quit.
  useEffect(() => {
    const subscribe = window.desktopBridge?.onQuitConfirmationRepeat;
    if (typeof subscribe !== "function") return;
    return subscribe((reference) => {
      if (pendingRequestIdRef.current !== reference.requestId) return;
      settleRef.current({ resume: settings.resumeChatsAfterQuit });
    });
  }, [settings.resumeChatsAfterQuit]);

  // The app withdraws a question it stopped waiting on, such as one left
  // silent past the answer timeout. Take it down without quitting.
  useEffect(() => {
    const subscribe = window.desktopBridge?.onQuitConfirmationWithdrawn;
    if (typeof subscribe !== "function") return;
    return subscribe((withdrawal) => {
      if (pendingRequestIdRef.current !== withdrawal.requestId) return;
      pendingRequestIdRef.current = null;
      settlingRequestIdRef.current = null;
      chatsRef.current = null;
      setChats(null);
      setQuitting(false);
    });
  }, []);

  return (
    <RunningChatsQuitDialog
      chats={chats}
      quitting={quitting}
      onStay={() => void settle(null)}
      onQuit={(decision) => void settle(decision)}
    />
  );
}
