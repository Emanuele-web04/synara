import {
  COMPANION_RPC_METHODS,
  type CompanionActivity,
  type CompanionApprovalRequest,
  type CompanionProject,
  type CompanionGetThreadDiffResult,
  type CompanionMessage,
  type CompanionShellSnapshot,
  type CompanionShellStreamItem,
  type CompanionThreadDetail,
  type CompanionThreadStreamItem,
  type CompanionThreadSummary,
  type CompanionUserInputRequest,
  type ModelSelection,
} from "@synara/contracts";
import {
  createCompanionAuthClient,
  createCompanionConnection,
  type CompanionAuthClient,
  type CompanionConnection,
  type CompanionManagedSubscription,
} from "@synara/client";
import { DateTime } from "effect";
import type {
  CompanionGateway,
  CompanionSession,
  ComposerOption,
  CreateThreadInput,
  GatewayConnection,
  GatewayEvents,
  NotificationSettings,
  PendingApproval,
  PendingUserInput,
  ProjectSummary,
  SendTurnInput,
  ShellSnapshot,
  ThreadActivity,
  ThreadDetail,
  ThreadDiff,
  ThreadMessage,
  ThreadStatus,
  ThreadSummary,
  UploadProgress,
} from "../domain";
import { effectCompanionTransportFactory } from "./effectTransport";
import { parseUnifiedDiff } from "./diffParser";

const baseUrl = window.location.origin;
const deviceLabelKey = "synara-companion-device-label";
const uploadPath = "/api/companion/v1/attachments";
const pushPath = "/api/companion/v1/push-subscriptions";
const pushPreviewKey = "synara-companion-notification-preview";

export function createBrowserCompanionGateway(): CompanionGateway {
  return new BrowserCompanionGateway(
    createCompanionAuthClient({
      baseUrl,
      fetch: (input, init) => fetch(input, init as RequestInit),
    }),
  );
}

class BrowserCompanionGateway implements CompanionGateway {
  private connection: CompanionConnection | null = null;
  private shellSubscription: CompanionManagedSubscription | null = null;
  private readonly threadSubscriptions = new Map<string, CompanionManagedSubscription>();
  private readonly threadLeases = new Map<string, Set<number>>();
  private readonly rawThreads = new Map<string, CompanionThreadDetail>();
  private shell: CompanionShellSnapshot | null = null;
  private events: GatewayEvents | null = null;
  private stopping = false;
  private readonly pendingThreadEvents = new Map<string, ThreadDetail>();
  private threadFlushFrame: number | null = null;
  private nextThreadLeaseId = 1;
  private connectionGeneration = 0;
  private connectionOperation: Promise<void> = Promise.resolve();

  constructor(private readonly auth: CompanionAuthClient) {}

  async getSession(signal?: AbortSignal): Promise<CompanionSession | null> {
    const state = await this.auth.getSession(signal ? { signal } : undefined);
    if (!state.authenticated) return null;
    return {
      id: "active-browser-session",
      deviceLabel: sessionStorage.getItem(deviceLabelKey) ?? defaultDeviceLabel(),
      expiresAt:
        state.expiresAt !== undefined
          ? DateTime.formatIso(state.expiresAt)
          : new Date(Date.now() + 30 * 86_400_000).toISOString(),
      serverVersion: "0.5.5",
    };
  }

  async pair(
    input: { token: string; deviceLabel: string },
    signal?: AbortSignal,
  ): Promise<void> {
    const result = await this.auth.bootstrap(input.token, {
      deviceLabel: input.deviceLabel,
      ...(signal ? { signal } : {}),
    });
    if (result.accessProfile !== "companion") {
      await this.auth.logout().catch(() => undefined);
      throw new Error("This pairing code does not grant Companion access.");
    }
    sessionStorage.setItem(deviceLabelKey, input.deviceLabel);
  }

  async updateDeviceLabel(deviceLabel: string, signal?: AbortSignal): Promise<string> {
    const response = await this.auth.updateDeviceLabel(
      deviceLabel,
      signal ? { signal } : undefined,
    );
    sessionStorage.setItem(deviceLabelKey, response.deviceLabel);
    return response.deviceLabel;
  }

