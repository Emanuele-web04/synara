import "../../index.css";

import type { ServerProviderStatus } from "@synara/contracts";
import { PROVIDER_DESCRIPTORS } from "@synara/shared/providerMetadata";
import { page, userEvent } from "vitest/browser";
import { beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  statuses: [] as ServerProviderStatus[],
  reconciled: true,
  refresh: vi.fn(),
}));

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => ({}),
  useQuery: () => ({ data: { providers: harness.statuses }, isPending: false }),
}));
vi.mock("~/lib/serverReactQuery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/serverReactQuery")>()),
  serverConfigQueryOptions: () => ({}),
  serverSettingsQueryOptions: () => ({}),
  hasReconciledServerProviderStatuses: () => harness.reconciled,
  serverQueryKeys: { config: () => ["config"] },
}));
vi.mock("~/hooks/useProviderStatusesForLocalConfig", () => ({
  useProviderStatusesForLocalConfig: () => harness.statuses,
}));
vi.mock("~/hooks/useProviderStatusRefresh", () => ({
  useRefreshProviderStatusesNow: () => harness.refresh,
}));

import { AppSettingsSchema } from "~/appSettings";
import { ProvidersSettingsPanel } from "./ProvidersSettingsPanel";

const defaults = AppSettingsSchema.makeUnsafe({});
const props = {
  defaults,
  settings: { ...defaults, disabledProviders: ["grok" as const] },
  updateSettings: vi.fn(),
  updateSettingsAndWait: vi.fn(async () => {}),
  active: true,
  resetEpoch: 0,
};

beforeEach(() => {
  harness.reconciled = true;
  harness.refresh.mockReset();
  harness.statuses = PROVIDER_DESCRIPTORS.map(({ kind }) => ({
    provider: kind,
    instanceId: kind,
    driver: kind,
    status: kind === "opencode" ? "error" : "ready",
    available: kind !== "opencode",
    authStatus: kind === "claudeAgent" ? "unauthenticated" : "authenticated",
    checkedAt: "2026-09-16T21:46:18.000Z",
    ...(kind === "opencode"
      ? { message: "OpenCode CLI (`opencode`) is not installed or not on PATH." }
      : {}),
  }));
});

function activityRow(provider: string) {
  return page
    .getByRole("switch", { name: `Disable ${provider}`, exact: true })
    .element()
    .closest('[data-slot="settings-row"]')!;
}

it("shows installation and auth beside activity switches with visible setup guides", async () => {
  await render(<ProvidersSettingsPanel {...props} />);
  expect(activityRow("OpenCode").textContent).toContain("Unavailable");
  expect(activityRow("OpenCode").textContent).toContain("not installed or not on PATH");
  expect(activityRow("Claude").textContent).toContain("Needs sign-in");
  expect(activityRow("Codex").textContent).toContain("Connected");
  expect(
    page
      .getByRole("switch", { name: "Enable Grok", exact: true })
      .element()
      .closest('[data-slot="settings-row"]')?.textContent,
  ).toContain("Disabled · enable to check setup");
  // Permission to run remains enabled even if the CLI is missing.
  await expect
    .element(page.getByRole("switch", { name: "Disable OpenCode", exact: true }))
    .toBeChecked();
  for (const descriptor of PROVIDER_DESCRIPTORS) {
    const guide = page.getByRole("link", {
      name: `${descriptor.displayName} setup guide`,
      exact: true,
    });
    await expect.element(guide).toBeVisible();
    expect(guide.element().getAttribute("href")).toBe(descriptor.setupDocsHref);
  }
});

it("does not report cached provider health as connected before reconciliation", async () => {
  harness.reconciled = false;
  await render(<ProvidersSettingsPanel {...props} />);
  expect(activityRow("Codex").textContent).toContain("Checking setup");
  expect(activityRow("Codex").textContent).not.toContain("Connected");
});

it("allows rechecking setup after installing externally and blocks duplicate refreshes", async () => {
  let finish!: () => void;
  harness.refresh.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await render(<ProvidersSettingsPanel {...props} />);
  await page.getByRole("button", { name: "Refresh status", exact: true }).click();
  expect(harness.refresh).toHaveBeenCalledOnce();
  await expect
    .element(page.getByRole("button", { name: "Checking setup", exact: true }))
    .toBeDisabled();
  finish();
  await expect
    .element(page.getByRole("button", { name: "Refresh status", exact: true }))
    .toBeEnabled();
});

// --- Accounts: one list per provider, default included, with an editor beside it. ---

const WORK_STATUS: ServerProviderStatus = {
  provider: "codex",
  instanceId: "codex_work",
  driver: "codex",
  displayName: "Work",
  status: "error",
  available: true,
  authStatus: "unauthenticated",
  checkedAt: "2026-09-16T21:46:18.000Z",
  message: "Codex CLI is not authenticated.",
};

function accountProps(settings: Partial<typeof defaults> = {}) {
  const updateSettings = vi.fn();
  return {
    updateSettings,
    props: {
      ...props,
      updateSettings,
      providerTarget: "codex" as const,
      settings: {
        ...defaults,
        providerInstances: {
          codex_work: {
            driver: "codex",
            displayName: "Work",
            accentColor: "#16a34a",
            enabled: true,
            config: {},
          },
          codex_old: { driver: "codex", displayName: "Old", enabled: false, config: {} },
        },
        ...settings,
      },
    },
  };
}

