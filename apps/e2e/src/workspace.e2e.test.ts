import { verifyRemoteMcp } from "./harness/remoteMcp";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import type { HostConnection, OrchestrationThreadDetailSnapshot } from "@synara/contracts";
import { workspaceRpc } from "./harness/rpc";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { createE2eFixture } from "./harness/fixture";
import { startWorkspace } from "./harness/workspace";
import { requestLocalRemoteAccess } from "../../server/src/remotePairing/cli";

// Explicit build-dependent qualification; the ordinary transport suite remains build-independent.
it.skipIf(process.env.SYNARA_E2E_WORKSPACE !== "1")(
  "keeps local and remote chats in one browser with independent execution and recovery",
  async () => {
    if (!process.env.TEST_DATABASE_URL)
      throw new Error("An isolated TEST_DATABASE_URL is required");
    await using fixture = await createE2eFixture(process.env.TEST_DATABASE_URL);
    const linked = await fixture.linkHost();
    const controllerDir = path.join(fixture.baseDir, "controller");
    await fixture.prepareController(controllerDir);
    await fs.mkdir(path.join(fixture.baseDir, "bin"));
    const fixtureBinary = path.join(fixture.baseDir, "bin", "codex");
    await fs.copyFile(path.join(import.meta.dirname, "harness/codexFixture.mjs"), fixtureBinary);
    await fs.chmod(fixtureBinary, 0o755);
    await fs.mkdir(path.join(fixture.baseDir, "userdata"), { recursive: true });
    await fs.writeFile(
      path.join(fixture.baseDir, "userdata/settings.json"),
      JSON.stringify({
        providers: {
          codex: { binaryPath: fixtureBinary, homePath: path.join(fixture.baseDir, "codex-home") },
        },
      }),
    );
    // The viewing computer owns sidebar shortcuts even when the host uses different bindings.
    await fs.writeFile(
      path.join(fixture.baseDir, "userdata/keybindings.json"),
      JSON.stringify([{ key: "cmd+shift+p", command: "sidebar.search" }]),
    );
    await fs.mkdir(path.join(controllerDir, "userdata"), { recursive: true });
    await fs.writeFile(
      path.join(controllerDir, "userdata/settings.json"),
      JSON.stringify({
        providers: {
          codex: { binaryPath: fixtureBinary, homePath: path.join(controllerDir, "codex-home") },
        },
      }),
    );
    await using host = await startWorkspace(fixture.baseDir, fixture);
    await using controller = await startWorkspace(controllerDir, fixture);
    const projectId = randomUUID();
    const roots = [path.join(host.baseDir, "project"), path.join(controller.baseDir, "project")];
    for (const [index, root] of roots.entries()) {
      await fs.mkdir(root, { recursive: true });
      await promisify(execFile)("git", [
        "init",
        "--initial-branch",
        index === 0 ? "fixture-remote" : "fixture-local",
        root,
      ]);
      await fs.writeFile(
        path.join(root, "same.txt"),
        index === 0 ? "REMOTE original" : "LOCAL original",
      );
      await promisify(execFile)("git", ["-C", root, "add", "same.txt"]);
      await promisify(execFile)("git", [
        "-C",
        root,
        "-c",
        "user.name=Synara fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "-m",
        "Initial isolated fixture",
      ]);
      await using rpc = await workspaceRpc(index === 0 ? host.origin : controller.origin);
      await rpc.request("orchestration.dispatchCommand", {
        type: "project.create",
        commandId: randomUUID(),
        projectId,
        title: index === 0 ? "REMOTE checkout" : "LOCAL checkout",
        workspaceRoot: root,
        createdAt: new Date().toISOString(),
      });
    }
    await using initialRemote = await workspaceRpc(host.origin);
    const remoteNavigationThreadId = randomUUID();
    await initialRemote.request("orchestration.dispatchCommand", {
      type: "thread.create",
      commandId: randomUUID(),
      threadId: remoteNavigationThreadId,
      projectId,
      title: "Remote navigation fixture",
      modelSelection: { provider: "codex", model: "gpt-6-astra" },
      runtimeMode: "full-access",
      interactionMode: "default",
      envMode: "local",
      branch: null,
      worktreePath: null,
      createdAt: new Date().toISOString(),
    });
    const unusedRemoteRoot = path.join(host.baseDir, "unused-remote-project");
    await fs.mkdir(unusedRemoteRoot);
    await initialRemote.request("orchestration.dispatchCommand", {
      type: "project.create",
      commandId: randomUUID(),
      projectId: randomUUID(),
      title: "Unused remote project",
      workspaceRoot: unusedRemoteRoot,
      createdAt: new Date().toISOString(),
    });
    const invitation = await requestLocalRemoteAccess(host.baseDir, {
      operation: "create-code",
    });
    expect(invitation.kind).toBe("pairing-code");
    if (invitation.kind !== "pairing-code") throw new Error("Missing invitation");
    await fixture.waitReady();
    const preview = await requestLocalRemoteAccess(controller.baseDir, {
      operation: "redeem-code",
      code: invitation.code,
    });
    if (preview.kind !== "pairing-preview") throw new Error("Missing pairing preview");
    expect(preview.rootFingerprint).toBe(invitation.rootFingerprint);
    const device = await requestLocalRemoteAccess(controller.baseDir, { operation: "device-info" });
    if (device.kind !== "device-info") throw new Error("Missing device");
    const pairing = requestLocalRemoteAccess(controller.baseDir, {
      operation: "confirm-code",
      inviteId: preview.inviteId,
      rootFingerprint: invitation.rootFingerprint,
    });
    // Install the rejection handler immediately while the independent owner polls.
    const paired = pairing.then(
      (value) => ({ value }),
      (error) => {
        console.error("Pair failed", error);
        return { error };
      },
    );
    await expect
      .poll(
        async () => {
          const state = await requestLocalRemoteAccess(host.baseDir, { operation: "list" });
          return (
            state.kind === "host-state" &&
            state.invitations.some((item) => item.pendingDevice?.deviceJkt === device.deviceJkt)
          );
        },
        { timeout: 20_000 },
      )
      .toBe(true);
    await requestLocalRemoteAccess(host.baseDir, {
      operation: "approve",
      inviteId: invitation.inviteId,
      deviceJkt: device.deviceJkt,
    });
    expect(await paired).toMatchObject({ value: { kind: "paired" } });
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      reducedMotion: "reduce",
      viewport: { width: 1440, height: 1000 },
    });
    page.on("pageerror", (error) => console.error("Browser error:", error.message));
    await page.addLocatorHandler(
      page.getByRole("button", { name: "Skip setup", exact: true }),
      async (button) => {
        await button.click();
      },
    );
    await page.addLocatorHandler(
      page.getByRole("button", { name: "Not now", exact: true }),
      async (button) => {
        await button.click();
      },
    );
    try {
      // Startup announcements can dismiss an open menu. Use the public route
      // and exercise the real connection control after those dialogs settle.
      await page.goto(`${controller.origin}/settings?section=connections`);
      await page
        .getByRole("button", { name: /This computer.*Connected/ })
        .first()
        .waitFor();
      await page.evaluate(() => {
        (globalThis as unknown as { workspaceSentinel: string }).workspaceSentinel =
          "same-renderer";
      });
      await page.getByRole("button", { name: "Connect", exact: true }).first().click();
      await page
        .getByRole("button", { name: /^REMOTE checkout, E2E host/ })
        .first()
        .waitFor();
      await page.getByText("REMOTE checkout", { exact: true }).first().waitFor();
      await page.getByText(/^Opening E2E host/).waitFor({ state: "hidden" });
      await page.getByText("LOCAL checkout", { exact: true }).first().waitFor();
      await verifyRemoteMcp({ controller, host, projectId });
      const providerEvidenceOffset = (
        await fs.readFile(path.join(host.baseDir, "fixture-provider.jsonl"), "utf8")
      ).length;
      const projectsList = page.getByTestId("workspace-project-list");
      await projectsList.getByText("REMOTE checkout", { exact: true }).waitFor();
      await projectsList.getByText("LOCAL checkout", { exact: true }).waitFor();
      expect(await page.getByLabel(/^Projects on /).count()).toBe(0);
      expect(await page.getByText("Unused remote project", { exact: true }).count()).toBe(0);
      expect(await page.getByRole("button", { name: "Local chats", exact: true }).count()).toBe(0);

      expect(
        await page.evaluate(
          () => (globalThis as unknown as { workspaceSentinel: string }).workspaceSentinel,
        ),
      ).toBe("same-renderer");
      const remotePage = page.frameLocator('iframe[title^="Synara workspace on"]');
      // The remote frame is hidden when creation begins: activating its old Home route
      // must not supersede the project-specific draft navigation.
      await page.getByText("LOCAL checkout", { exact: true }).first().hover();
      await page
        .getByRole("button", { name: "Create new thread in LOCAL checkout", exact: true })
        .click();
      await page.locator('[contenteditable="true"]').first().fill("NEW LOCAL DRAFT");
      await page.getByRole("button", { name: "Run on: This computer", exact: true }).click();
      await page.getByRole("menuitem", { name: /E2E host/ }).click();
      await remotePage.getByRole("button", { name: /^Run on: E2E host/ }).waitFor();
      await remotePage.getByRole("button", { name: /^Run on: E2E host/ }).click();
      await remotePage.getByRole("menuitem", { name: /This computer/ }).click();
      await page.getByRole("button", { name: "Run on: This computer", exact: true }).waitFor();
      await page.getByText("REMOTE checkout", { exact: true }).first().hover();
      await page.getByRole("button", { name: /^New chat in REMOTE checkout on / }).click();
      const newRemoteComposer = remotePage.locator('[contenteditable="true"]').first();
      await newRemoteComposer.fill("NEW REMOTE DRAFT");
      await remotePage.getByRole("button", { name: "Toggle right sidebar", exact: true }).click();
      await remotePage.getByRole("button", { name: "Open Files", exact: true }).click();
      await remotePage.getByText("same.txt", { exact: true }).first().waitFor();
      await page.getByText("LOCAL checkout", { exact: true }).first().hover();
      await page
        .getByRole("button", { name: "Create new thread in LOCAL checkout", exact: true })
        .click();
      expect(await page.locator('[contenteditable="true"]').first().innerText()).toBe(
        "NEW LOCAL DRAFT",
      );
      await page.getByText("REMOTE checkout", { exact: true }).first().hover();
      await page.getByRole("button", { name: /^New chat in REMOTE checkout on / }).click();
      expect(await newRemoteComposer.innerText()).toBe("NEW REMOTE DRAFT");
      await using localRpc = await workspaceRpc(controller.origin);
      const connection = await localRpc.request<HostConnection>("hosts.connect", {
        hostId: linked.row.id,
      });
      expect(connection.transport).toBe("cloudflare");
      await using remoteRpc = await workspaceRpc(controller.origin, connection.wsPath);
      expect(
        await remoteRpc.request("projects.readFile", { cwd: roots[0], relativePath: "same.txt" }),
      ).toMatchObject({ contents: "REMOTE original" });
      await remoteRpc.request("projects.writeFile", {
        cwd: roots[0],
        relativePath: "same.txt",
        contents: "REMOTE changed",
      });
      expect(await fs.readFile(path.join(roots[0]!, "same.txt"), "utf8")).toBe("REMOTE changed");
      expect(await fs.readFile(path.join(roots[1]!, "same.txt"), "utf8")).toBe("LOCAL original");
      const addedRoot = path.join(host.baseDir, "added-from-picker");
      await fs.mkdir(addedRoot);
      await fs.writeFile(path.join(addedRoot, "README.md"), "PICKED ON REMOTE");
      await page.getByText("Projects", { exact: true }).first().hover();
      await page.getByRole("button", { name: "Add project", exact: true }).click();
      await page
        .getByRole("textbox", { name: "Project name", exact: true })
        .fill("Named remote project");
      await page.getByRole("button", { name: /^Project computer:/ }).click();
      await page.getByRole("menuitem", { name: /This computer/ }).click();
      await page
        .getByRole("textbox", { name: "Project folder path" })
        .fill("/must-not-follow-the-computer");
      await page.getByRole("button", { name: "Project computer: This computer" }).click();
      await page.getByRole("menuitem", { name: /E2E host/ }).click();
      expect(await page.getByRole("textbox", { name: "Project folder path" }).inputValue()).toBe(
        "",
      );
      if (process.env.SYNARA_E2E_EVIDENCE)
        await page.getByRole("dialog", { name: "Create project", exact: true }).screenshot({
          path: path.join(process.env.SYNARA_E2E_EVIDENCE, "create-project-computer.png"),
        });
      await page.getByRole("button", { name: "Add folder", exact: true }).click();
      await page.getByRole("textbox", { name: "Folder path", exact: true }).fill(addedRoot);
      await page.getByRole("button", { name: "Go", exact: true }).click();
      await expect
        .poll(async () =>
          page.getByRole("textbox", { name: "Folder path", exact: true }).inputValue(),
        )
        .toBe(addedRoot);
      await page.getByRole("button", { name: "Use folder", exact: true }).click();
      await page.getByRole("button", { name: "Create project", exact: true }).click();
      await remotePage
        .getByTestId("empty-landing-heading")
        .filter({ hasText: "Named remote project" })
        .waitFor();
      const added = await remoteRpc.request<{
        projects: { title: string; workspaceRoot: string }[];
      }>("orchestration.getShellSnapshot");
      expect(added.projects).toContainEqual(
        expect.objectContaining({
          title: "Named remote project",
          workspaceRoot: await fs.realpath(addedRoot),
        }),
      );
      const localProjects = await localRpc.request<{ projects: { workspaceRoot: string }[] }>(
        "orchestration.getShellSnapshot",
      );
      const canonicalAddedRoot = await fs.realpath(addedRoot);
      expect(
        localProjects.projects.some((project) => project.workspaceRoot === canonicalAddedRoot),
      ).toBe(false);
      await page.reload();
      await page
        .getByRole("button", { name: /^REMOTE checkout, E2E host/ })
        .first()
        .waitFor();
      expect(await remoteRpc.request("git.status", { cwd: roots[0] })).toMatchObject({
        branch: "fixture-remote",
      });
      const threadId = randomUUID();
      const modelSelection = { provider: "codex", model: "gpt-6-astra" };
      await remoteRpc.request("orchestration.dispatchCommand", {
        type: "thread.create",
        commandId: randomUUID(),
        threadId,
        projectId,
        title: "Remote continuity fixture",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        envMode: "local",
        branch: null,
        worktreePath: null,
        createdAt: new Date().toISOString(),
      });
      await localRpc.request("orchestration.dispatchCommand", {
        type: "thread.create",
        commandId: randomUUID(),
        threadId,
        projectId,
        title: "Local continuity fixture",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        envMode: "local",
        branch: null,
        worktreePath: null,
        createdAt: new Date().toISOString(),
      });
      // Search and row actions must preserve the owner even when both servers use the same IDs.
      await page.getByText("Local continuity fixture", { exact: true }).first().click();
      await page.keyboard.press("Meta+k");
      await page.getByPlaceholder("Search chats or run a command").fill("continuity");
      await page.getByRole("option", { name: /Local continuity fixture/ }).waitFor();
      const remoteSearchResult = page.getByRole("option", { name: /Remote continuity fixture/ });
      await remoteSearchResult.waitFor();
      expect(await remoteSearchResult.innerText()).toContain("E2E host");
      if (process.env.SYNARA_E2E_EVIDENCE)
        await page.screenshot({
          path: path.join(process.env.SYNARA_E2E_EVIDENCE, "workspace-remote-search.png"),
        });
      await remoteSearchResult.click();
      await expect
        .poll(() => new URL(page.url()).searchParams.get("environment"))
        .toBe(linked.row.environmentId);
      await remotePage.locator('[contenteditable="true"]').first().focus();
      await page.keyboard.press("Meta+k");
      // A shortcut originating inside the remote frame still opens the unified outer palette.
      await page.getByPlaceholder("Search chats or run a command").fill("continuity");
      await page.getByRole("option", { name: /Local continuity fixture/ }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe(`/${threadId}`);
      await page.keyboard.press("Meta+k");
      await page.getByPlaceholder("Search chats or run a command").fill("REMOTE checkout");
      await page.getByRole("option", { name: /^REMOTE checkout/ }).click();
      await expect
        .poll(() => new URL(page.url()).searchParams.get("environment"))
        .toBe(linked.row.environmentId);
      const remoteThread = () =>
        page.getByRole("button", { name: /^Remote continuity fixture, E2E host/ }).first();
      await remoteThread().click();
      await remotePage.locator('[contenteditable="true"]').first().focus();
      for (let index = 0; index < 10 && new URL(page.url()).pathname !== `/${threadId}`; index++) {
        const before = page.url();
        await page.keyboard.press("Meta+Shift+]");
        await expect.poll(() => page.url()).not.toBe(before);
      }
      expect(new URL(page.url()).pathname).toBe(`/${threadId}`);
      await remoteThread().click();
      await remoteThread().click({ button: "right" });
      await page.getByRole("menuitem", { name: "Rename chat", exact: true }).click();
      await page
        .getByRole("textbox", { name: "Rename chat", exact: true })
        .fill("Remote renamed safely");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      const readThread = async (rpc: typeof remoteRpc) =>
        (
          await rpc.request<OrchestrationThreadDetailSnapshot>(
            "orchestration.getThreadDetailSnapshot",
            { threadId },
          )
        ).thread;
      await expect
        .poll(async () => (await readThread(remoteRpc)).title)
        .toBe("Remote renamed safely");
      expect((await readThread(localRpc)).title).toBe("Local continuity fixture");
      await page
        .getByRole("button", { name: /^Remote renamed safely, E2E host/ })
        .first()
        .click({ button: "right" });
      await page.getByRole("menuitem", { name: "Pin thread", exact: true }).click();
      await expect.poll(async () => (await readThread(remoteRpc)).isPinned).toBe(true);
      expect((await readThread(localRpc)).isPinned).toBe(false);
      await page
        .getByRole("button", { name: /^Remote renamed safely, E2E host/ })
        .first()
        .click({ button: "right" });
      await page.getByRole("menuitem", { name: "Unpin thread", exact: true }).click();
      await expect.poll(async () => (await readThread(remoteRpc)).isPinned).toBe(false);
      await remoteRpc.request("orchestration.dispatchCommand", {
        type: "thread.meta.update",
        commandId: randomUUID(),
        threadId,
        title: "Remote continuity fixture",
      });
      await remoteRpc.request("terminal.open", { threadId, terminalId: "fixture", cwd: roots[0] });
      await remoteRpc.request("terminal.write", {
        threadId,
        terminalId: "fixture",
        data: "printf REMOTE_TERMINAL > terminal-proof.txt\r",
      });
      await expect
        .poll(() => fs.readFile(path.join(roots[0]!, "terminal-proof.txt"), "utf8"))
        .toBe("REMOTE_TERMINAL");
      expect(
        await fs.stat(path.join(roots[1]!, "terminal-proof.txt")).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
      const bytes = new Uint8Array(512 * 1024).fill(91);
      const resourceUrl = (resource: object) =>
        `${controller.origin}/api/remote/resource/${linked.row.id}?${new URLSearchParams({ reference: JSON.stringify({ environmentId: linked.row.environmentId, resource }) })}`;
      const uploaded = await fetch(
        resourceUrl({
          kind: "attachment-upload",
          threadId,
          type: "file",
          name: "fixture.bin",
          mimeType: "application/octet-stream",
        }),
        {
          method: "POST",
          headers: { origin: controller.origin, "content-type": "application/octet-stream" },
          body: bytes,
        },
      );
      expect(uploaded.status, await uploaded.clone().text()).toBe(201);
      const attachment = (await uploaded.json()) as { id: string };
      await remoteRpc.request("orchestration.dispatchCommand", {
        type: "thread.turn.start",
        commandId: randomUUID(),
        threadId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        envMode: "local",
        message: {
          messageId: randomUUID(),
          role: "user",
          text: "Run the isolated continuity fixture",
          attachments: [attachment],
        },
        createdAt: new Date().toISOString(),
      });
      await expect
        .poll(
          async () => {
            const snapshot = await remoteRpc.request<OrchestrationThreadDetailSnapshot>(
              "orchestration.getThreadDetailSnapshot",
              { threadId },
            );
            return JSON.stringify(snapshot).includes("REMOTE STREAM STARTED");
          },
          { timeout: 20_000 },
        )
        .toBe(true);
      await page.getByRole("button", { name: "Switch to activity view", exact: true }).click();
      await page.getByRole("button", { name: /^Remote continuity fixture, E2E host/ }).click();
      await remotePage.getByText("Remote continuity fixture", { exact: true }).first().waitFor();
      if (process.env.SYNARA_E2E_EVIDENCE)
        await page.screenshot({
          path: path.join(process.env.SYNARA_E2E_EVIDENCE, "workspace-unified-activity.png"),
        });
      await page.getByRole("button", { name: "Switch to classic view", exact: true }).click();
      await page.getByText("Remote continuity fixture", { exact: true }).first().click();
      await remotePage.getByText("REMOTE STREAM STARTED", { exact: true }).waitFor();
      // One sidebar control owns both the controller and its visible remote pane.
      await expect
        .poll(() =>
          remotePage.getByRole("button", { name: "Toggle thread sidebar", exact: true }).count(),
        )
        .toBe(0);
      await page
        .getByRole("button", { name: "Toggle thread sidebar", exact: true })
        .first()
        .click();
      await remotePage.getByRole("button", { name: "Toggle thread sidebar", exact: true }).click();
      await page.getByText("LOCAL checkout", { exact: true }).first().waitFor();
      await expect
        .poll(() =>
          remotePage.getByRole("button", { name: "Toggle thread sidebar", exact: true }).count(),
        )
        .toBe(0);

      const remoteComposer = remotePage.locator('[contenteditable="true"]').first();
      await remoteComposer.fill("REMOTE DRAFT stays here");
      await page.getByText("Local continuity fixture", { exact: true }).first().click();
      const localComposer = page.locator('[contenteditable="true"]').first();
      await localComposer.fill("LOCAL DRAFT stays here");
      await page.getByText("Remote continuity fixture", { exact: true }).first().click();
      expect(await remoteComposer.innerText()).toBe("REMOTE DRAFT stays here");
      await page.getByText("Local continuity fixture", { exact: true }).first().click();
      expect(await localComposer.innerText()).toBe("LOCAL DRAFT stays here");
      await page.getByText("Remote continuity fixture", { exact: true }).first().click();
      await fixture.stopConnector();
      await expect
        .poll(async () => {
          try {
            await remoteRpc.request("server.getEnvironment");
            return false;
          } catch {
            return true;
          }
        })
        .toBe(true);
      await page.getByText("Local continuity fixture", { exact: true }).first().click();
      expect(await localComposer.innerText()).toBe("LOCAL DRAFT stays here");
      // The provider advances with the network down; automatic resubscription
      // must recover this delta in the existing browser without replaying a turn.
      await fs.writeFile(path.join(host.baseDir, "connector-gap-fixture"), "emit");
      await expect
        .poll(async () =>
          (await fs.readFile(path.join(host.baseDir, "fixture-provider.jsonl"), "utf8")).includes(
            '"connector-gap"',
          ),
        )
        .toBe(true);
      await fixture.restartConnector();
      await remotePage
        .getByText("REMOTE STREAM STARTED — RECOVERED AFTER CONNECTOR RESTART", { exact: true })
        .waitFor({ timeout: 40_000, state: "attached" });
      await page.getByText("Remote continuity fixture", { exact: true }).first().click();
      await controller.stop();
      await fs.writeFile(path.join(host.baseDir, "finish-fixture-turn"), "finish");
      await expect
        .poll(async () =>
          (await fs.readFile(path.join(host.baseDir, "fixture-provider.jsonl"), "utf8")).includes(
            '"completed"',
          ),
        )
        .toBe(true);
      await using restartedController = await startWorkspace(
        controllerDir,
        fixture,
        controller.origin,
      );
      // Recovery must restore durable intent without reloading the renderer,
      // whose bootstrap would issue hosts.connect and mask a stopped supervisor.
      await using restartedLocal = await workspaceRpc(restartedController.origin);
      await expect
        .poll(
          async () =>
            (
              await restartedLocal.request<{ connections: HostConnection[] }>(
                "hosts.listConnections",
              )
            ).connections.some((item) => item.hostId === linked.row.id),
          { timeout: 40_000 },
        )
        .toBe(true);
      await remotePage
        .getByText(
          "REMOTE STREAM STARTED — RECOVERED AFTER CONNECTOR RESTART — COMPLETED WHILE CONTROLLER WAS STOPPED",
          {
            exact: true,
          },
        )
        .waitFor();
      const providerEvents = (
        await fs.readFile(path.join(host.baseDir, "fixture-provider.jsonl"), "utf8")
      )
        .slice(providerEvidenceOffset)
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(providerEvents.filter((event) => event.kind === "turn")).toHaveLength(1);
      expect(providerEvents.find((event) => event.kind === "completed").pid).toBe(
        providerEvents.find((event) => event.kind === "turn").pid,
      );
      const downloaded = await fetch(
        resourceUrl({ kind: "attachment", attachmentId: attachment.id }),
      );
      expect(downloaded.status).toBe(200);
      const received = new Uint8Array(await downloaded.arrayBuffer());
      expect(received.byteLength).toBe(bytes.byteLength);
      expect(createHash("sha256").update(received).digest("hex")).toBe(
        createHash("sha256").update(bytes).digest("hex"),
      );
      const range = await fetch(resourceUrl({ kind: "attachment", attachmentId: attachment.id }), {
        headers: { range: "bytes=7-38" },
      });
      expect(range.status).toBe(206);
      expect(new Uint8Array(await range.arrayBuffer())).toEqual(bytes.slice(7, 39));
      await using recoveredLocal = await workspaceRpc(controller.origin);
      const recoveredConnection = await recoveredLocal.request<HostConnection>("hosts.connect", {
        hostId: linked.row.id,
      });
      await using recoveredRemote = await workspaceRpc(
        controller.origin,
        recoveredConnection.wsPath,
      );
      await recoveredRemote.request("orchestration.dispatchCommand", {
        type: "thread.turn.start",
        commandId: randomUUID(),
        threadId,
        modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        message: {
          messageId: randomUUID(),
          role: "user",
          text: "APPROVAL FIXTURE",
          attachments: [],
        },
        createdAt: new Date().toISOString(),
      });
      await remotePage.getByRole("button", { name: /Approve once/ }).click();
      await expect
        .poll(
          async () =>
            (await fs.readFile(path.join(host.baseDir, "fixture-provider.jsonl"), "utf8")).includes(
              '"decision":"accept"',
            ),
          { timeout: 10_000 },
        )
        .toBe(true);
      await recoveredRemote.request("orchestration.dispatchCommand", {
        type: "thread.turn.interrupt",
        commandId: randomUUID(),
        threadId,
        createdAt: new Date().toISOString(),
      });
      await expect
        .poll(async () =>
          (await fs.readFile(path.join(host.baseDir, "fixture-provider.jsonl"), "utf8")).includes(
            '"interrupted"',
          ),
        )
        .toBe(true);
      await expect
        .poll(async () => {
          const snapshot = await recoveredRemote.request<OrchestrationThreadDetailSnapshot>(
            "orchestration.getThreadDetailSnapshot",
            { threadId },
          );
          return snapshot.thread.latestTurn?.state;
        })
        .toBe("interrupted");
      // Separate provider turns must not reuse an item id and merge text rows.
      await remotePage
        .getByText(
          "REMOTE STREAM STARTED — RECOVERED AFTER CONNECTOR RESTART — COMPLETED WHILE CONTROLLER WAS STOPPED",
          { exact: true },
        )
        .waitFor();
      await page
        .getByRole("button", { name: /^REMOTE checkout, E2E host/ })
        .first()
        .waitFor();
      const evidenceDir = process.env.SYNARA_E2E_EVIDENCE;
      if (evidenceDir) {
        await fs.mkdir(evidenceDir, { recursive: true });
        await page.screenshot({ path: path.join(evidenceDir, "workspace-remote.png") });
      }
      // Activity requires a started chat. Archive its inactive remote row while local is open.
      await page
        .getByRole("button", { name: /^Remote navigation fixture, E2E host/ })
        .first()
        .click();
      await page.getByText("Local continuity fixture", { exact: true }).first().click();
      await page.getByRole("button", { name: "Switch to activity view", exact: true }).click();
      await remoteThread().click({ button: "right" });
      if (evidenceDir)
        await page.screenshot({ path: path.join(evidenceDir, "workspace-remote-menu.png") });
      await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
      await expect.poll(async () => (await readThread(recoveredRemote)).archivedAt).not.toBeNull();
      expect((await readThread(recoveredLocal)).archivedAt).toBeNull();
      await expect
        .poll(() => new URL(page.url()).searchParams.get("path"))
        .toBe(`/${remoteNavigationThreadId}`);
      await remotePage.getByRole("button", { name: "Undo", exact: true }).click();
      await expect.poll(async () => (await readThread(recoveredRemote)).archivedAt).toBeNull();
      await page.getByRole("button", { name: "Switch to classic view", exact: true }).click();
      await remoteThread().click();
      await requestLocalRemoteAccess(host.baseDir, {
        operation: "revoke-device",
        deviceJkt: device.deviceJkt,
      });
      await expect
        .poll(async () => {
          try {
            await recoveredRemote.request("server.getEnvironment");
            return false;
          } catch {
            return true;
          }
        })
        .toBe(true);
      const refused = await fetch(resourceUrl({ kind: "attachment", attachmentId: attachment.id }));
      expect(refused.ok).toBe(false);
      await host.stop();
      const connectorPid = Number(
        await fs.readFile(path.join(host.baseDir, "edge-fixture", "connector.pid"), "utf8"),
      );
      expect(() => process.kill(connectorPid, 0)).toThrow();
      const taskPid = providerEvents.find((event) => event.kind === "turn").pid as number;
      await expect
        .poll(() => {
          try {
            process.kill(taskPid, 0);
            return false;
          } catch {
            return true;
          }
        })
        .toBe(true);
      await page.reload();
      await page.getByText("LOCAL checkout", { exact: true }).first().waitFor();
      // Local navigation still works when a remote runtime cannot bootstrap.
      await page.getByText("Local continuity fixture", { exact: true }).first().click();
      expect(await page.locator('[contenteditable="true"]').first().innerText()).toBe(
        "LOCAL DRAFT stays here",
      );
      if (evidenceDir)
        await page.screenshot({ path: path.join(evidenceDir, "workspace-local-recovery.png") });
    } catch (error) {
      console.error("Original browser failure", error);
      if (process.env.SYNARA_E2E_EVIDENCE)
        await fs
          .copyFile(
            path.join(host.baseDir, "fixture-provider.jsonl"),
            path.join(process.env.SYNARA_E2E_EVIDENCE, "fixture-provider.jsonl"),
          )
          .catch(() => undefined);
      console.error(
        await page
          .locator("body")
          .innerText({ timeout: 3000 })
          .catch(() => "Body unavailable"),
      );
      for (const frame of page.frames().slice(1))
        console.error(
          "Frame:",
          await frame
            .locator("body")
            .innerText({ timeout: 3000 })
            .catch(() => "Frame unavailable"),
        );
      if (process.env.SYNARA_E2E_EVIDENCE)
        await page
          .screenshot({
            path: path.join(process.env.SYNARA_E2E_EVIDENCE, "workspace-failure.png"),
            timeout: 3000,
          })
          .catch(() => undefined);
      throw error;
    } finally {
      await browser.close();
    }
  },
  120_000,
);