  connect(events: GatewayEvents, signal?: AbortSignal): Promise<GatewayConnection> {
    return this.withConnectionLock(() => this.connectLocked(events, signal));
  }

  private async connectLocked(
    events: GatewayEvents,
    signal?: AbortSignal,
  ): Promise<GatewayConnection> {
    await this.stopCurrentConnection();
    const generation = ++this.connectionGeneration;
    this.events = events;
    this.stopping = false;
    const connection = createCompanionConnection({
      baseUrl,
      client: {
        name: "Synara Companion",
        version: "0.5.5",
        platform: clientPlatform(),
      },
      tokenProvider: this.auth,
      transportFactory: effectCompanionTransportFactory,
    });
    this.connection = connection;
    let wasReady = false;
    let lastReportedAttempt = -1;
    const removeStateListener = connection.onState((state) => {
      if (generation !== this.connectionGeneration) return;
      if (state.status === "ready") {
        wasReady = true;
        lastReportedAttempt = -1;
        const hello = state.hello;
        if (hello) {
          sessionStorage.setItem(deviceLabelKey, hello.session.deviceLabel);
          events.onReady({
            id: hello.session.id,
            deviceLabel: hello.session.deviceLabel,
            expiresAt: DateTime.formatIso(hello.session.expiresAt),
            serverVersion: hello.serverVersion,
          });
        }
      } else if (
        state.status === "stopped" &&
        (state.error?.code === "SessionExpired" || state.error?.code === "Unauthenticated")
      ) {
        events.onSessionEnded(state.error.message);
      } else if (
        !this.stopping &&
        (state.status === "disconnected" || state.status === "stopped") &&
        (wasReady || state.attempt > 0) &&
        state.attempt !== lastReportedAttempt
      ) {
        lastReportedAttempt = state.attempt;
        this.rawThreads.clear();
        this.shell = null;
        events.onDisconnect(state.error?.message ?? "The Synara host disconnected.");
      }
    });
    this.shellSubscription = connection.subscribe(
      COMPANION_RPC_METHODS.subscribeShell,
      {},
      {
        onItem: (item) => {
          if (generation === this.connectionGeneration) this.applyShellItem(item);
        },
        onError: (error) => {
          if (generation === this.connectionGeneration && !this.stopping) {
            events.onDisconnect(errorMessage(error));
          }
        },
      },
    );
    connection.start();
    if (signal?.aborted) {
      removeStateListener();
      await this.stopCurrentConnection(generation);
      throw signal.reason;
    }
    return {
      close: () => {
        removeStateListener();
        void this.stopConnection(generation);
      },
    };
  }

  async refreshShell(signal?: AbortSignal): Promise<ShellSnapshot> {
    const connection = this.requireConnection();
    const [projects, threads] = await Promise.all([
      connection.request(COMPANION_RPC_METHODS.listProjects, {}, signal ? { signal } : undefined),
      this.listAllThreads(connection, signal),
    ]);
    const updatedAt = new Date().toISOString();
    this.shell = {
      snapshotSequence: this.shell?.snapshotSequence ?? 0,
      projects: projects.projects,
      threads,
      updatedAt,
    } as CompanionShellSnapshot;
    const snapshot = mapShell(this.shell);
    this.events?.onShell(snapshot);
    return snapshot;
  }

  async getThread(threadId: string, signal?: AbortSignal): Promise<ThreadDetail> {
    const connection = this.requireConnection();
    const detail = await connection.request(
      COMPANION_RPC_METHODS.getThread,
      { threadId } as never,
      signal ? { signal } : undefined,
    );
    this.rawThreads.set(threadId, detail);
    if ((this.threadLeases.get(threadId)?.size ?? 0) > 0) {
      this.ensureThreadSubscription(threadId);
    }
    const mapped = mapThreadDetail(detail);
    this.events?.onThread(mapped);
    return mapped;
  }