function codexAccountRow(name: string) {
  return page
    .getByRole("button", { name: `Select ${name}`, exact: true })
    .element()
    .closest<HTMLElement>('[role="listitem"]')!;
}

it("lists every account of a provider, default included, with a status title and a switch", async () => {
  harness.statuses = [...harness.statuses, WORK_STATUS];
  await render(<ProvidersSettingsPanel {...accountProps().props} />);

  await expect
    .element(page.getByRole("list", { name: "Codex accounts", exact: true }))
    .toBeVisible();
  expect(codexAccountRow("Codex").textContent).toContain("Authenticated");
  expect(codexAccountRow("Work").textContent).toContain("Not authenticated");
  expect(codexAccountRow("Old").textContent).toContain("Disabled");
  // Names tell the accounts apart; an accent washes the icon of the one that has it.
  expect(codexAccountRow("Work").querySelector<HTMLElement>("[data-accent]")?.dataset.accent).toBe(
    "#16a34a",
  );
  expect(codexAccountRow("Codex").querySelector("[data-accent]")).toBeNull();

  await expect
    .element(page.getByRole("switch", { name: "Enable Codex", exact: true }))
    .toBeChecked();
  await expect
    .element(page.getByRole("switch", { name: "Enable Old", exact: true }))
    .not.toBeChecked();

  // The default account opens first: its runtime paths, and no way to remove it.
  const editor = page.getByRole("group", { name: "Codex account", exact: true });
  await expect.element(editor.getByText("Codex binary path")).toBeVisible();
  expect(editor.getByRole("button", { name: "Remove" }).elements()).toHaveLength(0);
});

it("edits the selected account beside the list and offers its sign-in command", async () => {
  harness.statuses = [...harness.statuses, WORK_STATUS];
  const { props: panelProps, updateSettings } = accountProps();
  await render(<ProvidersSettingsPanel {...panelProps} />);

  await page.getByRole("button", { name: "Select Work", exact: true }).click();
  const editor = page.getByRole("group", { name: "Work account", exact: true });
  await expect.element(editor.getByText("Not authenticated", { exact: true })).toBeVisible();
  await expect.element(editor.getByText(/To sign in, run/u)).toBeVisible();
  await expect.element(editor.getByRole("button", { name: /^Copy .* login$/u })).toBeVisible();
  await expect.element(editor.getByText("Environment variables")).toBeVisible();

  await page.getByRole("switch", { name: "Enable Work", exact: true }).click();
  expect(updateSettings).toHaveBeenLastCalledWith({
    providerInstances: expect.objectContaining({
      codex_work: expect.objectContaining({ enabled: false, displayName: "Work" }),
    }),
  });

  await editor.getByRole("button", { name: "Remove" }).click();
  const removal = updateSettings.mock.lastCall?.[0] as typeof defaults;
  expect(Object.keys(removal.providerInstances)).toEqual(["codex_old"]);
});

it("adds an account from a dialog that derives its id from the label", async () => {
  const { props: panelProps, updateSettings } = accountProps();
  await render(<ProvidersSettingsPanel {...panelProps} />);

  await page.getByRole("button", { name: "Add account", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Add account" });
  await expect.element(dialog).toBeVisible();

  // An id that is already taken is refused when submitting.
  await dialog.getByRole("textbox", { name: "Label" }).fill("Work");
  await expect
    .element(dialog.getByRole("textbox", { name: "Account ID" }))
    .toHaveValue("codex_work");
  await dialog.getByRole("button", { name: "Add account", exact: true }).click();
  await expect
    .element(dialog.getByText("An account with the ID 'codex_work' already exists."))
    .toBeVisible();
  expect(updateSettings).not.toHaveBeenCalled();

  await dialog.getByRole("textbox", { name: "Label" }).fill("Team EU");
  await expect
    .element(dialog.getByRole("textbox", { name: "Account ID" }))
    .toHaveValue("codex_team_eu");
  await dialog.getByRole("button", { name: /^Accent color #7c3aed/u }).click();
  await dialog.getByRole("textbox", { name: "CODEX_HOME path" }).fill("~/.codex-team");
  await dialog.getByRole("button", { name: "Add account", exact: true }).click();

  const added = updateSettings.mock.lastCall?.[0] as typeof defaults;
  expect(added.providerInstances.codex_team_eu).toEqual({
    driver: "codex",
    displayName: "Team EU",
    accentColor: "#7c3aed",
    enabled: true,
    config: { homePath: "~/.codex-team" },
  });
  // Existing accounts are left as they were.
  expect(added.providerInstances.codex_work).toEqual(
    panelProps.settings.providerInstances.codex_work,
  );
});

it("routes a migrated Codex account's rename to its saved account entry", async () => {
  const { props: panelProps, updateSettings } = accountProps({
    providerInstances: {},
    codexAccounts: [{ id: "work", label: "Work", homePath: "", shadowHomePath: "" }],
  });
  await render(<ProvidersSettingsPanel {...panelProps} />);

  await page.getByRole("button", { name: "Select Work", exact: true }).click();
  const editor = page.getByRole("group", { name: "Work account", exact: true });
  const name = editor.getByRole("textbox", { name: "Display name" });
  await name.fill("Office");
  await userEvent.tab();

  expect(updateSettings).toHaveBeenLastCalledWith({
    codexAccounts: [{ id: "work", label: "Office", homePath: "", shadowHomePath: "" }],
  });
  // Its route depends on that entry, so it gets no environment of its own.
  expect(editor.getByText("Environment variables").elements()).toHaveLength(0);
});
