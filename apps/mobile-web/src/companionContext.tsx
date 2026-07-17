import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  CompanionGateway,
  CompanionSession,
  ComposerOption,
  ConnectionPhase,
  CreateThreadInput,
  NotificationSettings,
  ShellSnapshot,
  ThreadDetail,
  ThreadDiff,
  SendTurnInput,
} from "./domain";
import { createBrowserCompanionGateway } from "./lib/browserGateway";
import { clearCompanionMutationState } from "./lib/requestIds";

const emptyShell: ShellSnapshot = { sequence: 0, projects: [], threads: [] };

interface CompanionContextValue {
  readonly phase: ConnectionPhase;
  readonly session: CompanionSession | null;
  readonly shell: ShellSnapshot;
  readonly threads: ReadonlyMap<string, ThreadDetail>;
  readonly diffs: ReadonlyMap<string, ThreadDiff>;
  readonly lastError: string | null;
  pair(token: string, deviceLabel: string): Promise<void>;
  updateDeviceLabel(deviceLabel: string): Promise<void>;
  retry(): Promise<void>;
  refresh(): Promise<void>;
  loadThread(threadId: string): Promise<ThreadDetail>;
  loadDiff(threadId: string): Promise<ThreadDiff>;
  getComposerOptions(projectId: string): Promise<readonly ComposerOption[]>;
  createThread(input: CreateThreadInput): Promise<ThreadDetail>;
  sendTurn(input: SendTurnInput): Promise<void>;
  interrupt(threadId: string, requestId: string): Promise<void>;
  respondToApproval(
    threadId: string,
    approvalId: string,
    decision: "approve" | "deny",
    requestId: string,
  ): Promise<void>;
  respondToInput(
    threadId: string,
    inputId: string,
    answers: Readonly<Record<string, string | readonly string[]>>,
    requestId: string,
  ): Promise<void>;
  getNotificationSettings(): Promise<NotificationSettings>;
  subscribeToNotifications(previewEnabled: boolean): Promise<NotificationSettings>;
  setNotificationPreview(enabled: boolean): Promise<void>;
  sendTestNotification(): Promise<void>;
  logout(): Promise<void>;
  readonly gateway: CompanionGateway;
}

const CompanionContext = createContext<CompanionContextValue | null>(null);

