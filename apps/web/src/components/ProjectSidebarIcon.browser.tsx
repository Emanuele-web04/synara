// FILE: ProjectSidebarIcon.browser.tsx
// Purpose: Verify project favicon replacement and the icon fallback in the sidebar.

import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ProjectSidebarIcon } from "./ProjectSidebarIcon";

const favicon = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="8" fill="red"/></svg>',
)}`;

vi.mock("~/lib/wsHttpUrl", () => ({
  resolveWsHttpUrl: (path: string) =>
    path.includes("missing") ? "data:image/png;base64,AAAA" : favicon,
}));

afterEach(() => {
  document.body.innerHTML = "";
});

it("uses a project's favicon as the sidebar glyph when one is available", async () => {
  await render(
    <span data-testid="project-icon">
      <ProjectSidebarIcon cwd="/present" expanded={false} presentation="favicon" />
    </span>,
  );

  await vi.waitFor(() => {
    const icon = document.querySelector('[data-testid="project-icon"] img');
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute("alt")).toBe("");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
  });
  expect(
    document.querySelector('[data-testid="project-icon"] [data-slot="central-icon"]'),
  ).toBeNull();
});

it("keeps the folder glyph when a project has no usable favicon", async () => {
  await render(
    <span data-testid="project-icon">
      <ProjectSidebarIcon cwd="/missing" expanded={false} presentation="favicon" />
    </span>,
  );

  await vi.waitFor(() => {
    expect(document.querySelector('[data-testid="project-icon"] img')).toBeNull();
    expect(
      document.querySelector('[data-testid="project-icon"] [data-slot="central-icon"]'),
    ).not.toBeNull();
  });
});