  retainThread(threadId: string): number {
    const leaseId = this.nextThreadLeaseId++;
    const leases = this.threadLeases.get(threadId) ?? new Set<number>();
    leases.add(leaseId);
    this.threadLeases.set(threadId, leases);
    return leaseId;
  }

  async releaseThread(threadId: string, leaseId: number): Promise<void> {
    const leases = this.threadLeases.get(threadId);
    leases?.delete(leaseId);
    if (leases && leases.size > 0) return;
    this.threadLeases.delete(threadId);
    const subscription = this.threadSubscriptions.get(threadId);
    this.threadSubscriptions.delete(threadId);
    this.rawThreads.delete(threadId);
    await subscription?.unsubscribe().catch(() => undefined);
  }

  async getDiff(threadId: string, signal?: AbortSignal): Promise<ThreadDiff> {
    const result = await this.requireConnection().request(
      COMPANION_RPC_METHODS.getThreadDiff,
      { threadId } as never,
      signal ? { signal } : undefined,
    );
    return mapDiff(result);
  }

  async getComposerOptions(
    projectId: string,
    signal?: AbortSignal,
  ): Promise<readonly ComposerOption[]> {
    const result = await this.requireConnection().request(
      COMPANION_RPC_METHODS.listComposerOptions,
      { projectId } as never,
      signal ? { signal } : undefined,
    );
    return result.providers.flatMap((provider) =>
      provider.models.map((model) => ({
        providerId: provider.provider,
        providerLabel: provider.displayName,
        modelId: model.slug,
        modelLabel: model.name,
        interactionModes: result.interactionModes,
      })),
    );
  }

  async createThread(input: CreateThreadInput, signal?: AbortSignal): Promise<ThreadDetail> {
    await this.requireConnection().request(
      COMPANION_RPC_METHODS.createThread,
      {
        requestId: input.requestId,
        threadId: input.threadId,
        projectId: input.projectId,
        providerId: input.providerId,
        modelId: input.modelId,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        ...(input.runtimeMode === "full-access" && input.fullAccessConfirmed
          ? { fullAccessConfirmed: true as const }
          : {}),
        ...(input.initialTitle ? { initialTitle: input.initialTitle } : {}),
      } as never,
      signal ? { signal } : undefined,
    );
    return this.getThread(input.threadId, signal);
  }

  async sendTurn(input: SendTurnInput, signal?: AbortSignal): Promise<void> {
    await this.requireConnection().request(
      COMPANION_RPC_METHODS.sendTurn,
      input as never,
      signal ? { signal } : undefined,
    );
  }

  async interrupt(threadId: string, requestId: string, signal?: AbortSignal): Promise<void> {
    await this.requireConnection().request(
      COMPANION_RPC_METHODS.interruptTurn,
      { threadId, requestId } as never,
      signal ? { signal } : undefined,
    );
  }

  async respondToApproval(
    threadId: string,
    approvalId: string,
    decision: "approve" | "deny",
    requestId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.requireConnection().request(
      COMPANION_RPC_METHODS.respondToApproval,
      {
        threadId,
        approvalRequestId: approvalId,
        decision: decision === "approve" ? "accept" : "decline",
        requestId,
      } as never,
      signal ? { signal } : undefined,
    );
  }

  async respondToInput(
    threadId: string,
    inputId: string,
    answers: Readonly<Record<string, string | readonly string[]>>,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const request = this.rawThreads
      .get(threadId)
      ?.userInputRequests.find((candidate) => candidate.requestId === inputId);
    if (!request) throw new Error("This input request is no longer active.");
    const allowedQuestionIds = new Set(request.questions.map((question) => question.id));
    const normalizedAnswers = Object.fromEntries(
      Object.entries(answers)
        .filter(([questionId]) => allowedQuestionIds.has(questionId))
        .map(([questionId, value]) => [questionId, Array.isArray(value) ? [...value] : value]),
    );
    if (Object.keys(normalizedAnswers).length !== request.questions.length) {
      throw new Error("Answer every question before sending your response.");
    }
    await this.requireConnection().request(
      COMPANION_RPC_METHODS.respondToUserInput,
      {
        threadId,
        userInputRequestId: inputId,
        answers: normalizedAnswers,
        requestId,
      } as never,
      signal ? { signal } : undefined,
    );
  }

