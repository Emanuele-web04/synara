import {
  readWorkspaceFrame,
  type WorkspaceChatCreationCommand,
  type WorkspaceNavigation,
} from "./workspaceFrame";
import { readAvailableWorkspaceNavigation, readWorkspaceSessions } from "./workspaceSessions";

type ChatCreationHandler = (
  command: WorkspaceChatCreationCommand,
  isAvailable?: () => boolean,
) => Promise<void>;
let createChat: ChatCreationHandler | undefined;
let openTerminal: (() => void) | undefined;

/** Handlers remain in the execution window with its router, drafts, and focused pane. */
export function registerWorkspaceChatCreation(handler: ChatCreationHandler): () => void {
  createChat = handler;
  return () => {
    if (createChat === handler) createChat = undefined;
  };
}

export function createWorkspaceChat(
  command: WorkspaceChatCreationCommand,
  isAvailable?: () => boolean,
): Promise<void> {
  if (!createChat) return Promise.reject(new Error("This computer is not ready to create a chat."));
  return createChat(command, isAvailable);
}

export function registerWorkspaceTerminalCreation(handler: () => void): () => void {
  openTerminal = handler;
  return () => {
    if (openTerminal === handler) openTerminal = undefined;
  };
}

export function openWorkspaceTerminal(): void {
  if (!openTerminal) throw new Error("Open a chat before creating a terminal.");
  openTerminal();
}

export function isWorkspaceChatCreationCommand(
  command: string,
): command is WorkspaceChatCreationCommand {
  return (
    command === "chat.new" ||
    command === "chat.newLatestProject" ||
    command === "chat.newChat" ||
    command === "chat.newLocal" ||
    command === "chat.newTerminal" ||
    command === "chat.newClaude" ||
    command === "chat.newCodex" ||
    command === "chat.newCursor"
  );
}

function selectedWorkspaceNavigation(href: string): WorkspaceNavigation | undefined {
  if (readWorkspaceFrame()) return undefined;
  const [pathname, search = ""] = href.split("?");
  if (pathname !== "/remote") return undefined;
  const environmentId = new URLSearchParams(search).get("environment");
  const session = readWorkspaceSessions().find(
    (entry) => entry.host.executionScope.environmentId === environmentId,
  );
  const navigation = session && readAvailableWorkspaceNavigation(session);
  if (!navigation) throw new Error("Reconnect this computer before making changes.");
  return navigation;
}

/** A selected remote route never falls back to creation in the controller's stores. */
export async function dispatchSelectedWorkspaceChatCreation(
  command: WorkspaceChatCreationCommand,
  href: string,
): Promise<boolean> {
  const navigation = selectedWorkspaceNavigation(href);
  if (!navigation) return false;
  await navigation.createChat(command);
  return true;
}

export function dispatchSelectedWorkspaceTerminalCreation(href: string): boolean {
  const navigation = selectedWorkspaceNavigation(href);
  if (!navigation) return false;
  navigation.openTerminal();
  return true;
}
