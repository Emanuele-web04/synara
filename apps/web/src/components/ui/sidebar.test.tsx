import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  SidebarHeaderTrigger,
  SidebarInset,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuSubButton,
  SidebarProvider,
} from "./sidebar";

function renderSidebarButton(className?: string) {
  return renderToStaticMarkup(
    <SidebarProvider>
      <SidebarMenuButton className={className}>Projects</SidebarMenuButton>
    </SidebarProvider>,
  );
}

function renderWithQueryClient(node: ReactNode) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>,
  );
}

describe("sidebar interactive cursors", () => {
  it("uses a pointer cursor for menu buttons by default", () => {
    const html = renderSidebarButton();

    expect(html).toContain('data-slot="sidebar-menu-button"');
    expect(html).toContain("cursor-pointer");
  });

  it("lets project drag handles override the default pointer cursor", () => {
    const html = renderSidebarButton("cursor-grab");

    expect(html).toContain("cursor-grab");
    expect(html).not.toContain("cursor-pointer");
  });

  it("uses a pointer cursor for menu actions", () => {
    const html = renderToStaticMarkup(
      <SidebarMenuAction aria-label="Create thread">
        <span>+</span>
      </SidebarMenuAction>,
    );

    expect(html).toContain('data-slot="sidebar-menu-action"');
    expect(html).toContain("cursor-pointer");
  });

  it("uses a pointer cursor for submenu buttons", () => {
    const html = renderToStaticMarkup(
      <SidebarMenuSubButton render={<button type="button" />}>Show more</SidebarMenuSubButton>,
    );

    expect(html).toContain('data-slot="sidebar-menu-sub-button"');
    expect(html).toContain("cursor-pointer");
  });

  it("keeps inset layout classes on the outer shell", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider>
        <SidebarInset className="h-dvh overflow-hidden rounded-l-2xl">Content</SidebarInset>
      </SidebarProvider>,
    );

    expect(html).toContain('data-slot="sidebar-inset"');
    expect(html).toContain("h-dvh");
    expect(html).toContain("overflow-hidden");
    expect(html).toContain("rounded-l-2xl");
    expect(html).toContain('data-slot="sidebar-inset-surface"');
  });

  it("renders the header trigger when the desktop sidebar is collapsed", () => {
    const html = renderWithQueryClient(
      <SidebarProvider open={false}>
        <SidebarHeaderTrigger />
      </SidebarProvider>,
    );

    expect(html).toContain('data-slot="sidebar-trigger"');
    expect(html).toContain("Toggle Sidebar");
  });

  it("omits the header trigger when the desktop sidebar is expanded", () => {
    const html = renderWithQueryClient(
      <SidebarProvider open>
        <SidebarHeaderTrigger />
      </SidebarProvider>,
    );

    expect(html).toContain('data-slot="sidebar-wrapper"');
    expect(html).not.toContain('data-slot="sidebar-trigger"');
    expect(html).not.toContain("Toggle Sidebar");
  });
});