  uploadAttachment(
    threadId: string,
    file: File,
    onProgress: (progress: UploadProgress) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open("POST", uploadPath);
      request.withCredentials = true;
      request.responseType = "json";
      request.upload.addEventListener("progress", (event) => {
        onProgress({ loaded: event.loaded, total: event.lengthComputable ? event.total : file.size });
      });
      request.addEventListener("load", () => {
        const response: unknown = request.response;
        if (request.status >= 200 && request.status < 300 && isUploadResponse(response)) {
          resolve(response.id);
        } else {
          reject(new Error(responseMessage(response, "The attachment upload was rejected.")));
        }
      });
      request.addEventListener("error", () => reject(new Error("The attachment upload failed.")));
      request.addEventListener("abort", () => reject(new DOMException("Upload cancelled", "AbortError")));
      const abort = () => request.abort();
      signal?.addEventListener("abort", abort, { once: true });
      const form = new FormData();
      form.set("threadId", threadId);
      form.set("file", file, file.name);
      request.send(form);
    });
  }

  async cancelAttachment(attachmentId: string, signal?: AbortSignal): Promise<void> {
    await apiJson(`${uploadPath}/${encodeURIComponent(attachmentId)}`, {
      method: "DELETE",
      ...(signal ? { signal } : {}),
    });
  }

  async getNotificationSettings(signal?: AbortSignal): Promise<NotificationSettings> {
    const browserSupported =
      window.isSecureContext &&
      "Notification" in window &&
      "serviceWorker" in navigator &&
      "PushManager" in window;
    if (!browserSupported) return unsupportedNotificationSettings();
    const config = await apiJson("/api/companion/v1/push/config", {
      ...(signal ? { signal } : {}),
    });
    if (!isPushConfig(config) || !config.supported || !config.vapidPublicKey) {
      return unsupportedNotificationSettings();
    }
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    return {
      supported: true,
      permission: Notification.permission,
      subscribed: subscription !== null,
      previewEnabled: localStorage.getItem(pushPreviewKey) !== "false",
    };
  }

  async subscribeToNotifications(
    previewEnabled: boolean,
    signal?: AbortSignal,
  ): Promise<NotificationSettings> {
    if (!("Notification" in window)) throw new Error("Notifications are not supported.");
    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error("Notification permission was not granted.");
    const config = await apiJson("/api/companion/v1/push/config", {
      ...(signal ? { signal } : {}),
    });
    if (!isPushConfig(config) || !config.supported || !config.vapidPublicKey) {
      throw new Error("Push notifications are not configured on the host.");
    }
    const registration = await navigator.serviceWorker.ready;
    const subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlBytes(config.vapidPublicKey),
      }));
    await upsertPushSubscription(subscription, previewEnabled, signal);
    localStorage.setItem(pushPreviewKey, String(previewEnabled));
    return { supported: true, permission, subscribed: true, previewEnabled };
  }

  async setNotificationPreview(enabled: boolean, signal?: AbortSignal): Promise<void> {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) throw new Error("Notifications are not enabled on this device.");
    await upsertPushSubscription(subscription, enabled, signal);
    localStorage.setItem(pushPreviewKey, String(enabled));
  }

  async sendTestNotification(signal?: AbortSignal): Promise<void> {
    await apiJson("/api/companion/v1/push/test", {
      method: "POST",
      ...(signal ? { signal } : {}),
    });
  }

  async logout(signal?: AbortSignal): Promise<void> {
    await this.stopConnection();
    await this.auth.logout(signal ? { signal } : undefined);
    sessionStorage.removeItem(deviceLabelKey);
  }

  private applyShellItem(item: CompanionShellStreamItem): void {
    if (item.kind === "snapshot") {
      this.shell = item.snapshot;
    } else if (this.shell) {
      switch (item.kind) {
        case "project-upserted":
          this.shell = {
            ...this.shell,
            snapshotSequence: item.sequence,
            projects: upsert(this.shell.projects, item.project),
          };
          break;
        case "project-removed":
          this.shell = {
            ...this.shell,
            snapshotSequence: item.sequence,
            projects: this.shell.projects.filter((project) => project.id !== item.projectId),
          };
          break;
        case "thread-upserted":
          this.shell = {
            ...this.shell,
            snapshotSequence: item.sequence,
            threads: upsert(this.shell.threads, item.thread),
          };
          break;
        case "thread-removed":
          this.shell = {
            ...this.shell,
            snapshotSequence: item.sequence,
            threads: this.shell.threads.filter((thread) => thread.id !== item.threadId),
          };
          break;
      }
    }
    if (this.shell) this.events?.onShell(mapShell(this.shell));
  }

  private applyThreadItem(threadId: string, item: CompanionThreadStreamItem): void {
    if (item.kind === "snapshot") {
      this.rawThreads.set(threadId, item.snapshot.detail);
    } else {
      const current = this.rawThreads.get(threadId);
      if (!current) return;
      let next = current;
      switch (item.kind) {
        case "thread-updated":
          next = { ...current, thread: item.thread };
          break;
        case "message-upserted":
          next = { ...current, messages: upsert(current.messages, item.message) };
          break;
        case "message-removed":
          next = {
            ...current,
            messages: current.messages.filter((message) => message.id !== item.messageId),
          };
          break;
        case "activity-upserted":
          next = { ...current, activities: upsert(current.activities, item.activity) };
          break;
        case "approval-upserted":
          next = { ...current, approvals: upsertByRequestId(current.approvals, item.approval) };
          break;
        case "approval-removed":
          next = {
            ...current,
            approvals: current.approvals.filter(
              (approval) => approval.requestId !== item.requestId,
            ),
          };
          break;
        case "user-input-upserted":
          next = {
            ...current,
            userInputRequests: upsertByRequestId(current.userInputRequests, item.request),
          };
          break;
        case "user-input-removed":
          next = {
            ...current,
            userInputRequests: current.userInputRequests.filter(
              (request) => request.requestId !== item.requestId,
            ),
          };
          break;
        case "resync-required":
          void this.getThread(threadId).catch(() => undefined);
          return;
      }
      this.rawThreads.set(threadId, next);
    }
    const detail = this.rawThreads.get(threadId);
    if (detail) this.queueThreadEvent(mapThreadDetail(detail));
  }

  private queueThreadEvent(detail: ThreadDetail): void {
    this.pendingThreadEvents.set(detail.id, detail);
    if (this.threadFlushFrame !== null) return;
    this.threadFlushFrame = window.requestAnimationFrame(() => {
      this.threadFlushFrame = null;
      const events = this.events;
      const pending = [...this.pendingThreadEvents.values()];
      this.pendingThreadEvents.clear();
      if (!events || this.stopping) return;
      for (const thread of pending) events.onThread(thread);
    });
  }

  private ensureThreadSubscription(threadId: string): void {
    if (this.threadSubscriptions.has(threadId)) return;
    const generation = this.connectionGeneration;
    const subscription = this.requireConnection().subscribe(
      COMPANION_RPC_METHODS.subscribeThread,
      { threadId } as never,
      {
        onItem: (item) => {
          if (generation === this.connectionGeneration) this.applyThreadItem(threadId, item);
        },
        onError: (error) => {
          if (generation === this.connectionGeneration && !this.stopping) {
            this.events?.onDisconnect(errorMessage(error));
          }
        },
      },
    );
    this.threadSubscriptions.set(threadId, subscription);
  }

  private requireConnection(): CompanionConnection {
    if (!this.connection || this.connection.state.status !== "ready") {
      throw new Error("Synara is not connected. Commands are not queued offline.");
    }
    return this.connection;
  }

  private async listAllThreads(
    connection: CompanionConnection,
    signal?: AbortSignal,
  ): Promise<CompanionThreadSummary[]> {
    const threads: CompanionThreadSummary[] = [];
    let cursor: string | undefined;
    do {
      const page = await connection.request(
        COMPANION_RPC_METHODS.listThreads,
        { limit: 100, ...(cursor ? { cursor } : {}) } as never,
        signal ? { signal } : undefined,
      );
      threads.push(...page.threads);
      cursor = page.nextCursor ?? undefined;
    } while (cursor && threads.length < 1_000);
    return threads;
  }

  private stopConnection(expectedGeneration?: number): Promise<void> {
    return this.withConnectionLock(() => this.stopCurrentConnection(expectedGeneration));
  }

  private async stopCurrentConnection(expectedGeneration?: number): Promise<void> {
    if (
      expectedGeneration !== undefined &&
      expectedGeneration !== this.connectionGeneration
    ) {
      return;
    }
    this.stopping = true;
    if (this.threadFlushFrame !== null) {
      window.cancelAnimationFrame(this.threadFlushFrame);
      this.threadFlushFrame = null;
    }
    this.pendingThreadEvents.clear();
    await this.shellSubscription?.unsubscribe().catch(() => undefined);
    this.shellSubscription = null;
    await Promise.all(
      [...this.threadSubscriptions.values()].map((subscription) =>
        subscription.unsubscribe().catch(() => undefined),
      ),
    );
    this.threadSubscriptions.clear();
    this.threadLeases.clear();
    await this.connection?.stop().catch(() => undefined);
    this.connection = null;
    this.rawThreads.clear();
    this.shell = null;
  }

  private withConnectionLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.connectionOperation.then(operation, operation);
    this.connectionOperation = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

