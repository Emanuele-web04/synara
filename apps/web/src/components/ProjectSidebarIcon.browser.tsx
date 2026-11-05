// FILE: ProjectSidebarIcon.browser.tsx
// Purpose: Verify project favicon replacement, the icon fallback, and the open-state chevron.

import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { DEFAULT_PROJECT_ICON, type ProjectAppearance } from "~/lib/projectAppearance";

import { ProjectDisclosureChevron, ProjectSidebarIcon } from "./ProjectSidebarIcon";

const favicon = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="8" fill="red"/></svg>',
)}`;

vi.mock("~/lib/wsHttpUrl", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/wsHttpUrl")>()),
  resolveExecutionResource: ({ cwd }: { cwd: string }) =>
    cwd.includes("missing") ? "data:image/png;base64,AAAA" : favicon,
}));

afterEach(() => {
  document.body.innerHTML = "";
});

it("uses a project's favicon as the sidebar glyph when one is available", async () => {
  await render(
    <span data-testid="project-icon">
      <ProjectSidebarIcon cwd="/present" expanded={false} />
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
      <ProjectSidebarIcon cwd="/missing" expanded={false} />
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
        <ProjectSidebarIcon cwd="/present" expanded={false} appearance={appearance} />
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
      <ProjectSidebarIcon cwd="/present" expanded />
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
      <ProjectSidebarIcon cwd="/present" expanded={false} />
    </span>,
  );

  await vi.waitFor(() => {
    expect(document.querySelector('[data-testid="project-icon"] img')).not.toBeNull();
  });
  await mounted.rerender(
    <span data-testid="project-icon">
      <ProjectSidebarIcon cwd="/missing" expanded={false} />
    </span>,
  );

  expect(document.querySelector('[data-testid="project-icon"] img')).toBeNull();
  expect(
    document.querySelector('[data-testid="project-icon"] [data-slot="hugeicon"]'),
  ).not.toBeNull();
});

it("switches every glyph of a project together when its logo fails to display", async () => {
  await render(
    <>
      <span data-testid="row">
        <ProjectSidebarIcon cwd="/present" expanded={false} />
      </span>
      <span data-testid="rail">
        <ProjectSidebarIcon cwd="/present" expanded={false} />
      </span>
    </>,
  );

  await vi.waitFor(() => {
    expect(document.querySelectorAll("img")).toHaveLength(2);
  });
  document.querySelector('[data-testid="row"] img')?.dispatchEvent(new Event("error"));

  await vi.waitFor(() => {
    expect(document.querySelector('[data-testid="rail"] img')).toBeNull();
  });
});

it.each([
  { glyph: "an emoji", appearance: { kind: "emoji", emoji: "🚀" } },
  { glyph: "an icon", appearance: { kind: "icon", icon: "console", color: null } },
] satisfies Array<{ glyph: string; appearance: ProjectAppearance }>)(
  "shows the open-state chevron for $glyph",
  async ({ appearance }) => {
    await render(
      <span data-testid="label">
        <ProjectDisclosureChevron cwd="/missing" expanded appearance={appearance} />
      </span>,
    );
    expect(document.querySelector('[data-testid="label"] svg')).not.toBeNull();
  },
);

it("shows the open-state chevron for a logo but not for a folder", async () => {
  await render(
    <>
      <span data-testid="logo">
        <ProjectDisclosureChevron cwd="/present" expanded={false} />
      </span>
      <span data-testid="colored-folder">
        <ProjectDisclosureChevron
          cwd="/present"
          expanded={false}
          appearance={{ kind: "icon", icon: DEFAULT_PROJECT_ICON, color: "green" }}
        />
      </span>
      <span data-testid="folder">
        <ProjectDisclosureChevron cwd="/missing" expanded={false} />
      </span>
    </>,
  );

  await vi.waitFor(() => {
    expect(document.querySelector('[data-testid="logo"] svg')).not.toBeNull();
  });
  // The broken logo has settled once a probe of the same image has failed.
  await new Promise((resolve) => {
    const image = new Image();
    image.addEventListener("error", resolve);
    image.src = "data:image/png;base64,AAAA";
  });
  expect(document.querySelector('[data-testid="colored-folder"] svg')).toBeNull();
  expect(document.querySelector('[data-testid="folder"] svg')).toBeNull();
});
