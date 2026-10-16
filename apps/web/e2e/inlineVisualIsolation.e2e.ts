import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { _electron as electron, expect, test, type ElectronApplication } from "playwright/test";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP_DIR = resolve(WEB_DIR, "../desktop");
const requireFromDesktop = createRequire(resolve(DESKTOP_DIR, "package.json"));

interface Records {
  webviewAttachAttempts: string[];
  webviewGuests: string[];
  subframeNavigations: Array<{ url: string; isMainFrame: boolean }>;
}

/** Records every request, so a page that reaches the network is caught by what it sent. */
async function startRecorder(): Promise<{ server: Server; origin: string; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.writeHead(200, { "content-type": "text/plain" }).end("ok");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return { server, origin: `http://127.0.0.1:${port}`, requests };
}

async function launch() {
  const mainPath = process.env.SYNARA_E2E_INLINE_VISUAL_MAIN;
  const annotationPreloadPath = process.env.SYNARA_E2E_BROWSER_ANNOTATION_PRELOAD;
  if (!mainPath || !annotationPreloadPath) {
    throw new Error("Inline visual E2E bundles were not prepared.");
  }
  const recorder = await startRecorder();
  const home = mkdtempSync(
    join(process.platform === "darwin" ? "/tmp" : tmpdir(), "synara-visuals-"),
  );
  const application = await electron.launch({
    executablePath: requireFromDesktop("electron") as string,
    args: [mainPath],
    cwd: DESKTOP_DIR,
    env: {
      ...process.env,
      HOME: home,
      SYNARA_HOME: home,
      SYNARA_E2E_BROWSER_ANNOTATION_PRELOAD: annotationPreloadPath,
      SYNARA_E2E_RECORDER_ORIGIN: recorder.origin,
    },
  });
  const page = await application.firstWindow();
  await page.waitForFunction(
    () => typeof (window as { showVisual?: unknown }).showVisual === "function",
  );
  const records = () =>
    application.evaluate(
      () => (globalThis as unknown as { inlineVisualRecords: Records }).inlineVisualRecords,
    );
  const probe = (name: string) =>
    page
      .waitForFunction(
        (probeName) =>
          (window as unknown as { probes: Array<Record<string, unknown>> }).probes.find(
            (entry) => entry.probe === probeName,
          ) ?? null,
        name,
        { timeout: 15_000 },
      )
      .then((handle) => handle.jsonValue() as Promise<Record<string, unknown>>);
  const close = async () => {
    await closeApplication(application);
    recorder.server.close();
    rmSync(home, { recursive: true, force: true });
  };
  return { page, records, probe, recorder, close, application };
}

async function closeApplication(application: ElectronApplication) {
  const closing = application.close().catch(() => {});
  const timeout = new Promise<"timeout">((done) =>
    setTimeout(() => done("timeout"), 5_000).unref(),
  );
  if ((await Promise.race([closing, timeout])) === "timeout") application.process().kill("SIGKILL");
}

test("a visual cannot create a webview, even with the in-app browser's partition", async () => {
  const app = await launch();
  try {
    await app.page.evaluate(() =>
      (window as unknown as { showVisual: (name: string) => void }).showVisual("webview"),
    );
    const result = await app.probe("webview");

    // Control: the app's own document can still attach a webview, so the
    // checks below would see one.
    await app.page.evaluate(() =>
      (window as unknown as { showControlWebview: () => void }).showControlWebview(),
    );
    await expect.poll(async () => (await app.records()).webviewGuests.length).toBe(1);

    // In the frame the tag is an inert element: no webview definition, no
    // guest API, no attach request to the main process, no guest contents.
    expect(result.definedInFrame).toBe("undefined");
    expect(result.hasGuestApi).toBe("undefined");
    const records = await app.records();
    expect(records.webviewAttachAttempts).toEqual(["about:blank"]);
    expect(app.recorder.requests.filter((url) => url.includes("via=webview"))).toEqual([]);
  } finally {
    await app.close();
  }
});

test("a visual cannot navigate its own frame away; fetches are refused separately by policy", async () => {
  const app = await launch();
  try {
    // The recorder is reachable from this machine: a page that got a request
    // out would show up here.
    expect(await fetch(`${app.recorder.origin}/control`).then((response) => response.status)).toBe(
      200,
    );

    for (const name of ["scriptNavigation", "metaRefresh", "fetch"]) {
      await app.page.evaluate(
        (visual) =>
          (window as unknown as { showVisual: (name: string) => void }).showVisual(visual),
        name,
      );
    }
    const scripted = await app.probe("script-navigation");
    const refreshed = await app.probe("meta-refresh");
    const fetched = await app.probe("fetch");

    // Navigation: attempted, refused by the main process, page still in place.
    expect(scripted.stillHere).toBe("about:srcdoc");
    expect(refreshed.stillHere).toBe("about:srcdoc");
    const navigations = (await app.records()).subframeNavigations.map((entry) => entry.url);
    expect(navigations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("via=location"),
        expect.stringContaining("via=refresh"),
      ]),
    );
    // Fetch: refused by the frame's content security policy, never sent.
    expect(fetched.fetched).toBe("TypeError");
    expect(app.recorder.requests).toEqual(["/control"]);
  } finally {
    await app.close();
  }
});

test("a visual that blocks its own thread does not freeze the app window", async () => {
  const app = await launch();
  try {
    await app.page.evaluate(() =>
      (window as unknown as { showVisual: (name: string) => void }).showVisual("busy"),
    );
    const started = (await app.probe("busy-start")).at as number;
    const ended = (await app.probe("busy-end")).at as number;
    const frames = await app.application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.webContents.mainFrame.framesInSubtree.map((frame) => ({
        url: frame.url,
        processId: frame.osProcessId,
      })),
    );
    const beats = await app.page.evaluate(() => (window as unknown as { beats: number[] }).beats);
    const during = beats.filter((at) => at > started + 200 && at < ended - 200);
    const longestGap = Math.max(...during.slice(1).map((at, index) => at - during[index]!));

    // The page really blocked for three seconds...
    expect(ended - started).toBeGreaterThan(2_500);
    // ...while the app document kept its 20 ms heartbeat.
    expect(during.length).toBeGreaterThan(50);
    expect(longestGap).toBeLessThan(500);
    // Recorded for the delivery report: which processes host the frames.
    console.log(`inline-visual frames: ${JSON.stringify(frames)}`);
  } finally {
    await app.close();
  }
});