function mapShell(snapshot: CompanionShellSnapshot): ShellSnapshot {
  return {
    sequence: snapshot.snapshotSequence,
    projects: snapshot.projects.map(mapProject),
    threads: snapshot.threads.map(mapThreadSummary),
  };
}

function mapProject(project: CompanionProject): ProjectSummary {
  return {
    id: project.id,
    name: project.title,
    workspaceLabel: project.kind === "project" ? "Local project" : humanize(project.kind),
  };
}

function mapThreadSummary(thread: CompanionThreadSummary): ThreadSummary {
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    status: threadStatus(thread),
    providerLabel: providerName(thread.modelSelection),
    modelLabel: thread.modelSelection.model,
    updatedAt: thread.updatedAt,
  };
}

function mapThreadDetail(detail: CompanionThreadDetail): ThreadDetail {
  const summary = mapThreadSummary(detail.thread);
  const approval = detail.approvals[0];
  const input = detail.userInputRequests[0];
  return {
    ...summary,
    sequence: maximumActivitySequence(detail.activities),
    messages: detail.messages.map(mapMessage),
    activity: detail.activities.map(mapActivity),
    ...(approval ? { pendingApproval: mapApproval(approval) } : {}),
    ...(input ? { pendingInput: mapUserInput(input) } : {}),
  };
}

