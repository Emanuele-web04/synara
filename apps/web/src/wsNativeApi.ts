import {
  remoteMethodUnavailable,
  REMOTE_NATIVE_UNAVAILABLE,
} from "@synara/shared/remoteCapabilities";
import { readExecutionContext } from "./lib/hosts/executionContext";
import {
  getConnectionClients,
  setExecutionGenerationHandler,
  disposeConnectionClients,
} from "./lib/hosts/connectionClients";
import { resetThreadDetailResumeCursors } from "./threadDetailResumeCursors";
import { useDeviceStateStore } from "./deviceStateStore";
import { useComputerStateStore } from "./computerStateStore";
// FILE: wsNativeApi.ts
// Purpose: NativeApi implementation backed by the browser WebSocket RPC transport.
// Layer: Web transport adapter
// Exports: createWsNativeApi and event subscription helpers for server push channels.

import {
  type AuthBearerBootstrapResult,
  type AuthBootstrapInput,
  type AuthBootstrapResult,
  type AuthClientSession,
  type AuthCreatePairingCredentialInput,
  type AuthLogoutResult,
  type AuthPairingCredentialResult,
  type AuthPairingLink,
  type AuthRevokeClientSessionInput,
  type AuthRevokePairingLinkInput,
  type AuthSessionState,
  type AuthWebSocketTokenResult,
  type ExternalMcpCreateIntegrationInput,
  type ExternalMcpCreateIntegrationResult,
  type ExternalMcpIntegration,
  type ExternalMcpRefreshPairingInput,
  type ExternalMcpRevokeIntegrationInput,
  type ThreadId,
  type ThreadBrowserState,
  type GitActionProgressEvent,
  type GitWorktreeSetupProgressEvent,
  type GitHubProjectProvisionProgressEvent,
  type OrchestrationEvent,
  type OrchestrationShellStreamItem,
  type OrchestrationThreadStreamItem,
  type ProjectDevServerEvent,
  type ServerProviderStatusesUpdatedPayload,
  type ServerKeepAwakeUpdatedPayload,
  type ServerLifecycleStreamEvent,
  type ServerSettingsUpdatedPayload,
  ServerVoiceTranscriptionResult,
  type TerminalEvent,
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  type ContextMenuItem,
  type NativeApi,
  ServerConfigUpdatedPayload,
  WS_CHANNELS,
  WS_METHODS,
  type WsWelcomePayload,
  type WsBootstrapNegotiateResult,
  type AutomationStreamEvent,
  type TodoStreamEvent,
  DEVICE_WS_CHANNELS,
  DEVICE_WS_METHODS,
  type DeviceEvent,
  type ProjectAgentStreamEvent,
  COMPUTER_WS_CHANNELS,
  COMPUTER_WS_METHODS,
  type ComputerEvent,
} from "@synara/contracts";
import { VOICE_TRANSCRIPTION_UPLOAD_ROUTE_PATH } from "@synara/shared/binaryTransfer";
import { Schema } from "effect";

import { showConfirmDialogFallback } from "./confirmDialogFallback";
import { TASKS_OFFERED_BY_BUILD } from "./tasksSurface";
import { showContextMenuFallback } from "./contextMenuFallback";
import { requireHttpExternalUrl } from "./lib/externalUrl";
import { withNativeMenuIcons } from "./lib/nativeMenuIcons";
import { isMacNavigatorPlatform } from "./lib/utils";
import {
  type WsTransport,
  type WsShellStreamFailure,
  type WsThreadStreamFailure,
} from "./wsTransport";
import { emitWsCompatibilityIssue, emitWsTransportState } from "./wsTransportEvents";
import { resolveExecutionResource } from "./lib/wsHttpUrl";
import type { HostsApi } from "./lib/hosts/api";

export type { WsThreadStreamFailure } from "./wsTransport";

let instance: { api: NativeApi; transport: WsTransport } | null = null;

export function readWsServerCapabilities(): ReadonlyArray<string> | null {
  return instance?.transport.getCompatibility()?.capabilities ?? null;
}

export function onWsServerCapabilitiesChange(
  listener: (capabilities: ReadonlyArray<string> | null) => void,
  options?: { readonly replayCurrent?: boolean },
): () => void {
  if (!instance) createWsNativeApi();
  const transport = instance?.transport;
  if (!transport) {
    if (options?.replayCurrent) listener(null);
    return () => undefined;
  }
  return transport.onCompatibilityChange(
    (compatibility: WsBootstrapNegotiateResult | null) =>
      listener(compatibility?.capabilities ?? null),
    options,
  );
}

function createListenerRegistry<T>() {
  const listeners = new Set<(payload: T) => void>();
  return {
    get size() {
      return listeners.size;
    },
    subscribe(listener: (payload: T) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(payload: T) {
      for (const listener of listeners) {
        try {
          listener(payload);
        } catch {
          // A listener must not prevent delivery to the remaining subscribers.
        }
      }
    },
    clear() {
      listeners.clear();
    },
  };
}

function subscribeWithReplay<T>(input: {
  readonly registry: {
    subscribe: (listener: (payload: T) => void) => () => unknown;
  };
  readonly listener: (payload: T) => void;
  readonly latest: T | null;
}): () => void {
  const unsubscribe = input.registry.subscribe(input.listener);
  if (input.latest) {
    try {
      input.listener(input.latest);
    } catch {
      // Replay follows the same listener isolation as live delivery.
    }
  }
  return () => void unsubscribe();
}

const welcomeListeners = createListenerRegistry<WsWelcomePayload>();
const serverConfigUpdatedListeners = createListenerRegistry<ServerConfigUpdatedPayload>();
const serverProviderStatusesUpdatedListeners =
  createListenerRegistry<ServerProviderStatusesUpdatedPayload>();
const serverMaintenanceUpdatedListeners = createListenerRegistry<ServerLifecycleStreamEvent>();
const serverSettingsUpdatedListeners = createListenerRegistry<ServerSettingsUpdatedPayload>();
const serverKeepAwakeUpdatedListeners = createListenerRegistry<ServerKeepAwakeUpdatedPayload>();
const gitActionProgressListeners = createListenerRegistry<GitActionProgressEvent>();
const gitWorktreeSetupProgressListeners = createListenerRegistry<GitWorktreeSetupProgressEvent>();
const projectProvisionProgressListeners =
  createListenerRegistry<GitHubProjectProvisionProgressEvent>();

function omitNullUserInputAnswers(
  command: Parameters<NativeApi["orchestration"]["dispatchCommand"]>[0],
) {
  if (command.type !== "thread.user-input.respond") {
    return command;
  }

  return {
    ...command,
    answers: Object.fromEntries(
      Object.entries(command.answers).filter(
        ([, answer]) => answer !== null && answer !== undefined,
      ),
    ),
  };
}
const terminalEventListeners = createListenerRegistry<TerminalEvent>();
const projectDevServerEventListeners = createListenerRegistry<ProjectDevServerEvent>();
const automationEventListeners = createListenerRegistry<AutomationStreamEvent>();
const todoEventListeners = createListenerRegistry<TodoStreamEvent>();
const deviceEventListeners = createListenerRegistry<DeviceEvent>();
const projectAgentEventListeners = createListenerRegistry<ProjectAgentStreamEvent>();
const computerEventListeners = createListenerRegistry<ComputerEvent>();
const orchestrationDomainEventListeners = createListenerRegistry<OrchestrationEvent>();
const orchestrationShellEventListeners = createListenerRegistry<OrchestrationShellStreamItem>();
const orchestrationThreadEventListeners = createListenerRegistry<OrchestrationThreadStreamItem>();
const shellStreamFailureListeners = createListenerRegistry<WsShellStreamFailure>();
const threadStreamFailureListeners = createListenerRegistry<WsThreadStreamFailure>();
const fallbackBrowserStateListeners = createListenerRegistry<ThreadBrowserState>();
const fallbackBrowserStates = new Map<ThreadId, ThreadBrowserState>();

function clearWsNativeApiListeners(): void {
  welcomeListeners.clear();
  serverConfigUpdatedListeners.clear();
  serverProviderStatusesUpdatedListeners.clear();
  serverMaintenanceUpdatedListeners.clear();
  serverSettingsUpdatedListeners.clear();
  serverKeepAwakeUpdatedListeners.clear();
  gitActionProgressListeners.clear();
  gitWorktreeSetupProgressListeners.clear();
  projectProvisionProgressListeners.clear();
  terminalEventListeners.clear();
  projectDevServerEventListeners.clear();
  automationEventListeners.clear();
  todoEventListeners.clear();
  deviceEventListeners.clear();
  projectAgentEventListeners.clear();
  computerEventListeners.clear();
  orchestrationDomainEventListeners.clear();
  orchestrationShellEventListeners.clear();
  orchestrationThreadEventListeners.clear();
  threadStreamFailureListeners.clear();
  shellStreamFailureListeners.clear();
  fallbackBrowserStateListeners.clear();
}

function defaultBrowserState(threadId: ThreadId): ThreadBrowserState {
  return {
    threadId,
    version: 0,
    open: false,
    activeTabId: null,
    tabs: [],
    lastError: null,
  };
}

function defaultBrowserTitle(url: string): string {
  if (url === "about:blank") {
    return "New tab";
  }
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

async function requestAuthJson<T>(
  path: string,
  options: {
    readonly method?: "GET" | "POST";
    readonly body?: unknown;
  } = {},
): Promise<T> {
  const hasBody = options.body !== undefined;
  const response = await fetch(path, {
    method: options.method ?? "GET",
    credentials: "same-origin",
    ...(hasBody
      ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(options.body),
        }
      : {}),
  });
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const message =
      payload &&
      typeof payload === "object" &&
      "error" in payload &&
      typeof payload.error === "string"
        ? payload.error
        : `Auth request failed with status ${response.status}`;
    throw new Error(message);
  }
  return payload as T;
}

