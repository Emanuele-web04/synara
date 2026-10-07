import type {
  DesktopCustomTitleBarState,
  ExecutionEnvironmentDescriptor,
  FilesystemBrowseInput,
  FilesystemBrowseResult,
  ProjectId,
  ResolvedKeybindingsConfig,
  ThreadId,
} from "@synara/contracts";
import type { ShortcutMatchContext } from "../../keybindings";
import type { WorkspaceSession } from "./workspaceSessions";
import type { ActiveHost } from "./activeHost";
import type { ThreadStatusPill } from "../../components/Sidebar.logic";
import type { Project, SidebarThreadSummary } from "../../types";
import type { SidebarContextProps } from "../../components/ui/sidebar";
import type { WsTransportState } from "../../wsTransportEvents";

/** Metadata and bounded owner actions cross this boundary; RPC clients and stores stay with their host. */
export interface WorkspaceSummary {
  readonly projects: readonly (Pick<
    Project,
    "id" | "kind" | "name" | "cwd" | "appearance" | "createdAt" | "updatedAt" | "isPinned"
  > & { readonly section: "projects" | "chats" | "studio" })[];
  readonly threads: readonly (SidebarThreadSummary & {
    readonly status: ThreadStatusPill | null;
    readonly terminalEntryPoint?: boolean;
  })[];
  readonly path: string;
  readonly activeProjectId?: string;
  readonly state: WsTransportState;
}

export interface WorkspaceNavigation {
  readonly sidebar?: WorkspaceSidebarActions;
  navigate(path: string): void;
  newChat(projectId?: string): Promise<string>;
  createChat(command: WorkspaceChatCreationCommand): Promise<void>;
  openTerminal(): void;
  browseFolders(input: FilesystemBrowseInput): Promise<FilesystemBrowseResult>;
  createProject(input: {
    name: string;
    workspaceRoot: string;
    createIfMissing: boolean;
  }): Promise<string>;
  openProject(projectId: string): Promise<string>;
  recover(): void | (() => void);
}

export type WorkspaceChatCreationCommand =
  | "chat.new"
  | "chat.newLatestProject"
  | "chat.newChat"
  | "chat.newLocal"
  | "chat.newTerminal"
  | "chat.newClaude"
  | "chat.newCodex"
  | "chat.newCursor";

/** Sidebar operations execute through the existing controller in the owning frame. */
export interface WorkspaceSidebarActions {
  renameThread(threadId: ThreadId, title: string): Promise<void>;
  setThreadPinned(threadId: ThreadId, isPinned: boolean): Promise<void>;
  archiveThread(threadId: ThreadId, isAvailable?: () => boolean): Promise<void>;
  renameProject(projectId: ProjectId, name: string): Promise<void> | void;
  setProjectPinned(projectId: ProjectId, isPinned: boolean): Promise<void>;
}

/** The controlling sidebar resolves the chord with the focused frame's terminal scope. */
export interface WorkspaceSidebarKeyboardEvent extends KeyboardEvent {
  readonly workspaceShortcutContext?: ShortcutMatchContext;
}

export interface WorkspaceFrameBinding {
  readonly host: ActiveHost;
  readonly controller: {
    readonly desktop?: boolean;
    readonly presentation?: {
      readZoomFactor(): number;
      subscribeZoomFactor(listener: (zoomFactor: number) => void): () => void;
      readCustomTitleBarState(): Promise<DesktopCustomTitleBarState> | undefined;
    };
    readonly keybindings?: {
      read(): ResolvedKeybindingsConfig | undefined;
      subscribe(listener: () => void): () => void;
    };
    readonly environment: ExecutionEnvironmentDescriptor;
    readonly sidebar: {
      read(): SidebarContextProps;
      subscribe(listener: () => void): () => void;
    };
    sessions(): readonly WorkspaceSession[];
    subscribe(listener: () => void): () => void;
    newChat(): Promise<string>;
    createProject(): void;
    navigate(path: string): void;
    sidebarKeydown(
      event: KeyboardEvent,
      context: ShortcutMatchContext,
      modelPickerActive: boolean,
    ): boolean;
    sidebarKeyup(event: KeyboardEvent, context: ShortcutMatchContext): void;
  };
  /** Captured in memory, never placed in the frame URL, DOM attributes, or persistence. */
  readonly controllerWsUrl: string;
  publish(summary: WorkspaceSummary): void;
  ready(navigation: WorkspaceNavigation | null): void;
  fail(message: string): void;
  close(): void;
}

export interface WorkspaceFrameElement extends HTMLIFrameElement {
  synaraWorkspace?: WorkspaceFrameBinding;
}

/** A frame is an execution instance, not a selectable global execution pointer. */
export function readWorkspaceFrame(): WorkspaceFrameBinding | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return (window.frameElement as WorkspaceFrameElement | null)?.synaraWorkspace;
  } catch {
    return undefined;
  }
}

export function isWorkspacePath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//") && !path.includes("\\");
}

export function workspaceRoute(environmentId: string, path = "/"): string {
  if (!isWorkspacePath(path)) throw new Error("Invalid workspace route");
  return `/remote?${new URLSearchParams({ environment: environmentId, path })}`;
}

export const OPEN_CREATE_PROJECT_EVENT = "synara:open-create-project";
export function requestCreateProjectDialog(): void {
  const frame = readWorkspaceFrame();
  if (frame) frame.controller.createProject();
  else window.dispatchEvent(new Event(OPEN_CREATE_PROJECT_EVENT));
}
