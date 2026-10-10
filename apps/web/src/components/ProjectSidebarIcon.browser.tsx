// FILE: ProjectSidebarIcon.browser.tsx
// Purpose: Verify project-id favicon assets, loading geometry, and explicit appearance fallback.

import "../index.css";

import { ProjectId } from "@synara/contracts";
import { http, HttpResponse } from "msw";
import { setupWorker } from "msw/browser";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ProjectSidebarIcon } from "./ProjectSidebarIcon";

const favicon =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="8" fill="red"/></svg>';
const presentId = ProjectId.makeUnsafe("favicon-present");
const missingId = ProjectId.makeUnsafe("favicon-missing");
const requestedIds: (string | null)[] = [];
const worker = setupWorker(
  http.get("*/api/project-favicon", ({ request }) => {
    const id = new URL(request.url).searchParams.get("projectId");
    requestedIds.push(id);
    return id === missingId
      ? new HttpResponse(null, { status: 204 })
      : HttpResponse.text(favicon, {
          headers: { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" },
        });
  }),
);

vi.mock("~/lib/wsHttpUrl", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/wsHttpUrl")>()),
  resolveWsHttpUrl: (path: string) => new URL(path, location.origin).href,
}));

beforeAll(async () => {
  await worker.start({ quiet: true, onUnhandledRequest: "bypass" });
});

afterAll(() => worker.stop());

afterEach(() => {
  worker.resetHandlers();
  requestedIds.length = 0;
  document.body.innerHTML = "";
});

function iconElements() {
  return {
    image: document.querySelector<HTMLImageElement>('[data-testid="project-icon"] img'),
    folder: document.querySelector<HTMLElement>(
      '[data-testid="project-icon"] :is([data-slot="hugeicon"], [data-slot="central-icon"])',
    ),
  };
}

it("requests only the project id and shows its loaded favicon in a reserved 16px box", async () => {
  await render(
    <span data-testid="project-icon">
      <ProjectSidebarIcon projectId={presentId} expanded={false} presentation="favicon" />
    </span>,
  );

  await vi.waitFor(() => {
    const { image, folder } = iconElements();
    expect(image?.naturalWidth).toBeGreaterThan(0);
    expect(getComputedStyle(image!).opacity).toBe("1");
    expect(folder === null || getComputedStyle(folder).visibility === "hidden").toBe(true);
  });
  const image = iconElements().image!;
  const url = new URL(image.src);
  expect(url.pathname).toBe("/api/project-favicon");
  expect([...url.searchParams.keys()]).toEqual(["projectId"]);
  expect(url.searchParams.get("projectId")).toBe(presentId);
  expect(requestedIds).toEqual([presentId]);
  expect(image.getAttribute("alt")).toBe("");
  expect(image.getAttribute("aria-hidden")).toBe("true");
  expect(getComputedStyle(image).objectFit).toBe("contain");
  expect(parseFloat(getComputedStyle(image).borderRadius)).toBeGreaterThan(0);
  expect(image.getBoundingClientRect().width).toBe(16);
  expect(image.getBoundingClientRect().height).toBe(16);
});

it("shows the generic folder without moving the label while the image loads", async () => {
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  worker.use(
    http.get("*/api/project-favicon", async () => {
      await pending;
      return HttpResponse.text(favicon, { headers: { "Content-Type": "image/svg+xml" } });
    }),
  );
  const mounted = await render(
    <span className="inline-flex items-center gap-2">
      <span data-testid="project-icon">
        <ProjectSidebarIcon
          projectId={ProjectId.makeUnsafe("favicon-pending")}
          expanded={false}
          presentation="favicon"
        />
      </span>
      <span data-testid="project-label">Vite project</span>
    </span>,
  );
  const label = document.querySelector<HTMLElement>('[data-testid="project-label"]')!;
  const initialLeft = label.getBoundingClientRect().left;
  try {
    expect(iconElements().folder).not.toBeNull();
    expect(getComputedStyle(iconElements().folder!).visibility).toBe("visible");
    expect(
      iconElements().image === null || getComputedStyle(iconElements().image!).opacity === "0",
    ).toBe(true);
    release!();
    await vi.waitFor(() => expect(getComputedStyle(iconElements().image!).opacity).toBe("1"));
    expect(label.getBoundingClientRect().left).toBe(initialLeft);
  } finally {
    release!();
    await mounted.unmount();
  }
});

