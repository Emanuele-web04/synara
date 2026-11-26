// FILE: RunningChatsQuitCoordinator.tsx
// Purpose: Answers Electron quit requests with the running-chats confirmation, and
//          quits straight away when nothing is running and the question is off.
// Layer: Root web coordinator
// Depends on: Desktop bridge quit IPC, the orchestration store, and the quit-resume RPC.

import { ThreadId } from "@synara/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { useAppSettings } from "~/appSettings";
import { APP_DISPLAY_NAME } from "~/branding";
import {
  listRunningChatsFromDesktopStore,
  quitResumeContinuationPrompt,
  stopRunningChatsForQuit,
  type RunningChatQuitSummary,
} from "~/lib/runningChatsQuitConfirmation";
import { newCommandId } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { useStore } from "~/store";

import { RunningChatsQuitDialog, type RunningChatsQuitDecision } from "./RunningChatsQuitDialog";

export function RunningChatsQuitCoordinator() {
  const { settings } = useAppSettings();
  const settingsRef = useRef(settings);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const [chats, setChats] = useState<ReadonlyArray<RunningChatQuitSummary> | null>(null);
  // True while the resume record is being written: the dialog stays up (inert) so the
  // user does not see a bare window for the bounded wait before the desktop hides it.
  const [quitting, setQuitting] = useState(false);
  const pendingRequestIdRef = useRef<string | null>(null);
  const settlingRequestIdRef = useRef<string | null>(null);
  const chatsRef = useRef<ReadonlyArray<RunningChatQuitSummary> | null>(null);
  const settleRef = useRef<(decision: RunningChatsQuitDecision | null) => void>(() => {});

  const clearQuestion = useCallback(() => {
    pendingRequestIdRef.current = null;
    settlingRequestIdRef.current = null;
    chatsRef.current = null;
    setChats(null);
    setQuitting(false);
  }, []);

  // Stops the running chats and, when asked, writes the resume record the desktop
  // waits for. False means main had already closed the question — it expired or
  // was withdrawn — so nothing was stopped and the caller must not reply.
  const commitAndStopChats = useCallback(
    async (
      chatsToStop: ReadonlyArray<RunningChatQuitSummary>,
      resume: boolean,
    ): Promise<boolean> => {
      const requestId = pendingRequestIdRef.current;
      if (!requestId) {
        return false;
      }
      // Stopping chats is not withdrawable, so the desktop accepts the quit
      // first. A build without the channel keeps the old behavior.
      const beginCommit = window.desktopBridge?.beginQuitConfirmation;
      if (beginCommit && !(await beginCommit({ requestId }))) {
        return false;
      }

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
        ...(resume
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

      if (resume) {
        // The resume record must be durable before the desktop stops the backend;
        // the wait is bounded so quit stays snappy even if the server is slow.
        await stopped;
      } else {
        // Interrupt in the background so the window can close immediately.
        void stopped;
      }
      return true;
    },
    [],
  );

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

      const chatsToStop = chatsRef.current;
      if (!decision || !chatsToStop || chatsToStop.length === 0) {
        clearQuestion();
        reply(decision != null);
        return;
      }

      setQuitting(true);
      const committed = await commitAndStopChats(chatsToStop, decision.resume);

      // A newer question may have replaced this one while the resume record was
      // being written; leave it alone.
      if (pendingRequestIdRef.current !== requestId) {
        return;
      }
      clearQuestion();
      if (committed) reply(true);
    },
    [clearQuestion, commitAndStopChats],
  );

  useEffect(() => {
    settleRef.current = (decision) => {
      void settle(decision);
    };
  }, [settle]);

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

      // The question appears when work is in flight, and only while the person
      // still wants to be asked. An unhydrated store cannot prove nothing is
      // running, so it asks.
      const ask =
        settingsRef.current.askBeforeQuitting && (running.length > 0 || !state.threadsHydrated);
      if (!ask) {
        if (running.length === 0) {
          pendingRequestIdRef.current = null;
          reply({ requestId: request.requestId, phase: "decision", allow: true });
          return;
        }
        // No question, but the person turned it off while expecting their chats
        // back: the resume record still has to be written before the desktop goes.
        settlingRequestIdRef.current = request.requestId;
        void commitAndStopChats(running, settingsRef.current.resumeChatsAfterQuit).then(
          (committed) => {
            if (pendingRequestIdRef.current !== request.requestId) return;
            clearQuestion();
            if (committed) {
              reply({ requestId: request.requestId, phase: "decision", allow: true });
            }
          },
        );
        return;
      }

      chatsRef.current = running;
      reply({ requestId: request.requestId, phase: "ready" });
      setChats(running);
    });
  }, [clearQuestion, commitAndStopChats]);

  // A repeated ⌘Q confirms the same open question, so the resume choice and the
  // interrupt run exactly as if the user had pressed Quit.
  useEffect(() => {
    const subscribe = window.desktopBridge?.onQuitConfirmationRepeat;
    if (typeof subscribe !== "function") return;
    return subscribe((reference) => {
      if (pendingRequestIdRef.current !== reference.requestId) return;
      settleRef.current({ resume: settingsRef.current.resumeChatsAfterQuit });
    });
  }, []);

  // The app withdrew a question it stopped waiting on, such as one left open
  // when the window closes. Take it down without quitting.
  useEffect(() => {
    const subscribe = window.desktopBridge?.onQuitConfirmationWithdrawn;
    if (typeof subscribe !== "function") return;
    return subscribe((withdrawal) => {
      if (pendingRequestIdRef.current !== withdrawal.requestId) return;
      clearQuestion();
    });
  }, [clearQuestion]);

  return (
    <RunningChatsQuitDialog
      chats={chats}
      quitting={quitting}
      onStay={() => void settle(null)}
      onQuit={(decision) => void settle(decision)}
    />
  );
}
