export type ConnectionPhase =
  | "checking-session"
  | "unauthenticated"
  | "connecting"
  | "online"
  | "offline";

export type ThreadStatus =
  | "idle"
  | "running"
  | "waiting-approval"
  | "waiting-input"
  | "completed"
  | "failed"
  | "interrupted";

export interface CompanionSession {
  readonly id: string;
  readonly deviceLabel: string;
  readonly expiresAt: string;
  readonly serverVersion: string;
}

export interface ProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly workspaceLabel: string;
}

export interface ThreadSummary {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly status: ThreadStatus;
  readonly providerLabel: string;
  readonly modelLabel: string;
  readonly updatedAt: string;
  readonly summary?: string;
}

export interface ShellSnapshot {
  readonly sequence: number;
  readonly projects: readonly ProjectSummary[];
  readonly threads: readonly ThreadSummary[];
}

export interface ThreadMessage {
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly createdAt: string;
  readonly streaming?: boolean;
}

export interface ThreadActivity {
  readonly id: string;
  readonly title: string;
  readonly detail?: string;
  readonly tone: "neutral" | "success" | "warning" | "failure";
  readonly createdAt: string;
}

export interface PendingApproval {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly risk: "low" | "medium" | "high";
}

export interface InputChoice {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

export interface PendingUserInput {
  readonly id: string;
  readonly questions: readonly PendingInputQuestion[];
}

export interface PendingInputQuestion {
  readonly id: string;
  readonly header: string;
  readonly prompt: string;
  readonly choices?: readonly InputChoice[];
  readonly multiSelect: boolean;
}

export interface ThreadDetail extends ThreadSummary {
  readonly sequence: number;
  readonly messages: readonly ThreadMessage[];
  readonly activity: readonly ThreadActivity[];
  readonly pendingApproval?: PendingApproval;
  readonly pendingInput?: PendingUserInput;
}

export interface ComposerOption {
  readonly providerId: string;
  readonly providerLabel: string;
  readonly modelId: string;
  readonly modelLabel: string;
  readonly interactionModes: readonly string[];
}

export interface DiffLine {
  readonly kind: "context" | "addition" | "deletion" | "header";
  readonly oldLine?: number;
  readonly newLine?: number;
  readonly text: string;
}

export interface DiffFile {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
  readonly lines: readonly DiffLine[];
}

export interface ThreadDiff {
  readonly threadId: string;
  readonly files: readonly DiffFile[];
}

export interface CreateThreadInput {
  readonly requestId: string;
  readonly threadId: string;
  readonly projectId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly runtimeMode: "approval-required" | "full-access";
  readonly fullAccessConfirmed: boolean;
  readonly interactionMode: string;
  readonly initialTitle?: string;
}

export interface SendTurnInput {
  readonly requestId: string;
  readonly threadId: string;
  readonly text: string;
  readonly attachmentIds: readonly string[];
  readonly delivery: "queue" | "steer";
}

export interface UploadProgress {
  readonly loaded: number;
  readonly total: number;
}

export interface NotificationSettings {
  readonly supported: boolean;
  readonly permission: NotificationPermission | "unsupported";
  readonly subscribed: boolean;
  readonly previewEnabled: boolean;
}

export interface GatewayConnection {
  close(): void;
}

export interface GatewayEvents {
  onReady(session: CompanionSession): void;
  onShell(snapshot: ShellSnapshot): void;
  onThread(thread: ThreadDetail): void;
  onDisconnect(reason: string): void;
  onSessionEnded(reason: string): void;
}

export interface CompanionGateway {
  getSession(signal?: AbortSignal): Promise<CompanionSession | null>;
  pair(input: { token: string; deviceLabel: string }, signal?: AbortSignal): Promise<void>;
  updateDeviceLabel(deviceLabel: string, signal?: AbortSignal): Promise<string>;
  connect(events: GatewayEvents, signal?: AbortSignal): Promise<GatewayConnection>;
  refreshShell(signal?: AbortSignal): Promise<ShellSnapshot>;
  getThread(threadId: string, signal?: AbortSignal): Promise<ThreadDetail>;
  retainThread(threadId: string): number;
  releaseThread(threadId: string, leaseId: number): Promise<void>;
  getDiff(threadId: string, signal?: AbortSignal): Promise<ThreadDiff>;
  getComposerOptions(projectId: string, signal?: AbortSignal): Promise<readonly ComposerOption[]>;
  createThread(input: CreateThreadInput, signal?: AbortSignal): Promise<ThreadDetail>;
  sendTurn(input: SendTurnInput, signal?: AbortSignal): Promise<void>;
  interrupt(threadId: string, requestId: string, signal?: AbortSignal): Promise<void>;
  respondToApproval(
    threadId: string,
    approvalId: string,
    decision: "approve" | "deny",
    requestId: string,
    signal?: AbortSignal,
  ): Promise<void>;
  respondToInput(
    threadId: string,
    inputId: string,
    answers: Readonly<Record<string, string | readonly string[]>>,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<void>;
  uploadAttachment(
    threadId: string,
    file: File,
    onProgress: (progress: UploadProgress) => void,
    signal?: AbortSignal,
  ): Promise<string>;
  cancelAttachment(attachmentId: string, signal?: AbortSignal): Promise<void>;
  getNotificationSettings(signal?: AbortSignal): Promise<NotificationSettings>;
  subscribeToNotifications(
    previewEnabled: boolean,
    signal?: AbortSignal,
  ): Promise<NotificationSettings>;
  setNotificationPreview(enabled: boolean, signal?: AbortSignal): Promise<void>;
  sendTestNotification(signal?: AbortSignal): Promise<void>;
  logout(signal?: AbortSignal): Promise<void>;
}
