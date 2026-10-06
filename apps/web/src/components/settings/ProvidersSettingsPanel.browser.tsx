import "../../index.css";

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
import { StrictMode } from "react";

const harness = vi.hoisted(() => ({
  statuses: [] as ServerProviderStatus[],
  usage: [] as ServerProviderUsageSnapshot[],
  reconciled: true,
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
  serverSettingsQueryOptions: () => ({}),
  hasReconciledServerProviderStatuses: () => harness.reconciled,
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

vi.mock("~/nativeApi", () => ({
  readNativeApi: () => harness.api,
  ensureNativeApi: () => harness.api,
}));

import { AppSettingsSchema } from "~/appSettings";
import { ProvidersSettingsPanel } from "./ProvidersSettingsPanel";
import TerminalViewport from "../terminal/TerminalViewport";
import { terminalRuntimeRegistry } from "../terminal/terminalRuntimeRegistry";

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
  harness.usage = [];
  harness.reconciled = true;
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

it("keeps the default account name when restoring its account defaults", async () => {
  const { props: panelProps, updateSettings } = accountProps({
    providerInstances: {
      codex: { driver: "codex", displayName: "Personal", accentColor: "#16a34a", enabled: false },
    },
  });
  await render(<ProvidersSettingsPanel {...panelProps} />);
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
  await render(<ProvidersSettingsPanel {...panelProps} providerTarget="claudeAgent" />);
  const editor = page.getByRole("group", { name: "Claude account", exact: true });
  await expect.element(editor.getByText("Usage needs attention", { exact: true })).toBeVisible();
  await expect
    .element(editor.getByText("Claude usage credentials were rejected. Sign in again."))
    .toBeVisible();
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

it("edits the selected account beside the list and offers one-click sign-in", async () => {
  harness.statuses = [...harness.statuses, WORK_STATUS];
  const { props: panelProps, updateSettings } = accountProps();
  await render(<ProvidersSettingsPanel {...panelProps} />);

  await page.getByRole("button", { name: "Select Work", exact: true }).click();
  const editor = page.getByRole("group", { name: "Work account", exact: true });
  await expect.element(editor.getByText("Not authenticated", { exact: true })).toBeVisible();
  await expect.element(editor.getByText(/Use Sign in to authenticate/u)).toBeVisible();
  await expect
    .element(editor.getByRole("button", { name: "Sign in to Work", exact: true }))
    .toBeVisible();
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
  await render(<ProvidersSettingsPanel {...panelProps} providerTarget="claudeAgent" />);

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
      <ProvidersSettingsPanel {...accountProps().props} updateSettingsAndWait={save} />
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
    providerTarget: "pi" as const,
    settings: {
      ...defaults,
      providerInstances: { [instanceId]: { driver: "pi", displayName: "Pi work", config: {} } },
    },
  };
  await render(<ProvidersSettingsPanel {...panelProps} />);
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
  await render(<ProvidersSettingsPanel {...accountProps().props} />);
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
