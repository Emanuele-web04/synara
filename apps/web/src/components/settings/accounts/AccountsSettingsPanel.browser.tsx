import "../../../index.css";

import {
  ThreadId,
  type ServerProviderStatus,
  type ServerProviderUsageSnapshot,
  type TerminalEvent,
  type TerminalOpenInput,
} from "@synara/contracts";
import { PROVIDER_DESCRIPTORS } from "@synara/shared/providerMetadata";
import { page, userEvent } from "vitest/browser";
import { beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { StrictMode, useState } from "react";

const harness = vi.hoisted(() => ({
  statuses: [] as ServerProviderStatus[],
  usage: [] as ServerProviderUsageSnapshot[],
  refresh: vi.fn(),
  invalidate: vi.fn(async () => {}),
  terminalListener: null as ((event: TerminalEvent) => void) | null,
  api: {
    terminal: {
      open: vi.fn(),
      write: vi.fn(async () => {}),
      resize: vi.fn(async () => {}),
      ackOutput: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      onEvent: vi.fn(),
    },
    shell: { openExternal: vi.fn(async () => {}) },
  },
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const queryClient = { invalidateQueries: harness.invalidate };
  return {
    ...(await importOriginal<typeof import("@tanstack/react-query")>()),
    useQueryClient: () => queryClient,
    useQuery: (options: { queryKey?: readonly string[] }) => ({
      data:
        options.queryKey?.[1] === "allProviderUsage"
          ? harness.usage
          : { providers: harness.statuses, cwd: "/tmp" },
      isPending: false,
    }),
  };
});
vi.mock("~/lib/serverReactQuery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/serverReactQuery")>()),
  serverConfigQueryOptions: () => ({}),
  serverQueryKeys: {
    config: () => ["config"],
    settings: () => ["settings"],
    allProviderUsage: () => ["server", "allProviderUsage"],
  },
}));
vi.mock("~/hooks/useProviderStatusesForLocalConfig", () => ({
  useProviderStatusesForLocalConfig: () => harness.statuses,
}));
vi.mock("~/hooks/useProviderStatusRefresh", () => ({
  useRefreshProviderStatusesNow: () => harness.refresh,
}));

// The account detail view shows the Usage page's card; its own data hooks are covered there.
vi.mock("../ProviderUsageSettingsPanel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ProviderUsageSettingsPanel")>()),
  ProviderUsageCard: (props: { accountLabel: string | null }) => (
    <div data-testid="account-usage-card">{props.accountLabel}</div>
  ),
}));

vi.mock("~/nativeApi", () => ({
  readNativeApi: () => harness.api,
  ensureNativeApi: () => harness.api,
  readNativeApiServerCapability: () => false,
  onNativeApiServerCapabilitiesChange: () => () => undefined,
}));

import { AppSettingsSchema, type AppSettings } from "~/appSettings";
import TerminalViewport from "../../terminal/TerminalViewport";
import { terminalRuntimeRegistry } from "../../terminal/terminalRuntimeRegistry";
import { AccountsSettingsPanel } from "./AccountsSettingsPanel";

const defaults = AppSettingsSchema.makeUnsafe({});
const props = {
  defaults,
  settings: defaults,
  updateSettings: vi.fn(),
  updateSettingsAndWait: vi.fn(async () => {}),
};

/** The Accounts page with its list ↔ account navigation held in local state. */
function AccountsHarness(harnessProps: {
  settings: AppSettings;
  defaults: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => void;
  updateSettingsAndWait: (patch: Partial<AppSettings>) => Promise<void>;
  initialAccountId?: string | null;
}) {
  const [accountId, setAccountId] = useState<string | null>(harnessProps.initialAccountId ?? null);
  return (
    <AccountsSettingsPanel
      active
      settings={harnessProps.settings}
      defaults={harnessProps.defaults}
      updateSettings={harnessProps.updateSettings}
      updateSettingsAndWait={harnessProps.updateSettingsAndWait}
      accountId={accountId}
      onOpenAccount={setAccountId}
    />
  );
}

