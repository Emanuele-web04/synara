import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { CanvasWork } from "@synara/contracts";
import { chromium, type Page } from "playwright";
import { expect, it } from "vitest";
import { workspaceRpc } from "./harness/rpc";

// Opt-in against an isolated dev server whose Codex provider is harness/codexFixture.mjs.
// Canvas content is created only through the real provider-authenticated MCP route; the
// browser drives the real UI. Nothing in the app is mocked.
const origin = process.env.SYNARA_E2E_DESIGN_ORIGIN;

type Step = { name: string; arguments: Record<string, unknown>; expectedError?: string };
type McpResult = {
  status: number;
  body: {
    error?: unknown;
    result: {
      isError?: boolean;
      content: { type: string; text?: string; data?: string }[];
      tools?: { name: string }[];
    };
  };
};

type WorkspaceRpc = Awaited<ReturnType<typeof workspaceRpc>>;
const json = (result: McpResult) => JSON.parse(result.body.result.content[0]!.text!);
const mutationId = () => `m_${randomUUID().replaceAll("-", "")}`;

/**
 * A project and a chat whose fixture agent runs real turns: each `turn` makes the given MCP
 * tool calls, in order, through the provider-authenticated gateway, then settles the turn.
 */
async function startAgentThread(rpc: WorkspaceRpc, home: string) {
  const projectId = randomUUID();
  const workspaceRoot = path.join(home, `project-${projectId.slice(0, 8)}`);
  await fs.mkdir(workspaceRoot, { recursive: true });
  await rpc.request("orchestration.dispatchCommand", {
    type: "project.create",
    commandId: randomUUID(),
    projectId,
    title: `Canvas ${projectId.slice(0, 8)}`,
    workspaceRoot,
    createdAt: new Date().toISOString(),
  });
  const threadId = randomUUID();
  await rpc.request("orchestration.dispatchCommand", {
    type: "thread.create",
    commandId: randomUUID(),
    threadId,
    projectId,
    title: "Canvas agent",
    modelSelection: { provider: "codex", model: "gpt-6-astra" },
    runtimeMode: "full-access",
    interactionMode: "default",
    envMode: "local",
    branch: null,
    worktreePath: null,
    createdAt: new Date().toISOString(),
  });
  const completedTurns = async () =>
    (await fs.readFile(path.join(home, "fixture-provider.jsonl"), "utf8").catch(() => ""))
      .split("\n")
      .filter((line) => line.includes('"kind":"completed"')).length;
  const completedBefore = await completedTurns();
  let turns = 0;
  /** One real agent turn whose fixture provider calls the given MCP tools in order. */
  const turn = async (steps: Step[]): Promise<McpResult[]> => {
    const file = path.join(home, "mcp-fixture-results.json");
    await fs.rm(file, { force: true });
    await fs.writeFile(
      path.join(home, "mcp-fixture-plan.json"),
      JSON.stringify({
        endpoint: `${origin}/mcp`,
        warmupMs: 300,
        completeTurn: true,
        steps: [
          { method: "tools/list", params: {} },
          ...steps.map(({ name, arguments: args }) => ({ name, arguments: args })),
        ],
      }),
    );
    await rpc.request("orchestration.dispatchCommand", {
      type: "thread.turn.start",
      commandId: randomUUID(),
      threadId,
      message: {
        messageId: randomUUID(),
        role: "user",
        text: "REMOTE MCP FIXTURE",
        attachments: [],
      },
      modelSelection: { provider: "codex", model: "gpt-6-astra" },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: new Date().toISOString(),
    });
    await expect
      .poll(
        () =>
          fs.access(file).then(
            () => true,
            () => false,
          ),
        { timeout: 45_000 },
      )
      .toBe(true);
    const results = JSON.parse(await fs.readFile(file, "utf8")) as McpResult[];
    // The next turn starts only after the fixture settles this one.
    turns++;
    await expect
      .poll(completedTurns, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(completedBefore + turns);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(results).toHaveLength(steps.length + 1);
    expect(results[0]!.body.result.tools!.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "synara_canvas_guide",
        "synara_put_canvas_view",
        "synara_edit_design_layers",
        "synara_screenshot_canvas",
        "synara_list_canvas_comments",
        "synara_reply_canvas_comment",
        "synara_add_canvas_font",
      ]),
    );
    for (const [index, step] of steps.entries()) {
      const result = results[index + 1]!;
      expect(result.status).toBe(200);
      if (step.expectedError) {
        expect(result.body.result.isError).toBe(true);
        expect(JSON.stringify(result.body.result.content)).toContain(step.expectedError);
      } else expect(result.body.result.isError, JSON.stringify(result.body)).not.toBe(true);
    }
    return results;
  };
  return { threadId, turn };
}