it("keeps the folder when the server has no icon or the image cannot be decoded", async () => {
  for (const invalidBytes of [false, true]) {
    if (invalidBytes) {
      worker.use(
        http.get("*/api/project-favicon", () =>
          HttpResponse.text("broken image", { headers: { "Content-Type": "image/png" } }),
        ),
      );
    }
    const mounted = await render(
      <span data-testid="project-icon">
        <ProjectSidebarIcon projectId={missingId} expanded={false} presentation="favicon" />
      </span>,
    );
    await vi.waitFor(() => {
      const { image, folder } = iconElements();
      expect(image).toBeNull();
      expect(folder).not.toBeNull();
      expect(getComputedStyle(folder!).visibility).toBe("visible");
    });
    await mounted.unmount();
  }
});

it("returns to the generic folder when the project changes", async () => {
  const mounted = await render(
    <span data-testid="project-icon">
      <ProjectSidebarIcon projectId={presentId} expanded={false} presentation="favicon" />
    </span>,
  );
  await vi.waitFor(() => expect(getComputedStyle(iconElements().image!).opacity).toBe("1"));
  await mounted.rerender(
    <span data-testid="project-icon">
      <ProjectSidebarIcon projectId={missingId} expanded={false} presentation="favicon" />
    </span>,
  );
  expect(getComputedStyle(iconElements().folder!).visibility).toBe("visible");
  expect(
    iconElements().image === null || getComputedStyle(iconElements().image!).opacity === "0",
  ).toBe(true);
  // Settle the second image's request before clearing the shared MSW fixture.
  await vi.waitFor(() => expect(iconElements().image).toBeNull());
  await mounted.unmount();
});

it("uses the generic folder for a preview without a saved project id", async () => {
  await render(
    <span data-testid="project-icon">
      <ProjectSidebarIcon expanded={false} presentation="favicon" />
    </span>,
  );

  expect(iconElements().image).toBeNull();
  expect(iconElements().folder).not.toBeNull();
  expect(requestedIds).toEqual([]);
});

it("preserves the folder and favicon badge in non-primary presentations", async () => {
  await render(
    <span className="relative inline-flex size-4" data-testid="project-icon">
      <ProjectSidebarIcon projectId={presentId} expanded />
    </span>,
  );
  await vi.waitFor(() => expect(getComputedStyle(iconElements().image!).opacity).toBe("1"));
  expect(getComputedStyle(iconElements().folder!).visibility).toBe("visible");
  expect(iconElements().image!.getBoundingClientRect().width).toBe(12);
});

it.each([
  { kind: "emoji", emoji: "🚀" },
  { kind: "icon", icon: "rocket", color: "blue" },
  { kind: "icon", icon: "folder-2", color: "red" },
] as const)("preserves a chosen $kind appearance ahead of favicons", async (appearance) => {
  for (const presentation of ["favicon", "badge"] as const) {
    const mounted = await render(
      <span data-testid="project-icon">
        <ProjectSidebarIcon
          projectId={presentId}
          expanded={false}
          presentation={presentation}
          appearance={appearance}
        />
      </span>,
    );
    expect(iconElements().image).toBeNull();
    expect(requestedIds).toEqual([]);
    if (appearance.kind === "emoji") {
      expect(document.querySelector('[data-testid="project-icon"]')?.textContent).toContain("🚀");
    } else {
      expect(iconElements().folder).not.toBeNull();
      expect(iconElements().folder!.style.color).toBe(`var(--project-${appearance.color})`);
    }
    await mounted.unmount();
  }
});