function mapMessage(message: CompanionMessage): ThreadMessage {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    createdAt: message.createdAt,
    ...(message.streaming ? { streaming: true } : {}),
  };
}

function mapActivity(activity: CompanionActivity): ThreadActivity {
  return {
    id: activity.id,
    title: activity.summary,
    tone: activityTone(activity.tone),
    createdAt: activity.createdAt,
  };
}

function mapApproval(approval: CompanionApprovalRequest): PendingApproval {
  return {
    id: approval.requestId,
    title: humanize(approval.requestKind),
    description: approval.summary,
    risk: approval.requestKind === "command" ? "high" : "medium",
  };
}

function mapUserInput(request: CompanionUserInputRequest): PendingUserInput {
  return {
    id: request.requestId,
    questions: request.questions.map((question) => ({
      id: question.id,
      header: question.header,
      prompt: question.question,
      multiSelect: question.multiSelect ?? false,
      ...(question.options.length
        ? {
            choices: question.options.map((option) => ({
              value: option.label,
              label: option.label,
              description: option.description,
            })),
          }
        : {}),
    })),
  };
}

function threadStatus(thread: CompanionThreadSummary): ThreadStatus {
  if (thread.hasPendingApprovals) return "waiting-approval";
  if (thread.hasPendingUserInput) return "waiting-input";
  if (thread.runtime?.status === "starting" || thread.runtime?.status === "running") {
    return "running";
  }
  if (thread.latestTurn?.state === "running") return "running";
  if (thread.runtime?.status === "error" || thread.latestTurn?.state === "error") return "failed";
  if (thread.latestTurn?.state === "interrupted") return "interrupted";
  if (thread.latestTurn?.state === "completed") return "completed";
  return "idle";
}