beforeEach(() => {
  harness.usage = [];
  harness.refresh.mockReset();
  harness.api.terminal.open.mockReset().mockImplementation(async (input: TerminalOpenInput) => ({
    ...input,
    status: "running",
    history: "",
    pid: 1234,
    exitCode: null,
    exitSignal: null,
    updatedAt: "2026-10-02T12:00:00Z",
  }));
  harness.api.terminal.write.mockClear();
  harness.api.terminal.close.mockReset().mockResolvedValue(undefined);
  harness.api.terminal.onEvent.mockImplementation((listener: (event: TerminalEvent) => void) => {
    harness.terminalListener = listener;
    return () => {
      harness.terminalListener = null;
    };
  });
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

// --- Accounts page: one card per agent listing every account, default included; an
// account opens its own detail view with the editor. ---

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

it("keeps the default account name when restoring its account defaults", async () => {
  const { props: panelProps, updateSettings } = accountProps({
    providerInstances: {
      codex: { driver: "codex", displayName: "Personal", accentColor: "#16a34a", enabled: false },
    },
  });
  await render(<AccountsHarness {...panelProps} />);
  await page.getByRole("button", { name: "Select Personal", exact: true }).click();
  await page.getByRole("button", { name: /Reset Personal account/ }).click();
  expect(updateSettings).toHaveBeenLastCalledWith({
    providerInstances: {
      codex: { driver: "codex", displayName: "Personal" },
    },
  });
});

it("shows a Claude usage authentication failure beside a locally signed-in account", async () => {
  harness.statuses = harness.statuses.map((status) =>
    status.provider === "claudeAgent" ? { ...status, authStatus: "authenticated" } : status,
  );
  harness.statuses.push({
    ...WORK_STATUS,
    provider: "claudeAgent",
    driver: "claudeAgent",
    instanceId: "claude_work",
    authStatus: "authenticated",
    status: "ready",
  });
  harness.usage = [
    {
      provider: "claudeAgent",
      instanceId: "claudeAgent",
      status: "needs-auth",
      source: "claude-oauth-usage",
      updatedAt: new Date().toISOString(),
      limits: [],
      usageLines: [],
      detail: "Claude usage credentials were rejected. Sign in again.",
    },
  ];
  const { props: panelProps } = accountProps({
    providerInstances: { claude_work: { driver: "claudeAgent", displayName: "Work", config: {} } },
  });
  await render(<AccountsHarness {...panelProps} />);
  // The list already says so beside the account.
  expect(
    page
      .getByRole("button", { name: "Select Claude", exact: true })
      .element()
      .closest('[role="listitem"]')?.textContent,
  ).toContain("Usage needs attention");
  await page.getByRole("button", { name: "Select Claude", exact: true }).click();
  const editor = page.getByRole("group", { name: "Claude account", exact: true });
  await expect.element(editor.getByText("Usage needs attention", { exact: true })).toBeVisible();
  await expect
    .element(editor.getByText("Claude usage credentials were rejected. Sign in again."))
    .toBeVisible();
  await page.getByRole("button", { name: "Accounts", exact: true }).click();
  await page.getByRole("button", { name: "Select Work", exact: true }).click();
  await expect
    .element(
      page
        .getByRole("group", { name: "Work account", exact: true })
        .getByText("Signed in locally", { exact: true }),
    )
    .toBeVisible();
});

it("lists every account of a provider, default included, with a status title and a switch", async () => {
  harness.statuses = [...harness.statuses, WORK_STATUS];
  await render(<AccountsHarness {...accountProps().props} />);

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

  // The default account keeps its own sign-in folder; the binary path and other CLI
  // options are provider-wide and live under Providers. It cannot be removed.
  await page.getByRole("button", { name: "Select Codex", exact: true }).click();
  const editor = page.getByRole("group", { name: "Codex account", exact: true });
  await expect.element(editor.getByText("CODEX_HOME path")).toBeVisible();
  expect(editor.getByText("Codex binary path", { exact: true }).elements()).toHaveLength(0);
  await expect.element(editor.getByText(/other CLI options are under Providers/u)).toBeVisible();
  expect(editor.getByRole("button", { name: "Remove" }).elements()).toHaveLength(0);
});

it("enables accounts from the list and edits one in its own view with one-click sign-in", async () => {
  harness.statuses = [...harness.statuses, WORK_STATUS];
  const { props: panelProps, updateSettings } = accountProps();
  await render(<AccountsHarness {...panelProps} />);

  // Unsigned accounts offer sign-in right in the list.
  await expect
    .element(page.getByRole("button", { name: "Sign in to Work", exact: true }))
    .toBeVisible();
  await page.getByRole("switch", { name: "Enable Work", exact: true }).click();
  expect(updateSettings).toHaveBeenLastCalledWith({
    providerInstances: expect.objectContaining({
      codex_work: expect.objectContaining({ enabled: false, displayName: "Work" }),
    }),
  });

  await page.getByRole("button", { name: "Select Work", exact: true }).click();
  const editor = page.getByRole("group", { name: "Work account", exact: true });
  await expect.element(editor.getByText("Not authenticated", { exact: true })).toBeVisible();
  await expect.element(editor.getByText(/Use Sign in to authenticate/u)).toBeVisible();
  await expect
    .element(editor.getByRole("button", { name: "Sign in to Work", exact: true }))
    .toBeVisible();
  await expect.element(editor.getByText("Environment variables")).toBeVisible();

  await editor.getByRole("button", { name: "Remove" }).click();
  const removal = updateSettings.mock.lastCall?.[0] as typeof defaults;
  expect(Object.keys(removal.providerInstances)).toEqual(["codex_old"]);
  // Removing an account returns to the list.
  await expect
    .element(page.getByRole("list", { name: "Codex accounts", exact: true }))
    .toBeVisible();
});

it("leaves Artifacts to the default Claude account and keeps another account's binary path", async () => {
  harness.statuses = [
    ...harness.statuses,
    { ...WORK_STATUS, provider: "claudeAgent", instanceId: "claude_work", driver: "claudeAgent" },
  ];
  const { props: panelProps } = accountProps({
    claudeEnableArtifacts: true,
    providerInstances: {
      claude_work: {
        driver: "claudeAgent",
        displayName: "Work",
        enabled: true,
        config: { binaryPath: "/opt/claude-2.1/bin/claude" },
      },
    },
  });
  await render(<AccountsHarness {...panelProps} />);

  await page.getByRole("button", { name: "Select Work", exact: true }).click();
  const editor = page.getByRole("group", { name: "Work account", exact: true });
  await editor.getByRole("button", { name: "Advanced" }).click();
  await expect
    .element(editor.getByRole("textbox", { name: "Claude binary path" }))
    .toHaveValue("/opt/claude-2.1/bin/claude");
  // The server reads Artifacts from the Claude provider setting for every account.
  expect(editor.getByRole("switch", { name: /^Artifacts/u }).elements()).toHaveLength(0);
});

it("adds an account from a dialog that derives its id from the label", async () => {
  const { props: panelProps, updateSettings } = accountProps();
  await render(<AccountsHarness {...panelProps} />);

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

it("goes straight on to sign-in after adding an account without its own folder", async () => {
  const { props: panelProps, updateSettings } = accountProps();
  const save = vi.fn(async () => {});
  await render(<AccountsHarness {...panelProps} updateSettingsAndWait={save} />);

  await page.getByRole("button", { name: "Add account", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Add account" });
  await dialog.getByRole("textbox", { name: "Label" }).fill("Team EU");
  await dialog.getByRole("button", { name: "Add account", exact: true }).click();

  const added = updateSettings.mock.lastCall?.[0] as typeof defaults;
  expect(added.providerInstances.codex_team_eu?.displayName).toBe("Team EU");
  // The new account's settings are saved before its sign-in starts.
  await expect.poll(() => save.mock.calls.length).toBeGreaterThan(0);
  await expect.element(page.getByRole("dialog", { name: "Sign in to Team EU" })).toBeVisible();
});

it("routes a migrated Codex account's rename to its saved account entry", async () => {
  const { props: panelProps, updateSettings } = accountProps({
    providerInstances: {},
    codexAccounts: [{ id: "work", label: "Work", homePath: "", shadowHomePath: "" }],
  });
  await render(<AccountsHarness {...panelProps} />);

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

it("survives StrictMode, waits for account edits, and verifies selected-account auth rather than trusting CLI exit", async () => {
  harness.statuses = [...harness.statuses, WORK_STATUS];
  let finishSave!: () => void;
  const save = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finishSave = resolve;
      }),
  );
  await render(
    <StrictMode>
      <AccountsHarness {...accountProps().props} updateSettingsAndWait={save} />
    </StrictMode>,
  );
  await page.getByRole("button", { name: "Select Work", exact: true }).click();
  const signIn = page.getByRole("button", { name: "Sign in to Work", exact: true });
  await signIn.click();
  await expect.element(signIn).toBeDisabled();
  expect(harness.api.terminal.open).not.toHaveBeenCalled();
  finishSave();
  const dialog = page.getByRole("dialog", { name: "Sign in to Work" });
  await expect.element(dialog).toBeVisible();
  await expect.poll(() => harness.api.terminal.open.mock.calls.length).toBeGreaterThan(0);
  const input = harness.api.terminal.open.mock.calls[0]![0] as TerminalOpenInput;
  expect(input.providerAuthInstanceId).toBe("codex_work");
  expect(input.env).toBeUndefined();
  await expect.poll(() => dialog.element().querySelector(".xterm-screen")).not.toBeNull();
  expect(harness.api.terminal.close).not.toHaveBeenCalledWith(
    expect.objectContaining({ threadId: input.threadId }),
  );
  harness.refresh.mockResolvedValue([WORK_STATUS]);
  harness.terminalListener?.({
    type: "exited",
    threadId: input.threadId,
    terminalId: input.terminalId ?? "sign-in",
    exitCode: 0,
    exitSignal: null,
    createdAt: "2026-10-02T12:00:00Z",
  });
  await expect.element(dialog.getByText(/This account is not authenticated yet/u)).toBeVisible();
  harness.refresh.mockResolvedValue([{ ...WORK_STATUS, authStatus: "authenticated" }]);
  await dialog.getByRole("button", { name: "Check authentication" }).click();
  await expect.element(dialog.getByText("Authenticated. You can close this window.")).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect.poll(() => harness.api.terminal.close.mock.calls.length).toBeGreaterThan(0);
  expect(harness.api.terminal.close).toHaveBeenCalledWith({
    threadId: input.threadId,
    terminalId: input.terminalId,
    deleteHistory: true,
  });
});

it("sends Pi's login selector only after startup and keeps cancellation failures visible", async () => {
  const instanceId = "pi_work";
  const panelProps = {
    ...props,
    settings: {
      ...defaults,
      providerInstances: { [instanceId]: { driver: "pi", displayName: "Pi work", config: {} } },
    },
  };
  await render(<AccountsHarness {...panelProps} />);
  await page.getByRole("button", { name: "Select Pi work", exact: true }).click();
  await page.getByRole("button", { name: "Sign in to Pi work", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Sign in to Pi work" });
  const options = dialog.getByRole("button", { name: "Sign-in options" });
  await expect.element(options).toBeEnabled();
  expect(harness.api.terminal.write).not.toHaveBeenCalled();
  await options.click();
  expect(harness.api.terminal.write).toHaveBeenCalledWith(
    expect.objectContaining({ data: "/login\r" }),
  );
  await expect.element(options).toBeDisabled();
  harness.api.terminal.close.mockRejectedValueOnce(new Error("Server disconnected; retry closing"));
  await dialog.getByRole("button", { name: "Cancel / close" }).click();
  await expect.element(dialog.getByText("Server disconnected; retry closing")).toBeVisible();
  expect(harness.api.terminal.write).not.toHaveBeenCalledWith(
    expect.objectContaining({ data: "exit\n" }),
  );
  await dialog.getByRole("button", { name: "Cancel / close" }).click();
  await expect.element(dialog).not.toBeInTheDocument();
});

it("closes a late authentication open after the settings dialog is cancelled", async () => {
  harness.statuses = [...harness.statuses, WORK_STATUS];
  let finishOpen!: (snapshot: unknown) => void;
  harness.api.terminal.open.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishOpen = resolve;
      }),
  );
  await render(<AccountsHarness {...accountProps().props} />);
  await page.getByRole("button", { name: "Select Work", exact: true }).click();
  await page.getByRole("button", { name: "Sign in to Work", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Sign in to Work" });
  await expect.poll(() => harness.api.terminal.open.mock.calls.length).toBeGreaterThan(0);
  const input = harness.api.terminal.open.mock.calls[0]![0] as TerminalOpenInput;
  await dialog.getByRole("button", { name: "Cancel / close" }).click();
  await expect.element(dialog).not.toBeInTheDocument();
  const beforeLate = harness.api.terminal.close.mock.calls.length;
  finishOpen({
    ...input,
    status: "running",
    history: "",
    pid: 1234,
    exitCode: null,
    exitSignal: null,
  });
  await expect.poll(() => harness.api.terminal.close.mock.calls.length).toBeGreaterThan(beforeLate);
});

it.each(["ready", "error", "exited"] as const)(
  "reports a retained %s authentication terminal when its viewport remounts",
  async (status) => {
    const threadId = ThreadId.makeUnsafe(`provider-auth-remount-${status}`);
    const terminalId = "sign-in";
    const onRuntimeStatusChange = vi.fn();
    const viewport = (
      <TerminalViewport
        threadId={threadId}
        terminalId={terminalId}
        terminalLabel="Sign in"
        cwd="/tmp"
        providerAuthInstanceId="pi_work"
        onRuntimeStatusChange={onRuntimeStatusChange}
        onSessionExited={() => {}}
        onTerminalMetadataChange={() => {}}
        onTerminalActivityChange={() => {}}
        focusRequestId={0}
        autoFocus={false}
        isVisible
      />
    );
    try {
      const mounted = await render(viewport);
      await expect.poll(() => onRuntimeStatusChange.mock.calls.at(-1)?.[0]).toBe("ready");
      await mounted.unmount();
      if (status === "error") {
        harness.terminalListener?.({
          type: "error",
          threadId,
          terminalId,
          message: "Authentication failed",
          createdAt: "2026-10-02T12:00:00Z",
        });
      } else if (status === "exited") {
        harness.terminalListener?.({
          type: "exited",
          threadId,
          terminalId,
          exitCode: 0,
          exitSignal: null,
          createdAt: "2026-10-02T12:00:00Z",
        });
      }
      onRuntimeStatusChange.mockClear();
      const reopened = await render(viewport);
      await expect.poll(() => onRuntimeStatusChange.mock.calls.at(-1)?.[0]).toBe(status);
      await reopened.unmount();
    } finally {
      terminalRuntimeRegistry.disposeTerminal(threadId, terminalId);
    }
  },
);

it("summarizes an account's limits in its row and names it on its usage card", async () => {
  harness.statuses = [...harness.statuses, WORK_STATUS];
  harness.usage = [
    {
      provider: "codex",
      instanceId: "codex_work",
      status: "ok",
      source: "test",
      updatedAt: new Date().toISOString(),
      limits: [
        { window: "5h", usedPercent: 42, windowDurationMins: 300 },
        { window: "Weekly", usedPercent: 61, windowDurationMins: 10080 },
      ],
      usageLines: [],
    },
  ];
  await render(<AccountsHarness {...accountProps().props} />);
  expect(codexAccountRow("Work").textContent).toMatch(/58% left · .*39% left/u);
  await page.getByRole("button", { name: "Select Work", exact: true }).click();
  await expect.element(page.getByTestId("account-usage-card")).toHaveTextContent("Work");
});
