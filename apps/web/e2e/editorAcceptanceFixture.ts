import { expect, type Page } from "playwright/test";

/** Open a fresh test page against either a new or previously configured test installation. */
export async function openEditorAcceptanceApp(page: Page): Promise<void> {
  await page.goto("/");
  // Fail at bootstrap rather than sending a command into a disconnected transport.
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const modulePath = "/src/nativeApi.ts";
          const { ensureNativeApi, readNativeApiServerCapability } = await import(
            /* @vite-ignore */ modulePath
          );
          ensureNativeApi();
          return readNativeApiServerCapability("rpc.typed-errors");
        }),
      { timeout: 20_000 },
    )
    .toBe(true);
  const onboarding = () =>
    page.evaluate(async () => {
      const modulePath = "/src/onboarding/onboardingDialogStore.ts";
      const { useOnboardingDialogStore } = await import(/* @vite-ignore */ modulePath);
      const state = useOnboardingDialogStore.getState();
      return { settled: state.startupGateSettled, open: state.isOpen };
    });
  await expect.poll(async () => (await onboarding()).settled).toBe(true);
  // Tests share an isolated installation, but each has a fresh browser context.
  // Read the real gate rather than assuming every visit is first-run or mutating
  // onboarding state to hide an unexpected modal.
  if ((await onboarding()).open) {
    const welcome = page.getByRole("dialog", { name: "Welcome to Synara", exact: true });
    const skipTour = welcome.getByRole("button", { name: "Skip setup", exact: true });
    await expect(skipTour).toBeVisible();
    await skipTour.click();
  } else {
    // The import announcement is per browser/installation. A fresh context on
    // an already configured server sees this sheet instead of the welcome tour.
    const announcement = page.getByRole("dialog", { name: "Import projects", exact: true });
    await expect(announcement).toBeVisible();
    await announcement.getByRole("button", { name: "Not now", exact: true }).click();
  }
  // The import sheet can hand its slot to the feature tour after a quiet interval.
  // Wait for the actual startup coordinator, not a momentary empty dialog list.
  await expect
    .poll(
      async () => {
        const skip = page.getByRole("button", { name: "Skip tour", exact: true });
        if (await skip.isVisible()) await skip.click({ timeout: 5_000 });
        return page.evaluate(async () => {
          const modulePath = "/src/components/announcementSheetSlot.ts";
          const { useAnnouncementSheetSlotStore } = await import(/* @vite-ignore */ modulePath);
          return useAnnouncementSheetSlotStore.getState().startupSettled;
        });
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

export async function seedEditorProject(page: Page, workspace: string): Promise<string> {
  await openEditorAcceptanceApp(page);
  return page.evaluate(async (cwd) => {
    const modulePath = "/src/nativeApi.ts";
    const { ensureNativeApi } = await import(/* @vite-ignore */ modulePath);
    const api = ensureNativeApi();
    const now = new Date().toISOString();
    const projectId = crypto.randomUUID();
    const threadId = crypto.randomUUID();
    await api.orchestration.dispatchCommand({
      type: "project.create",
      commandId: crypto.randomUUID(),
      projectId,
      title: "Editor acceptance",
      workspaceRoot: cwd,
      createdAt: now,
    });
    await api.orchestration.dispatchCommand({
      type: "thread.create",
      commandId: crypto.randomUUID(),
      threadId,
      projectId,
      title: "Native editor intelligence",
      modelSelection: { provider: "codex", model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "main",
      worktreePath: null,
      createdAt: now,
    });
    // No turn is submitted: model metadata does not start a provider or send project data.
    return threadId;
  }, workspace);
}