/** A headless Chromium on the isolated web app, with first-run announcements dismissed. */
async function launchCanvasBrowser(home: string) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    reducedMotion: "reduce",
  });
  await context.addInitScript(
    `localStorage.setItem('synara:project-import-announcement:v1', ${JSON.stringify(JSON.stringify([path.join(home, "worktrees")]))}); localStorage.setItem('synara:feature-tour:since-0.9.2:v1', ${JSON.stringify(JSON.stringify([path.join(home, "worktrees")]))});`,
  );
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return { browser, page, errors };
}

const frameHost = (p: Page, id: string) => p.locator(`[data-canvas-frame-id="${id}"]`).first();

function requireIsolatedEnvironment() {
  const home = process.env.SYNARA_E2E_DESIGN_HOME;
  const web = process.env.SYNARA_E2E_DESIGN_WEB;
  if (!home || !web)
    throw new Error("Provide isolated SYNARA_E2E_DESIGN_HOME and SYNARA_E2E_DESIGN_WEB.");
  return { home, web };
}

it.skipIf(!origin)(
  "agents design on a native canvas the user edits beside the chat, isolated and recoverable",
  async () => {
    const { home, web } = requireIsolatedEnvironment();
    await using rpc = await workspaceRpc(origin!);
    const { threadId, turn } = await startAgentThread(rpc, home);
    const readWork = (workId: string) => rpc.request<CanvasWork>("canvas.get", { workId });

    // A recorder for any network request a design might try to make.
    const outbound: string[] = [];
    const recorder = createServer((request, response) => {
      outbound.push(request.url ?? "");
      response.end("unexpected network access");
    });
    await new Promise<void>((resolve) => recorder.listen(0, "127.0.0.1", resolve));
    const probe = `http://127.0.0.1:${(recorder.address() as AddressInfo).port}`;

    const workId = `work_${randomUUID().replaceAll("-", "")}`;
    const pageId = "page-main";
    const landing = {
      id: "landing",
      title: "Landing",
      width: 960,
      height: 640,
      expectedRevision: 0,
      html: `<style>.hero{padding:48px;background:#eef2e8}.hero h1{font-size:44px;color:#174039;margin:0}.cta:hover{color:red}.cta{display:inline-block;margin-top:24px;padding:12px 20px;background:#174039;color:#fff;border-radius:8px}@media (max-width:600px){.hero h1{font-size:12px}}</style><section class="hero"><h1>Made by an agent</h1><p>A quiet place to read.</p><span class="cta">Start reading</span></section>`,
      style: "font-family: Georgia, serif",
    };
    const hostile = {
      id: "hostile",
      title: "Hostile",
      width: 480,
      height: 360,
      expectedRevision: 0,
      x: 1200,
      html: `<div style="position:fixed;inset:0;z-index:2147483647;background:rgb(255,0,0);background-image:url(${probe}/css)" data-probe="overlay">Overlay</div><img src="${probe}/img"><a href="${probe}/link">link</a><button onclick="window.__pwned=1">x</button><script>window.__pwned=1</script><p style="color:var(--background)">vars</p><iframe src="${probe}/frame"></iframe>`,
    };
    const created = await turn([
      { name: "synara_canvas_guide", arguments: {} },
      { name: "synara_create_canvas", arguments: { id: workId, title: "Reading room" } },
      { name: "synara_put_canvas_view", arguments: { workId, pageId, frame: landing } },
      { name: "synara_put_canvas_view", arguments: { workId, pageId, frame: hostile } },
    ]);
    expect(created[1]!.body.result.content[0]!.text).toContain("Synara Canvas design guide");
    const put = json(created[3]!);
    expect(put.dropped.join("\n")).toContain(":hover");
    let work = await readWork(workId);
    let page = work.pages[0]!;
    expect(page.frames.map((frame) => frame.id)).toEqual(["landing", "hostile"]);
    const heading = page.frames[0]!.layers.nodes.find(
      (node) => node.type === "element" && node.tag === "h1",
    )!;
    // Stylesheet rules were inlined by specificity; the 600px media query did not apply.
    expect(heading.type === "element" && heading.attributes.style).toContain("font-size:44px");
    expect(page.frames[0]!.style).toContain("Georgia");
    const hostileHtml = JSON.stringify(page.frames[1]!.layers);
    expect(hostileHtml).not.toContain("script");
    expect(hostileHtml).not.toContain("onclick");
    expect(hostileHtml).not.toContain("href");
    expect(hostileHtml).not.toContain(`${probe}/img`);

    const { browser, page: page_, errors } = await launchCanvasBrowser(home);
    try {
      // 1. The agent's turn shows one canvas card in the chat; Open shows it beside the chat.
      await page_.goto(`${web}/${threadId}`);
      const card = page_.locator(`[data-canvas-turn-card="${workId}"]`);
      await card.waitFor({ timeout: 45_000 });
      expect(await card.count()).toBe(1);
      await expect.poll(() => card.textContent()).toContain("Created 2 frames");
      await card.getByRole("button", { name: "Open", exact: true }).click();
      // The first open compiles the canvas chunk in a cold dev server.
      await frameHost(page_, "landing").waitFor({ timeout: 90_000 });
      await frameHost(page_, "hostile").waitFor();
      // Frames render natively in shadow roots; the layer model is the DOM.
      await expect
        .poll(() =>
          frameHost(page_, "landing").evaluate(
            (host) => host.shadowRoot?.querySelector("h1")?.textContent,
          ),
        )
        .toBe("Made by an agent");

      // 2. Isolation: no script, no network, no escape from the frame, no host variables.
      const isolation = await frameHost(page_, "hostile").evaluate((host) => {
        const win = globalThis as any;
        const overlay = host.shadowRoot!.querySelector('[data-probe="overlay"]')!;
        const frame = host.getBoundingClientRect();
        const box = overlay.getBoundingClientRect();
        const outside = win.document.elementFromPoint(frame.left - 40, frame.top + 10);
        return {
          pwned: Reflect.get(win, "__pwned"),
          scripts: host.shadowRoot!.querySelectorAll("script,iframe").length,
          links: host.shadowRoot!.querySelectorAll("a[href]").length,
          overlayWithinFrame:
            box.left >= frame.left - 1 &&
            box.right <= frame.right + 1 &&
            box.top >= frame.top - 1 &&
            box.bottom <= frame.bottom + 1,
          outsideIsDesign: outside ? host.contains(outside) || outside === host : false,
          paragraphColor: win.getComputedStyle(host.shadowRoot!.querySelector("p")!).color,
          hostBackgroundVar: win
            .getComputedStyle(win.document.documentElement)
            .getPropertyValue("--background"),
        };
      });
      expect(isolation.pwned).toBeUndefined();
      expect(isolation.scripts).toBe(0);
      expect(isolation.links).toBe(0);
      expect(isolation.overlayWithinFrame).toBe(true);
      expect(isolation.outsideIsDesign).toBe(false);
      // var(--background) from the design must not resolve to Synara's theme value.
      expect(isolation.paragraphColor).toBe("rgb(0, 0, 0)");
      expect(isolation.hostBackgroundVar).not.toBe("");

      // 3. Screenshot tool: the open window rasterizes the frame for the agent.
      const shot = await turn([
        {
          name: "synara_screenshot_canvas",
          arguments: { workId, pageId, frameId: "landing", maxSide: 800 },
        },
      ]);
      const image = shot[1]!.body.result.content.find((item) => item.type === "image");
      expect(image?.data?.length ?? 0).toBeGreaterThan(1000);

      // 4. Expand to the full layout: chat on the left, canvas, inspector.
      await page_.getByRole("button", { name: "Open full size" }).click();
      await page_.waitForURL(new RegExp(`/canvas/${workId}`));
      expect(new URL(page_.url()).searchParams.get("chat")).toBe(threadId);
      await frameHost(page_, "landing").waitFor();
      await page_.getByRole("tab", { name: "Layers" }).click();
      await page_.getByRole("treeitem", { name: /Landing/ }).waitFor();
      await page_.getByRole("tab", { name: "Chat" }).click();

      // 5. Selection: a scoped click lands on the frame's top-level layer, Cmd/Ctrl
      // goes deepest; a double-click on text edits it in place.
      const viewport = page_.locator("[data-canvas-viewport]");
      await viewport.focus();
      const h1Box = await frameHost(page_, "landing").evaluate((host) => {
        const rect = host.shadowRoot!.querySelector("h1")!.getBoundingClientRect();
        return { x: rect.left + 20, y: rect.top + rect.height / 2 };
      });
      const mod = process.platform === "darwin" ? "Meta" : "Control";
      await page_.keyboard.down(mod);
      await page_.mouse.click(h1Box.x, h1Box.y);
      await page_.keyboard.up(mod);
      await page_.getByText("Made by an agent", { exact: false }).first().waitFor();
      await page_.mouse.dblclick(h1Box.x, h1Box.y);
      await expect
        .poll(() =>
          frameHost(page_, "landing").evaluate((host) =>
            host.shadowRoot!.querySelector("h1")!.getAttribute("contenteditable"),
          ),
        )
        .toBe("plaintext-only");
      await page_.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
      await page_.keyboard.type("A calmer room");
      await page_.keyboard.press("Enter");
      await expect
        .poll(async () => {
          const frame = (await readWork(workId)).pages[0]!.frames[0]!;
          return (
            frame.layers.nodes.find(
              (node) => node.type === "text" && node.text === "A calmer room",
            ) !== undefined
          );
        })
        .toBe(true);

      // 6. Undo is the user's own history.
      await viewport.focus();
      await page_.keyboard.press(process.platform === "darwin" ? "Meta+Z" : "Control+Z");
      await expect
        .poll(async () =>
          JSON.stringify((await readWork(workId)).pages[0]!.frames[0]!.layers).includes(
            "Made by an agent",
          ),
        )
        .toBe(true);

      // 6b. Text color from the inspector: the user's edit writes the heading's inline style.
      await page_.keyboard.down(mod);
      await page_.mouse.click(h1Box.x, h1Box.y);
      await page_.keyboard.up(mod);
      const textColor = page_.getByRole("textbox", { name: "Text color", exact: true });
      await textColor.fill("#C2410C");
      await textColor.press("Enter");
      await expect
        .poll(async () => {
          const frame = (await readWork(workId)).pages[0]!.frames[0]!;
          const h1 = frame.layers.nodes.find(
            (node) => node.type === "element" && node.tag === "h1",
          );
          return h1?.type === "element" ? (h1.attributes.style ?? "").toLowerCase() : "";
        })
        .toMatch(/color:\s*(#c2410c|rgb\(194,\s*65,\s*12\))/);
      await expect
        .poll(() =>
          frameHost(page_, "landing").evaluate(
            (host) =>
              (globalThis as any).getComputedStyle(host.shadowRoot!.querySelector("h1")!).color,
          ),
        )
        .toBe("rgb(194, 65, 12)");
      // 6c. Export: the section starts empty, + saves the default 2x row on the
      // layer, and Export writes a 2x PNG of just that layer.
      await page_.getByRole("button", { name: "Add Export", exact: true }).first().click();
      await expect
        .poll(async () => Object.values((await readWork(workId)).pages[0]!.exportSettings ?? {}))
        .toEqual([[{ format: "png", scale: "2x", suffix: "@2x" }]]);
      await expect
        .poll(() => page_.getByRole("textbox", { name: "Export size" }).first().inputValue())
        .toBe("2x");
      const downloading = page_.waitForEvent("download");
      await page_
        .getByRole("button", { name: /^Export .+(⇧⌘E|Ctrl\+Shift\+E)$/ })
        .first()
        .click();
      const download = await downloading;
      expect(download.suggestedFilename()).toMatch(/@2x\.png$/);
      const exported = await fs.readFile(await download.path());
      const h1Size = await frameHost(page_, "landing").evaluate((host) => {
        const root = host.shadowRoot!.querySelector("div")!.getBoundingClientRect();
        const h1 = host.shadowRoot!.querySelector("h1")!.getBoundingClientRect();
        const scale = root.width / 960;
        return { width: h1.width / scale, height: h1.height / scale };
      });
      expect(exported.readUInt32BE(16)).toBe(Math.round(h1Size.width * 2));
      expect(exported.readUInt32BE(20)).toBe(Math.round(h1Size.height * 2));
      expect(outbound).toEqual([]);
      await viewport.focus();
      await page_.keyboard.press("Escape");

      // 6d. Flow drag: the paragraph moves above the heading inside its layout, and
      // one undo puts it back.
      const sectionOrder = async () => {
        const frame = (await readWork(workId)).pages[0]!.frames[0]!;
        const section = frame.layers.nodes.find(
          (node) => node.type === "element" && node.tag === "section",
        );
        return section?.type === "element"
          ? section.children.map((id) => {
              const node = frame.layers.nodes.find((candidate) => candidate.id === id);
              return node?.type === "element" ? node.tag : "text";
            })
          : [];
      };
      expect(await sectionOrder()).toEqual(["h1", "p", "span"]);
      const points = await frameHost(page_, "landing").evaluate((host) => {
        const p = host.shadowRoot!.querySelector("p")!.getBoundingClientRect();
        const h1 = host.shadowRoot!.querySelector("h1")!.getBoundingClientRect();
        return {
          from: { x: p.left + 10, y: p.top + p.height / 2 },
          to: { x: h1.left + 10, y: h1.top + 2 },
        };
      });
      await page_.keyboard.down(mod);
      await page_.mouse.click(points.from.x, points.from.y);
      await page_.keyboard.up(mod);
      // A second press within 500 ms and 5 px is a double-click, which would start
      // editing the paragraph's text instead of dragging it.
      await page_.waitForTimeout(600);
      await page_.mouse.move(points.from.x, points.from.y);
      await page_.mouse.down();
      await page_.mouse.move(points.to.x, points.to.y, { steps: 10 });
      await page_.mouse.up();
      await expect.poll(sectionOrder).toEqual(["p", "h1", "span"]);
      await viewport.focus();
      await page_.keyboard.press(process.platform === "darwin" ? "Meta+Z" : "Control+Z");
      await expect.poll(sectionOrder).toEqual(["h1", "p", "span"]);
      // The server holds the undo before this window has drawn it: wait for the DOM too, or
      // the heading's position below would still be the paragraph's.
      await expect
        .poll(() =>
          frameHost(page_, "landing").evaluate((host) =>
            [...host.shadowRoot!.querySelector("section")!.children].map(
              (child: any) => child.localName,
            ),
          ),
        )
        .toEqual(["h1", "p", "span"]);

      // 6e. The layer menu: right-click the heading and duplicate it.
      const headingCount = async () =>
        (await readWork(workId)).pages[0]!.frames[0]!.layers.nodes.filter(
          (node) => node.type === "element" && node.tag === "h1",
        ).length;
      const h1Point = await frameHost(page_, "landing").evaluate((host) => {
        const rect = host.shadowRoot!.querySelector("h1")!.getBoundingClientRect();
        return { x: rect.left + 20, y: rect.top + rect.height / 2 };
      });
      await page_.keyboard.down(mod);
      await page_.mouse.click(h1Point.x, h1Point.y);
      await page_.keyboard.up(mod);
      await page_.mouse.click(h1Point.x, h1Point.y, { button: "right" });
      await page_.getByRole("button", { name: "Duplicate", exact: true }).click();
      await expect.poll(headingCount).toBe(2);
      await viewport.focus();
      await page_.keyboard.press(process.platform === "darwin" ? "Meta+Z" : "Control+Z");
      await expect.poll(headingCount).toBe(1);

      // 7. Frame drag moves and persists; cursor-anchored zoom keeps the point under the cursor.
      const before = (await frameHost(page_, "landing").boundingBox())!;
      const label = page_.locator('[data-canvas-frame-label="landing"]');
      const labelBox = (await label.boundingBox())!;
      await page_.mouse.move(labelBox.x + 10, labelBox.y + labelBox.height / 2);
      await page_.mouse.down();
      await page_.mouse.move(labelBox.x + 90, labelBox.y + labelBox.height / 2 + 60, { steps: 8 });
      await page_.mouse.up();
      await expect
        .poll(async () => (await frameHost(page_, "landing").boundingBox())!.x - before.x)
        .toBeCloseTo(80, 0);
      await expect
        .poll(async () => (await readWork(workId)).pages[0]!.frames[0]!.x)
        .not.toBe(page.frames[0]!.x);
      const moved = (await frameHost(page_, "landing").boundingBox())!;
      const anchor = { x: moved.x + moved.width * 0.3, y: moved.y + moved.height * 0.4 };
      await page_.mouse.move(anchor.x, anchor.y);
      await page_.keyboard.down("Control");
      await page_.mouse.wheel(0, -30);
      await page_.keyboard.up("Control");
      await expect
        .poll(async () => (await frameHost(page_, "landing").boundingBox())!.width)
        .toBeGreaterThan(moved.width);
      const zoomed = (await frameHost(page_, "landing").boundingBox())!;
      expect((anchor.x - zoomed.x) / zoomed.width).toBeCloseTo(0.3, 2);
      expect((anchor.y - zoomed.y) / zoomed.height).toBeCloseTo(0.4, 2);

      // 8. Comments: pin a thread on a layer; the agent reads, replies and resolves it.
      await page_.keyboard.press("c");
      const pin = await frameHost(page_, "landing").evaluate((host) => {
        const rect = host.shadowRoot!.querySelector("p")!.getBoundingClientRect();
        return { x: rect.left + 10, y: rect.top + 5 };
      });
      await page_.mouse.click(pin.x, pin.y);
      await page_.getByPlaceholder("Add a comment").fill("Make this warmer");
      await page_.getByRole("button", { name: "Post", exact: true }).click();
      await expect.poll(async () => (await readWork(workId)).pages[0]!.comments.length).toBe(1);
      const thread = (await readWork(workId)).pages[0]!.comments[0]!;
      expect(thread.layerId).not.toBeNull();
      const listed = await turn([
        { name: "synara_list_canvas_comments", arguments: { workId, pageId } },
        {
          name: "synara_reply_canvas_comment",
          arguments: {
            workId,
            pageId,
            threadId: thread.id,
            messageId: mutationId(),
            text: "Warmed the copy.",
            resolve: true,
          },
        },
      ]);
      expect(json(listed[1]!).threads[0].messages[0].text).toBe("Make this warmer");
      await expect
        .poll(async () => (await readWork(workId)).pages[0]!.comments[0]!.status)
        .toBe("resolved");

      // 9. Agent revision of an existing view keeps identity and placement; restore undoes it.
      work = await readWork(workId);
      page = work.pages[0]!;
      const frame = page.frames[0]!;
      const textLayer = frame.layers.nodes.find(
        (node) => node.type === "text" && node.text === "Made by an agent",
      )!;
      await turn([
        {
          name: "synara_edit_design_layers",
          arguments: {
            workId,
            pageId,
            edit: {
              frameId: "landing",
              expectedRevision: frame.revision,
              mutationId: mutationId(),
              operations: [
                { type: "set_text", nodeId: textLayer.id, text: "Revised by the agent" },
              ],
            },
          },
        },
      ]);
      const revised = (await readWork(workId)).pages[0]!.frames[0]!;
      expect(revised.revision).toBe(frame.revision + 1);
      expect(revised.x).toBe(frame.x);
      expect(revised.layers.roots).toEqual(frame.layers.roots);
      await expect
        .poll(() =>
          frameHost(page_, "landing").evaluate(
            (host) => host.shadowRoot!.querySelector("h1")?.textContent,
          ),
        )
        .toBe("Revised by the agent");

      // 9b. Restore from the turn's chat card puts that frame back as it was before the turn.
      await page_
        .locator(`[data-canvas-turn-card="${workId}"]`)
        .last()
        .getByRole("button", { name: "Restore previous version" })
        .click();
      await page_.getByRole("button", { name: "Restore", exact: true }).click();
      await expect
        .poll(async () =>
          JSON.stringify((await readWork(workId)).pages[0]!.frames[0]!.layers).includes(
            "Revised by the agent",
          ),
        )
        .toBe(false);
      await expect
        .poll(() =>
          frameHost(page_, "landing").evaluate(
            (host) => host.shadowRoot!.querySelector("h1")?.textContent,
          ),
        )
        .toBe("Made by an agent");

      // 10. Recovery after reopening: frames and positions come back, and the page's stored
      // camera is untouched (panning and zooming stay in this client's own camera).
      const camera = (await readWork(workId)).pages[0]!.viewport;
      await page_.reload();
      await frameHost(page_, "landing").waitFor({ timeout: 30_000 });
      const reopened = (await readWork(workId)).pages[0]!;
      expect(reopened.viewport).toEqual(camera);
      expect(reopened.frames.map((item) => item.id)).toEqual(["landing", "hostile"]);
      expect(outbound).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await page_.screenshot({ path: path.join(home, "canvas-e2e-final.png") }).catch(() => {});
      await browser.close();
      recorder.close();
    }
  },
  240_000,
);

/** The golden-sequence card: Card → heading, text, Actions → Primary and Secondary buttons. */
const GOLDEN_CARD_HTML =
  '<div data-name="Card" style="display:flex;flex-direction:column;gap:12px;padding:16px;border-radius:12px;background:#f4f4f5">' +
  "<h2>Pro plan</h2><p>Everything in Basic, plus unlimited projects.</p>" +
  '<div data-name="Actions" style="display:flex;gap:8px">' +
  '<button data-name="Primary" style="padding:8px 16px"><span>Upgrade</span></button>' +
  '<button data-name="Secondary"><span>Later</span></button>' +
  "</div></div>";

it.skipIf(!origin)(
  "passes the golden sequence: a restyle by layer ID keeps every ID, the tree and the window's other DOM nodes",
  async () => {
    const { home, web } = requireIsolatedEnvironment();
    await using rpc = await workspaceRpc(origin!);
    const { threadId, turn } = await startAgentThread(rpc, home);
    const workId = `work_${randomUUID().replaceAll("-", "")}`;
    const page = { workId, pageId: "page-main" };
    const readFrame = async () =>
      (await rpc.request<CanvasWork>("canvas.get", { workId })).pages[0]!.frames[0]!;

    // 1. A new 390×320 frame and one write of the whole card.
    const built = await turn([
      { name: "synara_create_canvas", arguments: { id: workId, title: "Golden sequence" } },
      {
        name: "synara_put_canvas_view",
        arguments: {
          ...page,
          frame: {
            id: "card",
            title: "Card",
            html: "",
            style: "background:#ffffff;padding:16px",
            width: 390,
            height: 320,
            expectedRevision: 0,
          },
        },
      },
      {
        name: "synara_edit_design_layers",
        arguments: {
          ...page,
          edit: {
            frameId: "card",
            mutationId: mutationId(),
            operations: [{ type: "insert_html", parentId: null, html: GOLDEN_CARD_HTML }],
          },
        },
      },
    ]);
    // 8 elements, plus the 4 text layers their labels hold.
    const inserted = json(built[3]!);
    expect(inserted).toMatchObject({ frameId: "card", revision: 2, dropped: [] });
    expect(inserted.createdNodeIds).toHaveLength(12);
    const before = await readFrame();
    const named = (name: string) =>
      before.layers.nodes.find(
        (node) => node.type === "element" && node.attributes["data-name"] === name,
      )!;
    const primary = named("Primary");

    // 2. The window the user has open on that work.
    const { browser, page: window_, errors } = await launchCanvasBrowser(home);
    const restyleId = mutationId();
    const deltas: string[] = [];
    /** Agent activity the window was told about for this work: kinds, and "ended". */
    const activity: string[] = [];
    let workReads = 0;
    window_.on("websocket", (socket) => {
      socket.on("framesent", ({ payload }) => {
        if (String(payload).includes('"tag":"canvas.get"')) workReads++;
      });
      socket.on("framereceived", ({ payload }) => {
        const text = String(payload);
        if (text.includes(restyleId) && text.includes('"delta"')) deltas.push(text);
        if (text.includes('"type":"activity"') && text.includes(workId))
          for (const match of text.matchAll(/"kind":"(read|write|edit|delete)"|"ended":true/g))
            activity.push(match[1] ?? "ended");
      });
    });
    try {
      await window_.goto(`${web}/canvas/${workId}?chat=${threadId}`);
      await frameHost(window_, "card").waitFor({ timeout: 90_000 });
      await expect
        .poll(() =>
          frameHost(window_, "card").evaluate(
            (host, id) => Boolean(host.shadowRoot?.querySelector(`[data-synara-layer-id="${id}"]`)),
            primary.id,
          ),
        )
        .toBe(true);
      // Keep a reference to every node the window rendered for the frame.
      const rendered = await frameHost(window_, "card").evaluate((host) => {
        const win = globalThis as any;
        // The renderer's root: the shadow root holds the frame stylesheet, then this div.
        const root = [...host.shadowRoot!.children].find(
          (child: any) => child.localName === "div",
        )!;
        const elements = [...root.querySelectorAll("[data-synara-layer-id]")];
        const texts: unknown[] = [];
        const walker = win.document.createTreeWalker(root, win.NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) texts.push(walker.currentNode);
        win.__golden = { root, elements, texts };
        return {
          elements: elements.map((element: any) => element.getAttribute("data-synara-layer-id")),
          texts: texts.length,
        };
      });
      expect(rendered.elements).toHaveLength(8);
      expect(rendered.texts).toBe(4);

      // 3. One agent turn: read the tree, find the button, a batch with an unknown layer
      // (the whole batch is refused and the error names the operation), the restyle alone without a revision, the tree again and a screenshot of it.
      workReads = 0;
      const restyle = {
        "background-color": "#174039",
        "border-radius": "8px",
        cursor: "pointer",
        color: "#ffffff",
      };
      const edited = await turn([
        { name: "synara_read_design_layers", arguments: { ...page, frameId: "card" } },
        { name: "synara_find_design_layers", arguments: { ...page, name: "Primary" } },
        {
          name: "synara_edit_design_layers",
          arguments: {
            ...page,
            edit: {
              frameId: "card",
              mutationId: mutationId(),
              operations: [
                { type: "set_styles", nodeId: primary.id, styles: restyle },
                { type: "set_styles", nodeId: "unknown-layer", styles: { color: "red" } },
              ],
            },
          },
          expectedError: "operations[1] (set_styles on layer unknown-layer) was refused",
        },
        {
          name: "synara_edit_design_layers",
          arguments: {
            ...page,
            edit: {
              frameId: "card",
              mutationId: restyleId,
              operations: [{ type: "set_styles", nodeId: primary.id, styles: restyle }],
            },
          },
        },
        { name: "synara_read_design_layers", arguments: { ...page, frameId: "card" } },
        {
          name: "synara_screenshot_canvas",
          arguments: { ...page, frameId: "card", layerId: primary.id, scale: 2 },
        },
      ]);
      const treeOf = (result: McpResult) => result.body.result.content[0]!.text!;
      const treeBefore = treeOf(edited[1]!);
      const treeAfter = treeOf(edited[5]!);
      expect(treeBefore).toContain("revision 2, 12 layers");
      expect(treeBefore).toContain("measured by an open Synara window");
      expect(treeBefore).toMatch(new RegExp(`button "Primary" ${primary.id} \\d+×\\d+`));
      expect(treeAfter).toContain("revision 3, 12 layers");
      // Same layers, IDs, order, parents and measured sizes: only the revision moved.
      expect(treeAfter.split("\n").slice(1)).toEqual(treeBefore.split("\n").slice(1));
      expect(json(edited[2]!)).toMatchObject({
        total: 1,
        matches: [{ frameId: "card", layerId: primary.id, tag: "button" }],
      });
      // The refused batch left nothing behind: the restyle alone is revision 3.
      expect(json(edited[4]!)).toMatchObject({ revision: 3, createdNodeIds: [], dropped: [] });
      const image = edited[6]!.body.result.content.find((item) => item.type === "image");
      expect(image?.data?.length ?? 0).toBeGreaterThan(500);
      await fs.writeFile(
        path.join(home, "golden-primary@2x.png"),
        Buffer.from(image!.data!, "base64"),
      );

      // 4. The stored model: every layer kept its ID, order, parent and content; only the
      // button's style changed.
      const after = await readFrame();
      expect(after.revision).toBe(3);
      expect(after.layers.roots).toEqual(before.layers.roots);
      expect(after.layers.nodes.map((node) => node.id)).toEqual(
        before.layers.nodes.map((node) => node.id),
      );
      for (const node of after.layers.nodes) {
        const previous = before.layers.nodes.find((candidate) => candidate.id === node.id)!;
        if (node.id !== primary.id) {
          expect(node).toEqual(previous);
          continue;
        }
        expect(node.type === "element" && node.children).toEqual(
          previous.type === "element" && previous.children,
        );
        const style = node.type === "element" ? (node.attributes.style ?? "") : "";
        expect(style.startsWith("padding:8px 16px;")).toBe(true);
        expect(style).toContain("background-color:#174039");
        expect(style).toContain("color:#ffffff");
      }

      // 5. The open window patched the button in place: every node it rendered before the
      // turn is the same DOM object after it, and the event that told it carried the delta.
      await expect
        .poll(() =>
          frameHost(window_, "card").evaluate(
            (host, id) =>
              (globalThis as any).getComputedStyle(
                host.shadowRoot!.querySelector(`[data-synara-layer-id="${id}"]`),
              ).backgroundColor,
            primary.id,
          ),
        )
        .toBe("rgb(23, 64, 57)");
      const identity = await frameHost(window_, "card").evaluate((host) => {
        const win = globalThis as any;
        const golden = win.__golden;
        // The renderer's root: the shadow root holds the frame stylesheet, then this div.
        const root = [...host.shadowRoot!.children].find(
          (child: any) => child.localName === "div",
        )!;
        const texts: unknown[] = [];
        const walker = win.document.createTreeWalker(root, win.NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) texts.push(walker.currentNode);
        return {
          root: root === golden.root,
          elements: golden.elements.map((element: any) => {
            const id = element.getAttribute("data-synara-layer-id");
            return {
              id,
              same: root.querySelector(`[data-synara-layer-id="${id}"]`) === element,
              connected: element.isConnected,
            };
          }),
          texts:
            texts.length === golden.texts.length &&
            texts.every((text, index) => text === golden.texts[index]),
        };
      });
      expect(identity.root).toBe(true);
      expect(identity.elements).toEqual(
        rendered.elements.map((id) => ({ id, same: true, connected: true })),
      );
      expect(identity.texts).toBe(true);
      expect(deltas.length).toBeGreaterThan(0);
      // The reads and the edit showed as agent activity, cleared when the turn ended.
      expect(activity).toEqual(expect.arrayContaining(["read", "edit"]));
      await expect.poll(() => activity.includes("ended"), { timeout: 10_000 }).toBe(true);
      // A record of the run beside the screenshots, for review.
      await fs.writeFile(
        path.join(home, "golden-report.json"),
        JSON.stringify(
          {
            layerIds: rendered.elements,
            textNodes: rendered.texts,
            treeBefore,
            treeAfter,
            deltaEvents: deltas.length,
            activity,
            // The window's work reads during the turn: its answers to render and measure requests.
            workReads,
          },
          null,
          2,
        ),
      );
      expect(errors).toEqual([]);
    } finally {
      await window_.screenshot({ path: path.join(home, "golden-final.png") }).catch(() => {});
      await browser.close();
    }
  },
  240_000,
);
