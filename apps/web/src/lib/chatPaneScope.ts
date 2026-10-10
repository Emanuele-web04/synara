export const SINGLE_CHAT_PANE_SCOPE_ID = "single";

export const EDITOR_CHAT_PANE_SCOPE_ID = "editor-chat";

export function dockSidechatPaneScopeId(paneId: string): string {
  return `dock-sidechat:${paneId}`;
}

export function splitViewPaneScopeId(splitViewId: string, paneId: string): string {
  return `${splitViewId}:${paneId}`;
}