function providerName(selection: ModelSelection): string {
  switch (selection.provider) {
    case "claudeAgent":
      return "Claude";
    case "opencode":
      return "OpenCode";
    case "antigravity":
      return "Antigravity";
    default:
      return selection.provider.charAt(0).toUpperCase() + selection.provider.slice(1);
  }
}

function mapDiff(result: CompanionGetThreadDiffResult): ThreadDiff {
  return { threadId: result.threadId, files: parseUnifiedDiff(result.diff) };
}

function maximumActivitySequence(activities: readonly CompanionActivity[]): number {
  return activities.reduce((maximum, activity) => Math.max(maximum, activity.sequence), 0);
}

function activityTone(tone: CompanionActivity["tone"]): ThreadActivity["tone"] {
  if (tone === "approval") return "warning";
  if (tone === "error") return "failure";
  return "neutral";
}

function upsert<T extends { readonly id: string }>(items: readonly T[], item: T): readonly T[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index < 0) return [...items, item];
  const next = [...items];
  next[index] = item;
  return next;
}

function upsertByRequestId<T extends { readonly requestId: string }>(
  items: readonly T[],
  item: T,
): readonly T[] {
  const index = items.findIndex((candidate) => candidate.requestId === item.requestId);
  if (index < 0) return [...items, item];
  const next = [...items];
  next[index] = item;
  return next;
}

function humanize(value: string): string {
  return value.replaceAll("-", " ").replace(/^./, (character) => character.toUpperCase());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The Synara connection failed.";
}

function defaultDeviceLabel(): string {
  return navigator.platform ? `${navigator.platform} companion` : "Mobile companion";
}

function clientPlatform(): "web" | "ios" | "android" {
  if (/iPad|iPhone|iPod/.test(navigator.userAgent)) return "ios";
  if (/Android/.test(navigator.userAgent)) return "android";
  return "web";
}

function isUploadResponse(value: unknown): value is { readonly id: string } {
  return Boolean(value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string");
}

function responseMessage(value: unknown, fallback: string): string {
  if (value && typeof value === "object" && typeof (value as { message?: unknown }).message === "string") {
    return (value as { message: string }).message;
  }
  return fallback;
}

function unsupportedNotificationSettings(): NotificationSettings {
  return {
    supported: false,
    permission: "unsupported",
    subscribed: false,
    previewEnabled: true,
  };
}

function isPushConfig(
  value: unknown,
): value is { readonly supported: boolean; readonly vapidPublicKey: string | null } {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as { supported?: unknown }).supported === "boolean" &&
      (typeof (value as { vapidPublicKey?: unknown }).vapidPublicKey === "string" ||
        (value as { vapidPublicKey?: unknown }).vapidPublicKey === null),
  );
}

async function apiJson(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers: { Accept: "application/json", ...init.headers },
  });
  const value: unknown = await response.json().catch(() => undefined);
  if (!response.ok) throw new Error(responseMessage(value, `Synara rejected the request (${response.status}).`));
  return value;
}

async function upsertPushSubscription(
  subscription: PushSubscription,
  previewEnabled: boolean,
  signal?: AbortSignal,
): Promise<void> {
  const p256dh = subscription.getKey("p256dh");
  const auth = subscription.getKey("auth");
  if (!p256dh || !auth) throw new Error("The browser returned an incomplete push subscription.");
  await apiJson(pushPath, {
    method: "POST",
    ...(signal ? { signal } : {}),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      subscription: {
        transport: "webpush",
        endpoint: subscription.endpoint,
        keys: { p256dh: base64Url(p256dh), auth: base64Url(auth) },
      },
      previewEnabled,
    }),
  });
}

function base64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlBytes(value: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
