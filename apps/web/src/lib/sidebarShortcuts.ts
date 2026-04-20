// FILE: sidebarShortcuts.ts
// Purpose: Centralize app-wide sidebar shortcut events so global handlers can trigger sidebar UI flows.
// Layer: Web UI helper
// Exports: requestSidebarAddProject, onSidebarAddProjectRequest

const SIDEBAR_ADD_PROJECT_REQUEST_EVENT = "t3code:sidebar-add-project-request";

// Broadcasts the add-project shortcut to whichever sidebar instance owns the actual flow.
export function requestSidebarAddProject(): void {
  window.dispatchEvent(new Event(SIDEBAR_ADD_PROJECT_REQUEST_EVENT));
}

// Subscribes the sidebar to the global add-project shortcut bridge.
export function onSidebarAddProjectRequest(callback: () => void): () => void {
  const listener = () => {
    callback();
  };

  window.addEventListener(SIDEBAR_ADD_PROJECT_REQUEST_EVENT, listener);
  return () => {
    window.removeEventListener(SIDEBAR_ADD_PROJECT_REQUEST_EVENT, listener);
  };
}
