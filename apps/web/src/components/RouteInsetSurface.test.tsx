// FILE: RouteInsetSurface.test.tsx
// Purpose: Guards chat-style route card shells against sidebar peer/layout regressions.
// Layer: Component rendering tests
// Depends on: RouteInsetSurface and Sidebar layout primitives.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RouteInsetSurface } from "./RouteInsetSurface";
import { Sidebar, SidebarProvider } from "./ui/sidebar";

const DEFAULT_ROUTE_SURFACES = ["workspace", "kanban", "automation"] as const;
const SIDEBAR_STATES = [
  { label: "expanded", open: true },
  { label: "collapsed", open: false },
] as const;

function getOpeningTag(html: string, marker: string): string {
  const markerIndex = html.indexOf(marker);
  expect(markerIndex).toBeGreaterThanOrEqual(0);
  const tagStart = html.lastIndexOf("<", markerIndex);
  const tagEnd = html.indexOf(">", markerIndex);
  return html.slice(tagStart, tagEnd + 1);
}

function renderRouteSurface(route: string, open: boolean): string {
  return renderToStaticMarkup(
    <SidebarProvider open={open}>
      <Sidebar>
        <div>{route} sidebar</div>
      </Sidebar>
      <RouteInsetSurface data-route-surface={route}>
        <div>{route} content</div>
      </RouteInsetSurface>
    </SidebarProvider>,
  );
}

describe("RouteInsetSurface", () => {
  it.each(
    DEFAULT_ROUTE_SURFACES.flatMap((route) =>
      SIDEBAR_STATES.map((state) => ({
        route,
        ...state,
      })),
    ),
  )("keeps the $route route shell as the sidebar peer when $label", ({ route, open, label }) => {
    const html = renderRouteSurface(route, open);
    const mainTag = getOpeningTag(html, `data-route-surface="${route}"`);
    const surfaceTag = getOpeningTag(html, 'data-slot="sidebar-inset-surface"');

    expect(html).toContain(`data-state="${label}"`);
    expect(html).toMatch(
      new RegExp(`data-slot="sidebar"[\\s\\S]*</div><main[^>]*data-route-surface="${route}"`),
    );
    expect(mainTag).toContain('data-slot="sidebar-inset"');
    expect(mainTag).toContain("peer-data-[variant=sidebar]");
    expect(mainTag).toContain("h-dvh");
    expect(mainTag).not.toContain("overflow-hidden");
    expect(surfaceTag).toContain("chat-content-card");
    expect(surfaceTag).toContain("overflow-hidden");
  });

  it("keeps explicit-surface callers on the clipped inset path", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider open>
        <Sidebar>
          <div>chat sidebar</div>
        </Sidebar>
        <RouteInsetSurface surfaceClassName="custom-route-surface" data-route-surface="chat">
          <div>chat content</div>
        </RouteInsetSurface>
      </SidebarProvider>,
    );
    const mainTag = getOpeningTag(html, 'data-route-surface="chat"');
    const surfaceTag = getOpeningTag(html, 'data-slot="sidebar-inset-surface"');

    expect(mainTag).toContain("overflow-hidden");
    expect(surfaceTag).toContain("custom-route-surface");
    expect(surfaceTag).not.toContain("chat-content-card");
  });
});
