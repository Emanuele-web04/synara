import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SidebarHeaderTrigger, SidebarProvider } from "./sidebar";

function renderWithQueryClient(node: ReactNode) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>,
  );
}

describe("sidebar header trigger", () => {
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