async function requestVoiceTranscriptionUpload(
  input: Parameters<NativeApi["server"]["transcribeVoice"]>[0],
) {
  const decoded = atob(input.audioBase64);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  const response = await fetch(
    resolveExecutionResource({
      kind: "voice-upload",
      provider: input.provider,
      cwd: input.cwd,
      mimeType: input.mimeType,
      sampleRateHz: input.sampleRateHz,
      durationMs: input.durationMs,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.providerInstanceId ? { providerInstanceId: input.providerInstanceId } : {}),
    }),
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": input.mimeType },
      body: bytes,
    },
  );
  if (response.status === 404 || response.status === 405) {
    void response.body?.cancel().catch(() => undefined);
    throw new VoiceUploadRouteUnavailableError();
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok || !Schema.is(ServerVoiceTranscriptionResult)(payload)) {
    const message =
      payload !== null &&
      typeof payload === "object" &&
      "error" in payload &&
      typeof payload.error === "string"
        ? payload.error
        : response.ok
          ? "The voice transcription service returned an invalid response. Please try again."
          : `Voice transcription failed with status ${response.status}.`;
    throw new Error(message);
  }
  return payload;
}

class VoiceUploadRouteUnavailableError extends Error {}

function createFallbackTab(url = "about:blank") {
  return {
    id: crypto.randomUUID(),
    url,
    title: defaultBrowserTitle(url),
    status: "live" as const,
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    faviconUrl: null,
    lastCommittedUrl: url,
    lastError: null,
  };
}

function cloneBrowserState(state: ThreadBrowserState): ThreadBrowserState {
  return {
    ...state,
    tabs: state.tabs.map((tab) => ({ ...tab })),
  };
}

function getFallbackBrowserState(threadId: ThreadId): ThreadBrowserState {
  const existing = fallbackBrowserStates.get(threadId);
  if (existing) {
    return existing;
  }
  const initial = defaultBrowserState(threadId);
  fallbackBrowserStates.set(threadId, initial);
  return initial;
}

function emitFallbackBrowserState(threadId: ThreadId): ThreadBrowserState {
  const state = cloneBrowserState(getFallbackBrowserState(threadId));
  fallbackBrowserStateListeners.emit(state);
  return state;
}

function markFallbackBrowserStateChanged(state: ThreadBrowserState): void {
  state.version += 1;
}

function ensureFallbackBrowserWorkspace(threadId: ThreadId): ThreadBrowserState {
  const state = getFallbackBrowserState(threadId);
  if (state.tabs.length === 0) {
    const tab = createFallbackTab();
    state.tabs = [tab];
    state.activeTabId = tab.id;
  }
  state.open = true;
  return state;
}

function resolveFallbackBrowserTab(state: ThreadBrowserState, tabId?: string) {
  const existing =
    (tabId ? state.tabs.find((tab) => tab.id === tabId) : undefined) ??
    (state.activeTabId ? state.tabs.find((tab) => tab.id === state.activeTabId) : undefined) ??
    state.tabs[0];
  if (existing) {
    return existing;
  }
  const tab = createFallbackTab();
  state.tabs = [tab];
  state.activeTabId = tab.id;
  state.open = true;
  return tab;
}

/**
 * Subscribe to the server welcome message. If a welcome was already received
 * before this call, the listener fires synchronously with the cached payload.
 * This avoids the race between WebSocket connect and React effect registration.
 */
export function onServerWelcome(listener: (payload: WsWelcomePayload) => void): () => void {
  const latestWelcome = instance?.transport.getLatestPush(WS_CHANNELS.serverWelcome)?.data ?? null;
  return subscribeWithReplay({ registry: welcomeListeners, listener, latest: latestWelcome });
}

/**
 * Subscribe to server config update events. Replays the latest update for
 * late subscribers to avoid missing config validation feedback.
 */
export function onServerConfigUpdated(
  listener: (payload: ServerConfigUpdatedPayload) => void,
): () => void {
  const latestConfig =
    instance?.transport.getLatestPush(WS_CHANNELS.serverConfigUpdated)?.data ?? null;
  return subscribeWithReplay({
    registry: serverConfigUpdatedListeners,
    listener,
    latest: latestConfig,
  });
}

/**
 * Subscribe to provider status updates without forcing a full config reload.
 */
export function onServerProviderStatusesUpdated(
  listener: (payload: ServerProviderStatusesUpdatedPayload) => void,
): () => void {
  const latestProviderStatuses =
    instance?.transport.getLatestPush(WS_CHANNELS.serverProviderStatusesUpdated)?.data ?? null;
  return subscribeWithReplay({
    registry: serverProviderStatusesUpdatedListeners,
    listener,
    latest: latestProviderStatuses,
  });
}

export function onServerMaintenanceUpdated(
  listener: (payload: ServerLifecycleStreamEvent) => void,
): () => void {
  const latestMaintenance =
    instance?.transport.getLatestPush(WS_CHANNELS.serverMaintenanceUpdated)?.data ?? null;
  return subscribeWithReplay({
    registry: serverMaintenanceUpdatedListeners,
    listener,
    latest: latestMaintenance,
  });
}

export function onServerSettingsUpdated(
  listener: (payload: ServerSettingsUpdatedPayload) => void,
): () => void {
  const latestSettings =
    instance?.transport.getLatestPush(WS_CHANNELS.serverSettingsUpdated)?.data ?? null;
  return subscribeWithReplay({
    registry: serverSettingsUpdatedListeners,
    listener,
    latest: latestSettings,
  });
}

/** Subscribe to keep-awake (caffeinate) state; replays the latest push. */
export function onServerKeepAwakeUpdated(
  listener: (payload: ServerKeepAwakeUpdatedPayload) => void,
): () => void {
  const latestKeepAwake =
    instance?.transport.getLatestPush(WS_CHANNELS.serverKeepAwakeUpdated)?.data ?? null;
  return subscribeWithReplay({
    registry: serverKeepAwakeUpdatedListeners,
    listener,
    latest: latestKeepAwake,
  });
}

