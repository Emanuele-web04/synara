// FILE: ProjectSidebarIcon.browser.tsx
// Purpose: Verify project favicon replacement and the icon fallback in the sidebar.

import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { DEFAULT_PROJECT_ICON, type ProjectAppearance } from "~/lib/projectAppearance";

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
  expect(document.querySelector('[data-testid="project-icon"] [data-slot="hugeicon"]')).toBeNull();
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
      document.querySelector('[data-testid="project-icon"] [data-slot="hugeicon"]'),
    ).not.toBeNull();
  });
});

it.each([
  { kind: "emoji", emoji: "🚀" },
  { kind: "icon", icon: "console", color: "blue" },
  { kind: "icon", icon: DEFAULT_PROJECT_ICON, color: "green" },
] satisfies ProjectAppearance[])(
  "preserves the chosen project appearance: %j",
  async (appearance) => {
    await render(
      <span data-testid="project-icon">
        <ProjectSidebarIcon
          cwd="/present"
          expanded={false}
          presentation="favicon"
          appearance={appearance}
        />
      </span>,
    );

    const root = document.querySelector('[data-testid="project-icon"]');
    expect(root?.querySelector("img")).toBeNull();
    if (appearance.kind === "emoji") {
      expect(root?.textContent).toBe(appearance.emoji);
    } else {
      const glyph = root?.querySelector<HTMLElement>("[data-slot]");
      expect(glyph?.style.color).toBe(`var(--project-${appearance.color})`);
      expect(glyph?.getAttribute("data-slot")).toBe(
        appearance.icon === DEFAULT_PROJECT_ICON ? "hugeicon" : "central-icon",
      );
    }
  },
);

it("falls back to the folder if the displayed favicon fails to load", async () => {
  await render(
    <span data-testid="project-icon">
      <ProjectSidebarIcon cwd="/present" expanded presentation="favicon" />
    </span>,
  );

  await vi.waitFor(() => {
    expect(document.querySelector('[data-testid="project-icon"] img')).not.toBeNull();
  });
  document.querySelector('[data-testid="project-icon"] img')?.dispatchEvent(new Event("error"));

  await vi.waitFor(() => {
    expect(document.querySelector('[data-testid="project-icon"] img')).toBeNull();
    expect(
      document.querySelector('[data-testid="project-icon"] [data-slot="hugeicon"]'),
    ).not.toBeNull();
  });
});

it("does not retain another project's favicon when the folder changes", async () => {
  const mounted = await render(
    <span data-testid="project-icon">
      <ProjectSidebarIcon cwd="/present" expanded={false} presentation="favicon" />
    </span>,
  );

  await vi.waitFor(() => {
    expect(document.querySelector('[data-testid="project-icon"] img')).not.toBeNull();
  });
  await mounted.rerender(
    <span data-testid="project-icon">
      <ProjectSidebarIcon cwd="/missing" expanded={false} presentation="favicon" />
    </span>,
  );

  expect(document.querySelector('[data-testid="project-icon"] img')).toBeNull();
  expect(
    document.querySelector('[data-testid="project-icon"] [data-slot="hugeicon"]'),
  ).not.toBeNull();
});