export function CompanionProvider({ children }: { readonly children: ReactNode }) {
  const gateway = useMemo(() => createBrowserCompanionGateway(), []);
  const connectionRef = useRef<{ close(): void } | null>(null);
  const bootstrapRef = useRef(0);
  const [phase, setPhase] = useState<ConnectionPhase>("checking-session");
  const [session, setSession] = useState<CompanionSession | null>(null);
  const [shell, setShell] = useState<ShellSnapshot>(emptyShell);
  const [threads, setThreads] = useState<ReadonlyMap<string, ThreadDetail>>(new Map());
  const [diffs, setDiffs] = useState<ReadonlyMap<string, ThreadDiff>>(new Map());
  const [lastError, setLastError] = useState<string | null>(null);

  const clearSensitiveState = useCallback(() => {
    setShell(emptyShell);
    setThreads(new Map());
    setDiffs(new Map());
  }, []);

  const connect = useCallback(
    async (signal?: AbortSignal) => {
      const bootstrap = ++bootstrapRef.current;
      connectionRef.current?.close();
      connectionRef.current = null;
      setPhase("connecting");
      setLastError(null);
      try {
        const connection = await gateway.connect(
          {
            onReady: (readySession) => {
              if (bootstrap === bootstrapRef.current) {
                setSession(readySession);
                setLastError(null);
                setPhase("online");
              }
            },
            onShell: (snapshot) => {
              if (bootstrap === bootstrapRef.current) setShell(snapshot);
            },
            onThread: (thread) => {
              if (bootstrap !== bootstrapRef.current) return;
              setThreads((current) => new Map(current).set(thread.id, thread));
            },
            onDisconnect: (reason) => {
              if (bootstrap !== bootstrapRef.current) return;
              clearSensitiveState();
              setLastError(reason);
              setPhase("offline");
            },
            onSessionEnded: (reason) => {
              if (bootstrap !== bootstrapRef.current) return;
              connectionRef.current = null;
              clearSensitiveState();
              clearCompanionMutationState();
              setSession(null);
              setLastError(reason);
              setPhase("unauthenticated");
            },
          },
          signal,
        );
        if (bootstrap !== bootstrapRef.current || signal?.aborted) {
          connection.close();
          return;
        }
        connectionRef.current = connection;
      } catch (error) {
        if (signal?.aborted || bootstrap !== bootstrapRef.current) return;
        clearSensitiveState();
        setLastError(errorMessage(error));
        setPhase("offline");
      }
    },
    [clearSensitiveState, gateway],
  );

  const checkSession = useCallback(
    async (signal?: AbortSignal) => {
      setPhase("checking-session");
      setLastError(null);
      try {
        const nextSession = await gateway.getSession(signal);
        if (signal?.aborted) return;
        if (!nextSession) {
          setSession(null);
          clearSensitiveState();
          clearCompanionMutationState();
          setPhase("unauthenticated");
          return;
        }
        setSession(nextSession);
        await connect(signal);
      } catch (error) {
        if (signal?.aborted) return;
        clearSensitiveState();
        setLastError(errorMessage(error));
        setPhase("offline");
      }
    },
    [clearSensitiveState, connect, gateway],
  );

  useEffect(() => {
    const controller = new AbortController();
    void checkSession(controller.signal);
    return () => {
      controller.abort();
      ++bootstrapRef.current;
      connectionRef.current?.close();
      connectionRef.current = null;
    };
  }, [checkSession]);

  const pair = useCallback(
    async (token: string, deviceLabel: string) => {
      setLastError(null);
      await gateway.pair({ token, deviceLabel });
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
      const nextSession = await gateway.getSession();
      if (!nextSession) throw new Error("The server did not create a companion session.");
      setSession(nextSession);
      await connect();
    },
    [connect, gateway],
  );

  const retry = useCallback(async () => {
    const nextSession = await gateway.getSession();
    if (!nextSession) {
      setSession(null);
      clearCompanionMutationState();
      setPhase("unauthenticated");
      return;
    }
    setSession(nextSession);
    await connect();
  }, [connect, gateway]);

  const updateDeviceLabel = useCallback(
    async (deviceLabel: string) => {
      const savedLabel = await gateway.updateDeviceLabel(deviceLabel);
      setSession((current) =>
        current === null ? current : { ...current, deviceLabel: savedLabel },
      );
    },
    [gateway],
  );

  useEffect(() => {
    const retryWhenAvailable = () => {
      if (phase === "offline") void retry().catch(() => undefined);
    };
    const retryWhenVisible = () => {
      if (document.visibilityState === "visible") retryWhenAvailable();
    };
    window.addEventListener("online", retryWhenAvailable);
    document.addEventListener("visibilitychange", retryWhenVisible);
    return () => {
      window.removeEventListener("online", retryWhenAvailable);
      document.removeEventListener("visibilitychange", retryWhenVisible);
    };
  }, [phase, retry]);

  useEffect(() => {
    // CompanionConnection already owns WS backoff. This loop is only for the
    // initial HTTP/session check, where no connection manager exists yet.
    if (phase !== "offline" || connectionRef.current !== null) return;
    let cancelled = false;
    let timer: number | undefined;
    let attempt = 0;
    const schedule = () => {
      const baseDelay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
      const jitteredDelay = Math.round(baseDelay * (0.8 + Math.random() * 0.4));
      timer = window.setTimeout(() => {
        if (cancelled) return;
        void retry().catch(() => {
          attempt += 1;
          schedule();
        });
      }, jitteredDelay);
    };
    schedule();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [phase, retry]);

  const refresh = useCallback(async () => {
    const snapshot = await gateway.refreshShell();
    setShell(snapshot);
  }, [gateway]);

  const loadThread = useCallback(
    async (threadId: string) => {
      const thread = await gateway.getThread(threadId);
      setThreads((current) => new Map(current).set(threadId, thread));
      return thread;
    },
    [gateway],
  );

  const loadDiff = useCallback(
    async (threadId: string) => {
      const diff = await gateway.getDiff(threadId);
      setDiffs((current) => new Map(current).set(threadId, diff));
      return diff;
    },
    [gateway],
  );

  const createThread = useCallback(
    async (input: CreateThreadInput) => {
      const thread = await gateway.createThread(input);
      setThreads((current) => new Map(current).set(thread.id, thread));
      await refresh();
      return thread;
    },
    [gateway, refresh],
  );

  const logout = useCallback(async () => {
    ++bootstrapRef.current;
    connectionRef.current?.close();
    connectionRef.current = null;
    await gateway.logout().catch(() => undefined);
    clearCompanionMutationState();
    setSession(null);
    clearSensitiveState();
    setPhase("unauthenticated");
  }, [clearSensitiveState, gateway]);

  const value = useMemo<CompanionContextValue>(
    () => ({
      phase,
      session,
      shell,
      threads,
      diffs,
      lastError,
      pair,
      updateDeviceLabel,
      retry,
      refresh,
      loadThread,
      loadDiff,
      getComposerOptions: (projectId) => gateway.getComposerOptions(projectId),
      createThread,
      sendTurn: (input) => gateway.sendTurn(input),
      interrupt: (threadId, requestId) => gateway.interrupt(threadId, requestId),
      respondToApproval: (threadId, approvalId, decision, requestId) =>
        gateway.respondToApproval(threadId, approvalId, decision, requestId),
      respondToInput: (threadId, inputId, answers, requestId) =>
        gateway.respondToInput(threadId, inputId, answers, requestId),
      getNotificationSettings: () => gateway.getNotificationSettings(),
      subscribeToNotifications: (previewEnabled) =>
        gateway.subscribeToNotifications(previewEnabled),
      setNotificationPreview: (enabled) => gateway.setNotificationPreview(enabled),
      sendTestNotification: () => gateway.sendTestNotification(),
      logout,
      gateway,
    }),
    [
      createThread,
      diffs,
      gateway,
      lastError,
      loadDiff,
      loadThread,
      logout,
      pair,
      phase,
      refresh,
      retry,
      session,
      shell,
      threads,
      updateDeviceLabel,
    ],
  );

  return <CompanionContext.Provider value={value}>{children}</CompanionContext.Provider>;
}

export function useCompanion(): CompanionContextValue {
  const value = useContext(CompanionContext);
  if (!value) throw new Error("useCompanion must be used within CompanionProvider");
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Synara could not reach the host.";
}