/**
 * Subscribe to unrecoverable per-thread stream failures (retries and reconnect
 * exhausted). Lets thread-detail consumers surface a failed hydration state
 * instead of rendering an empty conversation.
 */
export function onThreadStreamFailure(
  listener: (failure: WsThreadStreamFailure) => void,
): () => void {
  const unsubscribe = threadStreamFailureListeners.subscribe(listener);
  return () => void unsubscribe();
}

/** Subscribe to an exhausted shell stream; retrying it does not reconnect other streams. */
export function onShellStreamFailure(
  listener: (failure: WsShellStreamFailure) => void,
): () => void {
  const unsubscribe = shellStreamFailureListeners.subscribe(listener);
  return () => void unsubscribe();
}

export function createWsNativeApi(): NativeApi {
  if (instance) {
    if (instance.transport.getState() !== "disposed") {
      return instance.api;
    }
    instance = null;
  }

  setExecutionGenerationHandler(() => {
    resetThreadDetailResumeCursors();
    useDeviceStateStore.getState().clear();
    useComputerStateStore.getState().clear();
  });
  const { execution: transport, controller } = getConnectionClients();
  const remoteExecution = Boolean(readExecutionContext()?.remote);
  const executionRequest: typeof transport.request = (...args) => {
    if (remoteExecution && remoteMethodUnavailable(args[0]))
      return Promise.reject(new Error(REMOTE_NATIVE_UNAVAILABLE));
    return transport.request(...args);
  };
  let unsubscribeDomainEventTransport: (() => void) | null = null;
  const projectAgentSubscribeCounts = new Map<string, number>();
  transport.onStateChange((state) => emitWsTransportState(state), { replayCurrent: true });
  transport.onCompatibilityIssue((issue) => emitWsCompatibilityIssue(issue), {
    replayCurrent: true,
  });

  transport.subscribe(WS_CHANNELS.serverWelcome, (message) => {
    welcomeListeners.emit(message.data);
  });
  transport.subscribe(WS_CHANNELS.serverConfigUpdated, (message) => {
    serverConfigUpdatedListeners.emit(message.data);
  });
  transport.subscribe(WS_CHANNELS.serverProviderStatusesUpdated, (message) => {
    serverProviderStatusesUpdatedListeners.emit(message.data);
  });
  transport.subscribe(WS_CHANNELS.serverMaintenanceUpdated, (message) => {
    serverMaintenanceUpdatedListeners.emit(message.data);
  });
  transport.subscribe(WS_CHANNELS.serverSettingsUpdated, (message) => {
    serverSettingsUpdatedListeners.emit(message.data);
  });
  transport.subscribe(WS_CHANNELS.serverKeepAwakeUpdated, (message) => {
    serverKeepAwakeUpdatedListeners.emit(message.data);
  });
  transport.subscribe(WS_CHANNELS.gitActionProgress, (message) => {
    gitActionProgressListeners.emit(message.data);
  });
  transport.subscribe(WS_CHANNELS.gitWorktreeSetupProgress, (message) => {
    gitWorktreeSetupProgressListeners.emit(message.data);
  });
  transport.subscribe(WS_CHANNELS.projectProvisionProgress, (message) => {
    projectProvisionProgressListeners.emit(message.data);
  });
  transport.subscribe(WS_CHANNELS.terminalEvent, (message) => {
    terminalEventListeners.emit(message.data);
  });
  transport.subscribe(WS_CHANNELS.projectDevServerEvent, (message) => {
    projectDevServerEventListeners.emit(message.data);
  });
  transport.subscribe(WS_CHANNELS.automationEvent, (message) => {
    automationEventListeners.emit(message.data);
  });
  // Remote hosts reject these local-only streams; subscribing would trigger reconnects.
  if (!remoteExecution) {
    transport.subscribe(DEVICE_WS_CHANNELS.event, (message) => {
      deviceEventListeners.emit(message.data);
    });
    transport.subscribe(COMPUTER_WS_CHANNELS.event, (message) => {
      computerEventListeners.emit(message.data);
    });
  }
  if (TASKS_OFFERED_BY_BUILD) {
    transport.subscribe(WS_CHANNELS.todoEvent, (message) => {
      todoEventListeners.emit(message.data);
    });
  }
  transport.subscribe(WS_CHANNELS.projectAgentEvent, (message) => {
    projectAgentEventListeners.emit(message.data);
  });
  transport.subscribe(ORCHESTRATION_WS_CHANNELS.shellEvent, (message) => {
    orchestrationShellEventListeners.emit(message.data);
  });
  transport.subscribe(ORCHESTRATION_WS_CHANNELS.threadEvent, (message) => {
    orchestrationThreadEventListeners.emit(message.data);
  });
  transport.onShellStreamFailure((failure) => {
    shellStreamFailureListeners.emit(failure);
  });
  transport.onThreadStreamFailure((failure) => {
    threadStreamFailureListeners.emit(failure);
  });
  const api: NativeApi & { hosts: HostsApi } = {
    dialogs: {
      pickFolder: async () => {
        const context = readExecutionContext();
        if (context?.remote || !window.desktopBridge) {
          const { showExecutionFolderPicker } = await import("./lib/hosts/ExecutionFolderPicker");
          return showExecutionFolderPicker({
            label: context?.execution.label ?? "this computer",
            browse: (input) => executionRequest(WS_METHODS.filesystemBrowse, input),
          });
        }
        if (!window.desktopBridge) return null;
        return window.desktopBridge.pickFolder();
      },
      saveFile: async (input) => {
        if (window.desktopBridge?.saveFile) {
          return window.desktopBridge.saveFile(input);
        }
        const blob = new Blob([input.contents], { type: "text/markdown;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        try {
          const anchor = document.createElement("a");
          anchor.href = url;
          anchor.download = input.defaultFilename;
          anchor.click();
        } finally {
          URL.revokeObjectURL(url);
        }
        return null;
      },
      confirm: async (message) => {
        return showConfirmDialogFallback(message);
      },
    },
    terminal: {
      open: (input) => executionRequest(WS_METHODS.terminalOpen, input),
      write: (input) => executionRequest(WS_METHODS.terminalWrite, input),
      ackOutput: (input) => executionRequest(WS_METHODS.terminalAckOutput, input),
      resize: (input) => executionRequest(WS_METHODS.terminalResize, input),
      clear: (input) => executionRequest(WS_METHODS.terminalClear, input),
      restart: (input) => executionRequest(WS_METHODS.terminalRestart, input),
      close: (input) => executionRequest(WS_METHODS.terminalClose, input),
      onEvent: terminalEventListeners.subscribe,
    },
    projects: {
      discoverScripts: (input) => executionRequest(WS_METHODS.projectsDiscoverScripts, input),
      listDirectories: (input) => executionRequest(WS_METHODS.projectsListDirectories, input),
      searchEntries: (input) => executionRequest(WS_METHODS.projectsSearchEntries, input),
      searchLocalEntries: (input) => executionRequest(WS_METHODS.projectsSearchLocalEntries, input),
      searchContent: (input) => executionRequest(WS_METHODS.projectsSearchContent, input),
      prewarmSearchIndex: (input) => executionRequest(WS_METHODS.projectsPrewarmSearchIndex, input),
      readFile: (input, options) =>
        options?.signal
          ? executionRequest(WS_METHODS.projectsReadFile, input, { signal: options.signal })
          : executionRequest(WS_METHODS.projectsReadFile, input),
      onFileChange: (input, callback) => transport.subscribeProjectFileChange(input, callback),
      resolveWorkspaceFileReferences: (input) =>
        executionRequest(WS_METHODS.projectsResolveWorkspaceFileReferences, input),
      resolveOutOfRootFileReference: (input) =>
        executionRequest(WS_METHODS.projectsResolveOutOfRootFileReference, input),
      createLocalFilePreviewGrant: (input) =>
        executionRequest(WS_METHODS.projectsCreateLocalFilePreviewGrant, input),
      writeFile: (input) => executionRequest(WS_METHODS.projectsWriteFile, input),
      runDevServer: (input) => executionRequest(WS_METHODS.projectsRunDevServer, input),
      stopDevServer: (input) => executionRequest(WS_METHODS.projectsStopDevServer, input),
      listDevServers: () => executionRequest(WS_METHODS.projectsListDevServers),
      onDevServerEvent: projectDevServerEventListeners.subscribe,
      provisionFromGitHub: (input, options) =>
        executionRequest(WS_METHODS.projectsProvisionFromGitHub, input, {
          timeoutMs: null,
          ...(options?.signal ? { signal: options.signal } : {}),
        }),
      onProvisionProgress: projectProvisionProgressListeners.subscribe,
    },
    filesystem: {
      browse: (input) => executionRequest(WS_METHODS.filesystemBrowse, input),
    },
    studio: {
      listThreadOutputs: (input) => executionRequest(WS_METHODS.studioListThreadOutputs, input),
    },
    shell: {
      openInEditor: (cwd, editor) =>
        executionRequest(WS_METHODS.shellOpenInEditor, { cwd, editor }),
      openExternal: async (url) => {
        const externalUrl = requireHttpExternalUrl(url);
        if (window.desktopBridge) {
          const opened = await window.desktopBridge.openExternal(externalUrl);
          if (!opened) {
            throw new Error("Unable to open link.");
          }
          return;
        }

        // Some mobile browsers can return null here even when the tab opens.
        // Avoid false negatives and let the browser handle popup policy.
        window.open(externalUrl, "_blank", "noopener,noreferrer");
      },
      showInFolder: async (path) => {
        if (remoteExecution) throw new Error(REMOTE_NATIVE_UNAVAILABLE);
        if (window.desktopBridge) {
          await window.desktopBridge.showInFolder(path);
        }
        // No-op in browser - this is a desktop-only feature
      },
    },
    git: {
      githubRepository: (input) => executionRequest(WS_METHODS.gitGithubRepository, input),
      pull: (input) => executionRequest(WS_METHODS.gitPull, input),
      status: (input) => executionRequest(WS_METHODS.gitStatus, input),
      readWorkingTreeDiff: (input) => executionRequest(WS_METHODS.gitReadWorkingTreeDiff, input),
      readFileAtRev: (input) => executionRequest(WS_METHODS.gitReadFileAtRev, input),
      workingTreeDiffStats: (input) => executionRequest(WS_METHODS.gitWorkingTreeDiffStats, input),
      blameLine: (input) => executionRequest(WS_METHODS.gitBlameLine, input),
      summarizeDiff: (input) =>
        executionRequest(WS_METHODS.gitSummarizeDiff, input, {
          timeoutMs: null,
        }),
      runStackedAction: (input) =>
        executionRequest(WS_METHODS.gitRunStackedAction, input, {
          timeoutMs: null,
        }),
      listBranches: (input) => executionRequest(WS_METHODS.gitListBranches, input),
      listRecentCommits: (input) => executionRequest(WS_METHODS.gitListRecentCommits, input),
      createWorktree: (input) => executionRequest(WS_METHODS.gitCreateWorktree, input),
      // Worktree materialization scales with checkout size; progress events
      // keep the UI honest while the stream runs, so no fixed timeout.
      createDetachedWorktree: (input) =>
        executionRequest(WS_METHODS.gitCreateDetachedWorktree, input, {
          timeoutMs: null,
        }),
      removeWorktree: (input) => executionRequest(WS_METHODS.gitRemoveWorktree, input),
      createBranch: (input) => executionRequest(WS_METHODS.gitCreateBranch, input),
      checkout: (input) => executionRequest(WS_METHODS.gitCheckout, input),
      stashAndCheckout: (input) => executionRequest(WS_METHODS.gitStashAndCheckout, input),
      stashDrop: (input) => executionRequest(WS_METHODS.gitStashDrop, input),
      stashInfo: (input) => executionRequest(WS_METHODS.gitStashInfo, input),
      removeIndexLock: (input) => executionRequest(WS_METHODS.gitRemoveIndexLock, input),
      init: (input) => executionRequest(WS_METHODS.gitInit, input),
      stageFiles: (input) => executionRequest(WS_METHODS.gitStageFiles, input),
      unstageFiles: (input) => executionRequest(WS_METHODS.gitUnstageFiles, input),
      handoffThread: (input) => executionRequest(WS_METHODS.gitHandoffThread, input),
      resolvePullRequest: (input) => executionRequest(WS_METHODS.gitResolvePullRequest, input),
      pullRequestSnapshot: (input) => executionRequest(WS_METHODS.gitPullRequestSnapshot, input),
      preparePullRequestThread: (input) =>
        executionRequest(WS_METHODS.gitPreparePullRequestThread, input),
      onActionProgress: gitActionProgressListeners.subscribe,
      onWorktreeSetupProgress: gitWorktreeSetupProgressListeners.subscribe,
    },
    githubInbox: {
      list: (input) => executionRequest(WS_METHODS.githubInboxList, input),
      issueDetail: (input) => executionRequest(WS_METHODS.githubInboxIssueDetail, input),
      issueComment: (input) => executionRequest(WS_METHODS.githubInboxIssueComment, input),
    },
    pullRequests: {
      detail: (input) => executionRequest(WS_METHODS.pullRequestsDetail, input),
      diff: (input) => executionRequest(WS_METHODS.pullRequestsDiff, input),
      action: (input) =>
        executionRequest(WS_METHODS.pullRequestsAction, input, { timeoutMs: null }),
      comment: (input) => executionRequest(WS_METHODS.pullRequestsComment, input),
      setPinned: (input) => executionRequest(WS_METHODS.pullRequestsSetPinned, input),
      getAutoFix: (input) => executionRequest(WS_METHODS.pullRequestsGetAutoFix, input),
      setAutoFix: (input) => executionRequest(WS_METHODS.pullRequestsSetAutoFix, input),
    },
    contextMenu: {
      show: async <T extends string>(
        items: readonly ContextMenuItem<T>[],
        position?: { x: number; y: number },
      ): Promise<T | null> => {
        if (window.desktopBridge) {
          // Native icons are macOS-only; other platforms keep the plain menu.
          const desktopItems = isMacNavigatorPlatform() ? await withNativeMenuIcons(items) : items;
          return window.desktopBridge.showContextMenu(desktopItems, position);
        }
        return showContextMenuFallback(items, position);
      },
    },
    server: {
      getConfig: () => executionRequest(WS_METHODS.serverGetConfig),
      getEnvironment: () => executionRequest(WS_METHODS.serverGetEnvironment),
      getSettings: () => executionRequest(WS_METHODS.serverGetSettings),
      updateSettings: (input) => executionRequest(WS_METHODS.serverUpdateSettings, input),
      getAuthSession: () => requestAuthJson<AuthSessionState>("/api/auth/session"),
      bootstrapAuth: (input: AuthBootstrapInput) =>
        requestAuthJson<AuthBootstrapResult>("/api/auth/bootstrap", {
          method: "POST",
          body: input,
        }),
      bootstrapBearerAuth: (input: AuthBootstrapInput) =>
        requestAuthJson<AuthBearerBootstrapResult>("/api/auth/bootstrap/bearer", {
          method: "POST",
          body: input,
        }),
      issueAuthWebSocketToken: () =>
        requestAuthJson<AuthWebSocketTokenResult>("/api/auth/ws-token", { method: "POST" }),
      createAuthPairingToken: (input?: AuthCreatePairingCredentialInput) =>
        requestAuthJson<AuthPairingCredentialResult>("/api/auth/pairing-token", {
          method: "POST",
          ...(input ? { body: input } : {}),
        }),
      listAuthPairingLinks: () =>
        requestAuthJson<ReadonlyArray<AuthPairingLink>>("/api/auth/pairing-links"),
      revokeAuthPairingLink: (input: AuthRevokePairingLinkInput) =>
        requestAuthJson<{ revoked: boolean }>("/api/auth/pairing-links/revoke", {
          method: "POST",
          body: input,
        }),
      listAuthClients: () => requestAuthJson<ReadonlyArray<AuthClientSession>>("/api/auth/clients"),
      revokeAuthClient: (input: AuthRevokeClientSessionInput) =>
        requestAuthJson<{ revoked: boolean }>("/api/auth/clients/revoke", {
          method: "POST",
          body: input,
        }),
      revokeOtherAuthClients: () =>
        requestAuthJson<{ revokedCount: number }>("/api/auth/clients/revoke-others", {
          method: "POST",
        }),
      logoutAuthSession: async () => {
        const result = await requestAuthJson<AuthLogoutResult>("/api/auth/logout", {
          method: "POST",
        });
        await transport.dispose();
        return result;
      },
      listExternalMcpIntegrations: () =>
        executionRequest(WS_METHODS.serverListExternalMcpIntegrations),
      createExternalMcpIntegration: (input: ExternalMcpCreateIntegrationInput) =>
        executionRequest(WS_METHODS.serverCreateExternalMcpIntegration, input),
      revokeExternalMcpIntegration: (input: ExternalMcpRevokeIntegrationInput) =>
        executionRequest(WS_METHODS.serverRevokeExternalMcpIntegration, input),
      refreshExternalMcpPairing: (input: ExternalMcpRefreshPairingInput) =>
        executionRequest(WS_METHODS.serverRefreshExternalMcpPairing, input),
      // Claude runs sequential CLI and auth probes, so a refresh can exceed the
      // generic 60-second RPC deadline. Keep this bounded while allowing slow
      // probes to finish; onboarding shows an error if this deadline expires.
      refreshProviders: () =>
        executionRequest(WS_METHODS.serverRefreshProviders, undefined, { timeoutMs: 180_000 }),
      // Provider updates run up to 2 minutes server-side; callers wrap this in
      // withProviderUpdateTimeout, which owns the client-side watchdog.
      updateProvider: (input) =>
        executionRequest(WS_METHODS.serverUpdateProvider, input, { timeoutMs: null }),
      listWorktrees: () => executionRequest(WS_METHODS.serverListWorktrees),
      listLocalServers: () => executionRequest(WS_METHODS.serverListLocalServers),
      stopLocalServer: (input) => executionRequest(WS_METHODS.serverStopLocalServer, input),
      getProviderUsageSnapshot: (input) =>
        executionRequest(WS_METHODS.serverGetProviderUsageSnapshot, input),
      listProviderUsage: (input) => executionRequest(WS_METHODS.serverListProviderUsage, input),
      consumeCodexResetCredit: (input) =>
        executionRequest(WS_METHODS.serverConsumeCodexResetCredit, input),
      getDiagnostics: () => executionRequest(WS_METHODS.serverGetDiagnostics),
      readThreadDiagnostics: (input) =>
        executionRequest(WS_METHODS.serverReadThreadDiagnostics, input),
      generateThreadRecap: (input) =>
        executionRequest(WS_METHODS.serverGenerateThreadRecap, input, {
          timeoutMs: null,
        }),
      generateAutomationIntent: (input) =>
        executionRequest(WS_METHODS.serverGenerateAutomationIntent, input, {
          timeoutMs: null,
        }),
      prewarmVoice: (input) => executionRequest(WS_METHODS.serverPrewarmVoice, input),
      transcribeVoice: async (input) => {
        try {
          return await requestVoiceTranscriptionUpload(input);
        } catch (error) {
          if (!(error instanceof VoiceUploadRouteUnavailableError)) {
            throw error;
          }
          return executionRequest(WS_METHODS.serverTranscribeVoice, input, { timeoutMs: null });
        }
      },
      upsertKeybinding: (input) => executionRequest(WS_METHODS.serverUpsertKeybinding, input),
      editKeybindings: (input) => executionRequest(WS_METHODS.serverEditKeybindings, input),
    },
    stats: {
      getProfileStats: (input) => executionRequest(WS_METHODS.statsGetProfileStats, input),
      getProfileTokenStats: (input) =>
        executionRequest(WS_METHODS.statsGetProfileTokenStats, input),
      getRecap: (input) => executionRequest(WS_METHODS.statsGetRecap, input),
    },
    provider: {
      getComposerCapabilities: (input) =>
        executionRequest(WS_METHODS.providerGetComposerCapabilities, input),
      // Compaction is capped server-side per provider (ACP providers allow up
      // to the 10-minute turn-idle ceiling), so the server owns this bound.
      compactThread: (input) =>
        executionRequest(WS_METHODS.providerCompactThread, input, { timeoutMs: null }),
      listCommands: (input) => executionRequest(WS_METHODS.providerListCommands, input),
      listSkills: (input) => executionRequest(WS_METHODS.providerListSkills, input),
      listSkillsCatalog: (input) => executionRequest(WS_METHODS.providerListSkillsCatalog, input),
      listPlugins: (input) => executionRequest(WS_METHODS.providerListPlugins, input),
      readPlugin: (input) => executionRequest(WS_METHODS.providerReadPlugin, input),
      listModels: (input) => executionRequest(WS_METHODS.providerListModels, input),
      listAgents: (input) => executionRequest(WS_METHODS.providerListAgents, input),
    },
    orchestration: {
      getSnapshot: () => executionRequest(ORCHESTRATION_WS_METHODS.getSnapshot),
      getShellSnapshot: () => executionRequest(ORCHESTRATION_WS_METHODS.getShellSnapshot),
      getThreadDetailSnapshot: (input) =>
        executionRequest(ORCHESTRATION_WS_METHODS.getThreadDetailSnapshot, input),
      searchThreads: (input) => executionRequest(ORCHESTRATION_WS_METHODS.searchThreads, input),
      dispatchCommand: (command) => {
        return executionRequest(ORCHESTRATION_WS_METHODS.dispatchCommand, {
          command: omitNullUserInputAnswers(command),
        });
      },
      importThread: (input) => executionRequest(ORCHESTRATION_WS_METHODS.importThread, input),
      listProjectImports: (input) =>
        executionRequest(ORCHESTRATION_WS_METHODS.listProjectImports, input),
      importProject: (input) => executionRequest(ORCHESTRATION_WS_METHODS.importProject, input),
      loadProjectImportHistory: (input) =>
        executionRequest(ORCHESTRATION_WS_METHODS.loadProjectImportHistory, input),
      regenerateThreadTitle: (input) =>
        executionRequest(ORCHESTRATION_WS_METHODS.regenerateThreadTitle, input, {
          timeoutMs: null,
        }),
      repairState: () => executionRequest(ORCHESTRATION_WS_METHODS.repairState),
      getTurnDiff: (input) => executionRequest(ORCHESTRATION_WS_METHODS.getTurnDiff, input),
      getFullThreadDiff: (input) =>
        executionRequest(ORCHESTRATION_WS_METHODS.getFullThreadDiff, input),
      replayEvents: (fromSequenceExclusive, threadId) =>
        executionRequest(ORCHESTRATION_WS_METHODS.replayEvents, {
          fromSequenceExclusive,
          ...(threadId === undefined ? {} : { threadId }),
        }),
      listProviderDeliveryBlockers: (input = {}) =>
        executionRequest(ORCHESTRATION_WS_METHODS.listProviderDeliveryBlockers, input),
      reconcileProviderDelivery: (input) =>
        executionRequest(ORCHESTRATION_WS_METHODS.reconcileProviderDelivery, input),
      prepareQuitResume: (input) =>
        executionRequest(ORCHESTRATION_WS_METHODS.prepareQuitResume, input),
      subscribeShell: () => transport.request<void>(ORCHESTRATION_WS_METHODS.subscribeShell, {}),
      unsubscribeShell: () =>
        transport.request<void>(ORCHESTRATION_WS_METHODS.unsubscribeShell, {}),
      subscribeThread: (input) =>
        transport.request<void>(ORCHESTRATION_WS_METHODS.subscribeThread, input),
      unsubscribeThread: (input) =>
        transport.request<void>(ORCHESTRATION_WS_METHODS.unsubscribeThread, input),
      onDomainEvent: (callback) => {
        const shouldStartTransport = orchestrationDomainEventListeners.size === 0;
        const unsubscribe = orchestrationDomainEventListeners.subscribe(callback);
        if (shouldStartTransport) {
          unsubscribeDomainEventTransport = transport.subscribe(
            ORCHESTRATION_WS_CHANNELS.domainEvent,
            (message) => orchestrationDomainEventListeners.emit(message.data),
          );
        }
        return () => {
          unsubscribe();
          if (orchestrationDomainEventListeners.size === 0) {
            unsubscribeDomainEventTransport?.();
            unsubscribeDomainEventTransport = null;
          }
        };
      },
      onShellEvent: orchestrationShellEventListeners.subscribe,
      onThreadEvent: orchestrationThreadEventListeners.subscribe,
    },
    account: {
      status: () => controller.request(WS_METHODS.accountStatus),
      sendOtp: (input) => controller.request(WS_METHODS.accountSendOtp, input),
      // The input carries the emailed code — a credential. Pass it straight
      // through: do not wrap, retry, or log it, and do not keep it after the
      // promise settles.
      authenticateOtp: (input) => controller.request(WS_METHODS.accountAuthenticateOtp, input),
      beginSso: (input) => controller.request(WS_METHODS.accountBeginSso, input),
      // No deadline: the server waits on the browser callback for as long as
      // the attempt lives. If the socket drops, the sign-in still completed
      // server-side — re-querying `status` on reconnect recovers it.
      completeSso: (input, options) =>
        controller.request(WS_METHODS.accountCompleteSso, input, {
          timeoutMs: null,
          ...(options?.signal ? { signal: options.signal } : {}),
        }),
      cancelSso: (input) => controller.request(WS_METHODS.accountCancelSso, input),
      usageSummary: (input) => controller.request(WS_METHODS.accountUsageSummary, input),
      saveInboxRecap: (input) => controller.request(WS_METHODS.accountSaveInboxRecap, input),
      listInboxRecaps: (input) => controller.request(WS_METHODS.accountListInboxRecaps, input),
      deleteInboxRecap: (input) => controller.request(WS_METHODS.accountDeleteInboxRecap, input),
      updateProfile: (input) => controller.request(WS_METHODS.accountUpdateProfile, input),
      uploadAvatar: (input) => controller.request(WS_METHODS.accountUploadAvatar, input),
      deleteAvatar: () => controller.request(WS_METHODS.accountDeleteAvatar),
      signOut: () => controller.request(WS_METHODS.accountSignOut),
      openVerificationUrl: (input) =>
        controller.request(WS_METHODS.accountOpenVerificationUrl, input),
    },
    hosts: {
      remoteAccess: (input) =>
        controller.request(
          WS_METHODS.hostsRemoteAccess,
          { request: input },
          { timeoutMs: 11 * 60_000 },
        ),
      listHosts: () => controller.request(WS_METHODS.hostsList),
      updateHost: (input) => controller.request(WS_METHODS.hostsUpdate, input),
      deleteHost: (input) => controller.request(WS_METHODS.hostsDelete, input),
      listDevices: () => controller.request(WS_METHODS.hostsListDevices),
      revokeDevice: (input) => controller.request(WS_METHODS.hostsRevokeDevice, input),
      approveDeviceLink: (input) => controller.request(WS_METHODS.hostsApproveDeviceLink, input),
      requestGrant: (input) => controller.request(WS_METHODS.hostsRequestGrant, input),
      enrollment: () => controller.request(WS_METHODS.hostsEnrollment),
      unlinkLocalHost: () => controller.request(WS_METHODS.hostsUnlinkLocalHost),
      listSessions: () => controller.request(WS_METHODS.hostsListSessions),
      endSession: (input) => controller.request(WS_METHODS.hostsEndSession, input),
      beginSyncKeyPairing: () => controller.request(WS_METHODS.hostsBeginSyncKeyPairing),
      offerSyncKey: (input) => controller.request(WS_METHODS.hostsOfferSyncKey, input),
      receiveSyncKey: () => controller.request(WS_METHODS.hostsReceiveSyncKey),
      confirmSyncKey: (input) => controller.request(WS_METHODS.hostsConfirmSyncKey, input),
      // Dialing races several transports with a 3s deadline and then does a
      // two-round-trip handshake; the default RPC deadline is too tight.
      connect: (input) => controller.request(WS_METHODS.hostsConnect, input, { timeoutMs: 30_000 }),
      disconnect: (input) => controller.request(WS_METHODS.hostsDisconnect, input),
      listConnections: () => controller.request(WS_METHODS.hostsListConnections),
    },
    projectAgent: {
      getOverview: (input) => executionRequest(WS_METHODS.projectAgentGetOverview, input),
      listSummaries: (input = {}) => executionRequest(WS_METHODS.projectAgentListSummaries, input),
      configure: (input) => executionRequest(WS_METHODS.projectAgentConfigure, input),
      linkProject: (input) => executionRequest(WS_METHODS.projectAgentLinkProject, input),
      unlinkProject: (input) => executionRequest(WS_METHODS.projectAgentUnlinkProject, input),
      pauseGroup: (input) => executionRequest(WS_METHODS.projectAgentPauseGroup, input),
      resumeGroup: (input) => executionRequest(WS_METHODS.projectAgentResumeGroup, input),
      archiveGroup: (input) => executionRequest(WS_METHODS.projectAgentArchiveGroup, input),
      unarchiveGroup: (input) => executionRequest(WS_METHODS.projectAgentUnarchiveGroup, input),
      restartCoordinator: (input) =>
        executionRequest(WS_METHODS.projectAgentRestartCoordinator, input),
      deleteGroup: (input) => executionRequest(WS_METHODS.projectAgentDeleteGroup, input),
      resolveWorker: (input) => executionRequest(WS_METHODS.projectAgentResolveWorker, input),
      startGoal: (input) => executionRequest(WS_METHODS.projectAgentStartGoal, input),
      updateGoal: (input) => executionRequest(WS_METHODS.projectAgentUpdateGoal, input),
      pauseGoal: (input) => executionRequest(WS_METHODS.projectAgentPauseGoal, input),
      resumeGoal: (input) => executionRequest(WS_METHODS.projectAgentResumeGoal, input),
      stopGoal: (input) => executionRequest(WS_METHODS.projectAgentStopGoal, input),
      listTasks: (input) => executionRequest(WS_METHODS.projectAgentListTasks, input),
      createTask: (input) => executionRequest(WS_METHODS.projectAgentCreateTask, input),
      updateTask: (input) => executionRequest(WS_METHODS.projectAgentUpdateTask, input),
      listEvidence: (input) => executionRequest(WS_METHODS.projectAgentListEvidence, input),
      listThreadIndex: (input) => executionRequest(WS_METHODS.projectAgentListThreadIndex, input),
      excludeThread: (input) => executionRequest(WS_METHODS.projectAgentExcludeThread, input),
      backfillSummaries: (input) =>
        executionRequest(WS_METHODS.projectAgentBackfillSummaries, input),
      listActivity: (input) => executionRequest(WS_METHODS.projectAgentListActivity, input),
      listDocuments: (input) => executionRequest(WS_METHODS.projectAgentListDocuments, input),
      readDocument: (input) => executionRequest(WS_METHODS.projectAgentReadDocument, input),
      writeDocument: (input) => executionRequest(WS_METHODS.projectAgentWriteDocument, input),
      exportDocuments: (input) => executionRequest(WS_METHODS.projectAgentExportDocuments, input),
      refreshDigest: (input) => executionRequest(WS_METHODS.projectAgentRefreshDigest, input),
      library: {
        list: (input) => executionRequest(WS_METHODS.projectAgentLibraryList, input),
        mkdir: (input) => executionRequest(WS_METHODS.projectAgentLibraryMkdir, input),
        rename: (input) => executionRequest(WS_METHODS.projectAgentLibraryRename, input),
        delete: (input) => executionRequest(WS_METHODS.projectAgentLibraryDelete, input),
        history: (input) => executionRequest(WS_METHODS.projectAgentLibraryHistory, input),
        restore: (input) => executionRequest(WS_METHODS.projectAgentLibraryRestore, input),
        status: (input) => executionRequest(WS_METHODS.projectAgentLibraryStatus, input),
      },
      subscribe: async (input) => {
        const count = (projectAgentSubscribeCounts.get(input.projectId) ?? 0) + 1;
        projectAgentSubscribeCounts.set(input.projectId, count);
        if (count > 1) return;
        await executionRequest(WS_METHODS.subscribeProjectAgentEvents, input);
      },
      unsubscribe: async (input) => {
        const count = (projectAgentSubscribeCounts.get(input.projectId) ?? 0) - 1;
        if (count > 0) {
          projectAgentSubscribeCounts.set(input.projectId, count);
          return;
        }
        projectAgentSubscribeCounts.delete(input.projectId);
        await transport.unsubscribeProjectAgentEvents(input.projectId);
      },
      onEvent: projectAgentEventListeners.subscribe,
    },
    automation: {
      list: (input) => executionRequest(WS_METHODS.automationList, input),
      getMemory: (input) => executionRequest(WS_METHODS.automationGetMemory, input),
      create: (input) => executionRequest(WS_METHODS.automationCreate, input),
      update: (input) => executionRequest(WS_METHODS.automationUpdate, input),
      delete: (input) => executionRequest(WS_METHODS.automationDelete, input),
      runNow: (input) => executionRequest(WS_METHODS.automationRunNow, input),
      cancelRun: (input) => executionRequest(WS_METHODS.automationCancelRun, input),
      markRunRead: (input) => executionRequest(WS_METHODS.automationMarkRunRead, input),
      archiveRun: (input) => executionRequest(WS_METHODS.automationArchiveRun, input),
      resolveProposal: (input) => executionRequest(WS_METHODS.automationResolveProposal, input),
      onEvent: automationEventListeners.subscribe,
    },
    todo: {
      list: () => executionRequest(WS_METHODS.todoList, {}),
      create: (input) => executionRequest(WS_METHODS.todoCreate, input),
      update: (input) => executionRequest(WS_METHODS.todoUpdate, input),
      delete: (input) => executionRequest(WS_METHODS.todoDelete, input),
      onEvent: todoEventListeners.subscribe,
    },
    device: {
      list: (input) => executionRequest(DEVICE_WS_METHODS.list, input),
      // Booting a cold simulator routinely outruns the default RPC deadline.
      boot: (input) => executionRequest(DEVICE_WS_METHODS.boot, input, { timeoutMs: null }),
      shutdown: (input) => executionRequest(DEVICE_WS_METHODS.shutdown, input),
      attach: (input) => executionRequest(DEVICE_WS_METHODS.attach, input),
      detach: (input) => executionRequest(DEVICE_WS_METHODS.detach, input),
      getThreadState: (input) => executionRequest(DEVICE_WS_METHODS.getThreadState, input),
      tap: (input) => executionRequest(DEVICE_WS_METHODS.tap, input),
      swipe: (input) => executionRequest(DEVICE_WS_METHODS.swipe, input),
      typeText: (input) => executionRequest(DEVICE_WS_METHODS.typeText, input),
      keyEvent: (input) => executionRequest(DEVICE_WS_METHODS.keyEvent, input),
      pressButton: (input) => executionRequest(DEVICE_WS_METHODS.pressButton, input),
      installApp: (input) =>
        executionRequest(DEVICE_WS_METHODS.installApp, input, { timeoutMs: null }),
      launchApp: (input) => executionRequest(DEVICE_WS_METHODS.launchApp, input),
      openUrl: (input) => executionRequest(DEVICE_WS_METHODS.openUrl, input),
      screenshot: (input) => executionRequest(DEVICE_WS_METHODS.screenshot, input),
      startRecording: (input) =>
        executionRequest(DEVICE_WS_METHODS.startRecording, input, { timeoutMs: null }),
      stopRecording: (input) =>
        executionRequest(DEVICE_WS_METHODS.stopRecording, input, { timeoutMs: null }),
      describeUi: (input) => executionRequest(DEVICE_WS_METHODS.describeUi, input),
      // A scroll loop runs several swipe/describe round-trips on the device.
      scrollToElement: (input) =>
        executionRequest(DEVICE_WS_METHODS.scrollToElement, input, { timeoutMs: null }),
      onEvent: deviceEventListeners.subscribe,
    },
    computer: {
      getStatus: (input) => executionRequest(COMPUTER_WS_METHODS.getStatus, input),
      getAuditHistory: (input) => executionRequest(COMPUTER_WS_METHODS.getAuditHistory, input),
      getState: (input) => executionRequest(COMPUTER_WS_METHODS.getState, input),
      provision: (input) =>
        executionRequest(COMPUTER_WS_METHODS.provision, input, { timeoutMs: null }),
      getThreadState: (input) => executionRequest(COMPUTER_WS_METHODS.getThreadState, input),
      setControlEnabled: (input) => executionRequest(COMPUTER_WS_METHODS.setControlEnabled, input),
      inputClick: (input) => executionRequest(COMPUTER_WS_METHODS.inputClick, input),
      inputScroll: (input) => executionRequest(COMPUTER_WS_METHODS.inputScroll, input),
      inputKey: (input) => executionRequest(COMPUTER_WS_METHODS.inputKey, input),
      onEvent: computerEventListeners.subscribe,
    },
    browser: {
      ...(!remoteExecution && window.desktopBridge?.browser?.vault
        ? { vault: window.desktopBridge.browser.vault }
        : {}),
      open: async (input) => {
        if (remoteExecution) throw new Error(REMOTE_NATIVE_UNAVAILABLE);
        if (window.desktopBridge) {
          return window.desktopBridge.browser.open(input);
        }
        const state = ensureFallbackBrowserWorkspace(input.threadId);
        if (input.initialUrl && state.tabs.length > 0) {
          const activeTab = resolveFallbackBrowserTab(state);
          activeTab.url = input.initialUrl;
          activeTab.title = defaultBrowserTitle(input.initialUrl);
          activeTab.lastCommittedUrl = input.initialUrl;
        }
        markFallbackBrowserStateChanged(state);
        return emitFallbackBrowserState(input.threadId);
      },
      close: async (input) => {
        if (remoteExecution) throw new Error(REMOTE_NATIVE_UNAVAILABLE);
        if (window.desktopBridge) {
          return window.desktopBridge.browser.close(input);
        }
        const state = getFallbackBrowserState(input.threadId);
        state.open = false;
        state.activeTabId = null;
        state.tabs = [];
        state.lastError = null;
        markFallbackBrowserStateChanged(state);
        return emitFallbackBrowserState(input.threadId);
      },
      hide: async (input) => {
        if (remoteExecution) throw new Error(REMOTE_NATIVE_UNAVAILABLE);
        if (window.desktopBridge) {
          await window.desktopBridge.browser.hide(input);
        }
      },
      getState: async (input) => {
        if (remoteExecution) throw new Error(REMOTE_NATIVE_UNAVAILABLE);
        if (window.desktopBridge) {
          return window.desktopBridge.browser.getState(input);
        }
        return cloneBrowserState(getFallbackBrowserState(input.threadId));
      },
      setPanelBounds: async (input) => {
        if (remoteExecution) throw new Error(REMOTE_NATIVE_UNAVAILABLE);
        if (window.desktopBridge) {
          await window.desktopBridge.browser.setPanelBounds(input);
          return;
        }
      },
      attachWebview: async (input) => {
        if (remoteExecution) throw new Error(REMOTE_NATIVE_UNAVAILABLE);
        if (window.desktopBridge) {
          return window.desktopBridge.browser.attachWebview(input);
        }
        return cloneBrowserState(getFallbackBrowserState(input.threadId));
      },
      detachWebview: async (input) => {
        if (remoteExecution) throw new Error(REMOTE_NATIVE_UNAVAILABLE);
        if (window.desktopBridge) {
          await window.desktopBridge.browser.detachWebview(input);
        }
      },
      copyLink: async (input) => {
        if (remoteExecution) throw new Error(REMOTE_NATIVE_UNAVAILABLE);
        if (window.desktopBridge) {
          await window.desktopBridge.browser.copyLink(input);
          return;
        }
        throw new Error("Copying the browser link requires the desktop app.");
      },
      copyScreenshotToClipboard: async (input) => {
        if (remoteExecution) throw new Error(REMOTE_NATIVE_UNAVAILABLE);
        if (window.desktopBridge) {
          await window.desktopBridge.browser.copyScreenshotToClipboard(input);
          return;
        }
        throw new Error("Browser screenshots require the desktop app.");
      },
      captureScreenshot: async (input) => {
        if (remoteExecution) throw new Error(REMOTE_NATIVE_UNAVAILABLE);
        if (window.desktopBridge) {
          return window.desktopBridge.browser.captureScreenshot(input);
        }
        throw new Error("Browser screenshots require the desktop app.");
      },
      capturePreview: async (input) =>
        remoteExecution ? null : (window.desktopBridge?.browser.capturePreview(input) ?? null),
      navigate: async (input) => {
        if (remoteExecution) throw new Error(REMOTE_NATIVE_UNAVAILABLE);
        if (window.desktopBridge) {
          return window.desktopBridge.browser.navigate(input);
        }
        const state = ensureFallbackBrowserWorkspace(input.threadId);
        const tab = resolveFallbackBrowserTab(state, input.tabId);
        tab.url = input.url;
        tab.title = defaultBrowserTitle(input.url);
        tab.lastCommittedUrl = input.url;
        tab.lastError = null;
        tab.status = "live";
        state.activeTabId = tab.id;
        markFallbackBrowserStateChanged(state);
        return emitFallbackBrowserState(input.threadId);
      },
      reload: async (input) => {
        if (remoteExecution) throw new Error(REMOTE_NATIVE_UNAVAILABLE);
        if (window.desktopBridge) {
          return window.desktopBridge.browser.reload(input);
        }
        return cloneBrowserState(getFallbackBrowserState(input.threadId));
      },
      goBack: async (input) => {
        if (remoteExecution) throw new Error(REMOTE_NATIVE_UNAVAILABLE);
        if (window.desktopBridge) {
          return window.desktopBridge.browser.goBack(input);
        }
        return cloneBrowserState(getFallbackBrowserState(input.threadId));
      },
      goForward: async (input) => {
        if (remoteExecution) throw new Error(REMOTE_NATIVE_UNAVAILABLE);
        if (window.desktopBridge) {
          return window.desktopBridge.browser.goForward(input);
        }
        return cloneBrowserState(getFallbackBrowserState(input.threadId));
      },
      newTab: async (input) => {
        if (remoteExecution) throw new Error(REMOTE_NATIVE_UNAVAILABLE);
        if (window.desktopBridge) {
          return window.desktopBridge.browser.newTab(input);
        }
        const state = ensureFallbackBrowserWorkspace(input.threadId);
        const tab = createFallbackTab(input.url);
        state.tabs = [...state.tabs, tab];
        if (input.activate !== false || !state.activeTabId) {
          state.activeTabId = tab.id;
        }
        markFallbackBrowserStateChanged(state);
        return emitFallbackBrowserState(input.threadId);
      },
      closeTab: async (input) => {
        if (remoteExecution) throw new Error(REMOTE_NATIVE_UNAVAILABLE);
        if (window.desktopBridge) {
          return window.desktopBridge.browser.closeTab(input);
        }
        const state = ensureFallbackBrowserWorkspace(input.threadId);
        const nextTabs = state.tabs.filter((tab) => tab.id !== input.tabId);
        if (nextTabs.length === state.tabs.length) {
          return cloneBrowserState(state);
        }
        state.tabs = nextTabs;
        if (nextTabs.length === 0) {
          const replacementTab = createFallbackTab();
          state.tabs = [replacementTab];
          state.activeTabId = replacementTab.id;
          state.lastError = null;
        } else if (!state.tabs.some((tab) => tab.id === state.activeTabId)) {
          state.activeTabId = state.tabs[0]?.id ?? null;
        }
        markFallbackBrowserStateChanged(state);
        return emitFallbackBrowserState(input.threadId);
      },
      selectTab: async (input) => {
        if (remoteExecution) throw new Error(REMOTE_NATIVE_UNAVAILABLE);
        if (window.desktopBridge) {
          return window.desktopBridge.browser.selectTab(input);
        }
        const state = ensureFallbackBrowserWorkspace(input.threadId);
        const tab = resolveFallbackBrowserTab(state, input.tabId);
        state.activeTabId = tab.id;
        markFallbackBrowserStateChanged(state);
        return emitFallbackBrowserState(input.threadId);
      },
      openDevTools: async (input) => {
        if (remoteExecution) throw new Error(REMOTE_NATIVE_UNAVAILABLE);
        if (window.desktopBridge) {
          await window.desktopBridge.browser.openDevTools(input);
        }
      },
      annotations: {
        start: async (input) => {
          if (remoteExecution) throw new Error(REMOTE_NATIVE_UNAVAILABLE);
          if (window.desktopBridge) {
            return window.desktopBridge.browser.annotations.start(input);
          }
          throw new Error("Browser annotations require the desktop app.");
        },
        cancel: async (input) => {
          if (remoteExecution) throw new Error(REMOTE_NATIVE_UNAVAILABLE);
          if (window.desktopBridge) {
            await window.desktopBridge.browser.annotations.cancel(input);
            return;
          }
          throw new Error("Browser annotations require the desktop app.");
        },
        syncMarkers: async (input) => {
          if (remoteExecution) throw new Error(REMOTE_NATIVE_UNAVAILABLE);
          if (window.desktopBridge) {
            await window.desktopBridge.browser.annotations.syncMarkers(input);
            return;
          }
          throw new Error("Browser annotations require the desktop app.");
        },
        onEvent: (callback) => {
          if (remoteExecution) return () => {};
          if (window.desktopBridge) {
            return window.desktopBridge.browser.annotations.onEvent(callback);
          }
          return () => {};
        },
      },
      onState: (callback) => {
        if (remoteExecution) return () => {};
        if (window.desktopBridge) {
          return window.desktopBridge.browser.onState(callback);
        }
        return fallbackBrowserStateListeners.subscribe(callback);
      },
      onCopyLink: (callback) => {
        if (remoteExecution) return () => {};
        if (window.desktopBridge) {
          return window.desktopBridge.browser.onBrowserCopyLink(callback);
        }
        return () => {};
      },
    },
  };

  instance = { api, transport };
  return api;
}

// Browser-mode tests mount full app roots repeatedly in one page; reset the
// singleton so each test gets a fresh WebSocket stream and cached push state.
export async function resetWsNativeApiForTest(): Promise<void> {
  instance = null;
  clearWsNativeApiListeners();
  fallbackBrowserStates.clear();
  await disposeConnectionClients();
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    void disposeConnectionClients();
    instance = null;
    clearWsNativeApiListeners();
  });
}
