// FILE: sidebarHoverCardAnchors.ts
// Purpose: Virtual anchors and display helpers for sidebar thread/project hover cards.
// Layer: Sidebar UI utility
// Exports: createThreadHoverCardAnchor, createProjectHoverCardAnchor,
//          abbreviateHomePath
// Depends on: DOM geometry available in the browser

// Anchors a sidebar hover card flush against the sidebar's right edge at the
// hovered row's vertical position. Rows are inset inside the sidebar, so the
// virtual rect combines the sidebar shell edge with the row's top and height.
function createSidebarEdgeRowAnchor(rowSelector: string) {
  return {
    getBoundingClientRect: () => {
      const rowEl = document.querySelector<HTMLElement>(rowSelector);
      if (!rowEl) {
        return new DOMRect();
      }
      const rowRect = rowEl.getBoundingClientRect();
      const sidebarEl = rowEl.closest<HTMLElement>('[data-slot="sidebar-container"]');
      const rightEdge = sidebarEl?.getBoundingClientRect().right ?? rowRect.right;
      return new DOMRect(rightEdge, rowRect.top, 0, rowRect.height);
    },
  };
}

export function createThreadHoverCardAnchor(anchorId: string) {
  return createSidebarEdgeRowAnchor(`[data-thread-hover-anchor="${anchorId}"]`);
}

export function createProjectHoverCardAnchor(projectId: string) {
  return createSidebarEdgeRowAnchor(`[data-project-hover-anchor="${projectId}"]`);
}

export function abbreviateHomePath(cwd: string, homeDir: string | null): string {
  if (homeDir && (cwd === homeDir || cwd.startsWith(`${homeDir}/`))) {
    return `~${cwd.slice(homeDir.length)}`;
  }
  return cwd;
}
