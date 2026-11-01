// Diagnostic only: native installed Chrome, fresh profile, no execution of downloads.
// Playwright connectOverCDP(noDefaults:true) deliberately leaves native download
// handling intact; do not replace this with launch() or acceptDownloads:true.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const ASSET =
  "https://github.com/Emanuele-web04/synara/releases/download/v1.0.9/Synara-1.0.9-x64.exe";
const RELEASE = "https://github.com/Emanuele-web04/synara/releases/expanded_assets/v1.0.9";
const FILE = "Synara-1.0.9-x64.exe";
const EXPECTED = "d8a0d6bd3bbc6e9128cbf40d0b63262b3a516221c25e017452bc6b4c94ebabc5";
const evidence = path.resolve(process.argv[2] ?? "browser-defender-evidence");
await mkdir(evidence, { recursive: true });
const result = {
  startedAt: new Date().toISOString(),
  phase: process.env.PROBE_PHASE ?? "unspecified",
  expectedSignatureVersion: process.env.PROBE_EXPECTED_SIGNATURE_VERSION ?? null,
  platform: process.platform,
  osRelease: os.release(),
  nodeVersion: process.version,
  assetUrl: ASSET,
  expectedSha256: EXPECTED,
  executionAttempted: false,
  protectionBypassed: false,
  browserSecurityStateVerified: false,
  limits: [
    "Windows Server 2022 hosted-runner observation; not a Windows 11 consumer reproduction.",
    "Fresh unsigned-in Chrome profile; browser first-run UX skipped, security settings unchanged.",
    "Initial hosted-image definitions are not reconstructed historical user definitions. Automatic signature changes are reported by the workflow, not prevented.",
    "The latest-definition repeat follows the initial download and a guard scan of the same hash; service caching may affect the comparison.",
    "No Keep, Unblock, Open or Run action is performed. A withheld download stays withheld.",
    "Defender cloud guard connectivity does not by itself prove a Safe Browsing service verdict.",
    "Confirm active Safe Browsing using the captured Chrome security controls and policies; this probe does not infer it from a successful download.",
    "Matching bytes alone do not prove Safe Browsing or Defender accepted the download.",
    "Read history together with the pre-close downloads UI: shutdown may interrupt unfinished downloads.",
  ],
};
const redactUrl = (value) =>
  typeof value === "string"
    ? value.replace(/(https?:\/\/[^\s"<>?]+)\?[^\s"<>]*/g, "$1?[query omitted]")
    : value;
async function json(name, value) {
  await writeFile(
    path.join(evidence, name),
    JSON.stringify(
      value,
      (_, item) =>
        typeof item === "bigint"
          ? item.toString()
          : typeof item === "string"
            ? redactUrl(item)
            : item,
      2,
    ),
  );
}
async function capturePage(page, name) {
  try {
    const observed = await page.evaluate(() => {
      const roots = [document];
      const text = [];
      const controls = [];
      const downloadItems = [];
      for (let i = 0; i < roots.length; i++) {
        const root = roots[i];
        const body = root === document ? document.body : root;
        text.push(body?.innerText ?? body?.textContent ?? "");
        for (const element of root.querySelectorAll("*")) {
          if (element.shadowRoot) roots.push(element.shadowRoot);
          if (element.matches("downloads-item") && element.data) {
            const fields = [
              "id",
              "state",
              "dangerType",
              "fileName",
              "filePath",
              "url",
              "lastReasonText",
              "percent",
              "fileExternallyRemoved",
            ];
            downloadItems.push(Object.fromEntries(fields.map((key) => [key, element.data[key]])));
          }
          if (element.matches('input, [role="switch"], [role="checkbox"], cr-toggle')) {
            controls.push({
              tag: element.tagName,
              id: element.id,
              label: element.getAttribute("aria-label"),
              checked: element.checked,
              ariaChecked: element.getAttribute("aria-checked"),
              disabled: element.disabled,
            });
          }
        }
      }
      return {
        url: location.href,
        title: document.title,
        text: text.join("\n").slice(0, 150000),
        controls,
        downloadItems,
      };
    });
    await json(`${name}.json`, observed);
    await page.screenshot({ path: path.join(evidence, `${name}.png`), timeout: 15000 });
  } catch (error) {
    await json(`${name}-error.json`, { error: String(error) });
  }
}
async function fileInventory(directory) {
  return Promise.all(
    (await readdir(directory, { withFileTypes: true }))
      .filter((e) => e.isFile())
      .map(async (e) => {
        const info = await stat(path.join(directory, e.name)).catch(() => null);
        return { name: e.name, bytes: info?.size ?? null };
      }),
  );
}
// Read only files in this invocation's dedicated download folder. Hash temporary
// .crdownload files while Chrome still owns them: closing can remove a held file.
async function hashDownloadFiles(directory) {
  const files = (await fileInventory(directory)).filter((file) =>
    /\.(exe|crdownload|tmp)$/i.test(file.name),
  );
  const captured = [];
  for (const entry of files) {
    const file = path.join(directory, entry.name);
    const observation = { name: entry.name, capturedAt: new Date().toISOString() };
    try {
      const before = await stat(file);
      const hash = createHash("sha256");
      let bytesRead = 0;
      for await (const chunk of createReadStream(file)) {
        hash.update(chunk);
        bytesRead += chunk.length;
      }
      const after = await stat(file);
      Object.assign(observation, {
        bytesRead,
        sizeBefore: before.size,
        sizeAfter: after.size,
        stableDuringRead: before.size === after.size && before.mtimeMs === after.mtimeMs,
        sha256: hash.digest("hex"),
      });
      observation.matchesExpected = observation.stableDuringRead && observation.sha256 === EXPECTED;
      observation.zoneIdentifier = await readFile(`${file}:Zone.Identifier`, "utf8").catch(
        (error) => `Unavailable: ${error.code}`,
      );
    } catch (error) {
      observation.error = String(error);
    }
    captured.push(observation);
  }
  return captured;
}

let child, browser, browserSession, root;
try {
  if (
    process.platform !== "win32" ||
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.RUNNER_ENVIRONMENT !== "github-hosted"
  ) {
    throw new Error("This probe is restricted to disposable GitHub-hosted Windows runners.");
  }
  const require = createRequire(import.meta.url);
  const packageInfo = require("playwright-core/package.json");
  if (packageInfo.version !== "1.62.1")
    throw new Error(`Expected playwright-core 1.62.1, got ${packageInfo.version}`);
  result.playwrightVersion = packageInfo.version;
  const { chromium } = await import("playwright-core");
  const candidates = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles]
    .filter(Boolean)
    .map((base) => path.join(base, "Google", "Chrome", "Application", "chrome.exe"));
  let executable;
  for (const candidate of candidates)
    if (await stat(candidate).catch(() => null)) {
      executable = candidate;
      break;
    }
  if (!executable) throw new Error("Installed native Google Chrome was not found.");
  root = await mkdtemp(
    path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), "synara-chrome-download-"),
  );
  const profile = path.join(root, "profile");
  const downloads = path.join(root, "downloads");
  await mkdir(path.join(profile, "Default"), { recursive: true });
  await mkdir(downloads);
  // Only the destination changes. No safety, reputation, PUA, certificate,
  // download acceptance or auto-open preference is written.
  await writeFile(
    path.join(profile, "Default", "Preferences"),
    JSON.stringify({ download: { default_directory: downloads } }),
  );
  const args = [
    `--user-data-dir=${profile}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ];
  Object.assign(result, {
    executable,
    launchArgs: args,
    profile,
    downloads,
    attachOptions: { noDefaults: true, isLocal: true },
    headless: false,
  });
  child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: false });
  result.chromePid = child.pid;
  let spawnError;
  child.on("error", (error) => {
    spawnError = error;
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      output = (output + chunk).slice(-50000);
    });
  const portFile = path.join(profile, "DevToolsActivePort");
  let endpoint;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (spawnError) throw spawnError;
    const port = (await readFile(portFile, "utf8").catch(() => "")).split(/\r?\n/)[0];
    if (/^\d+$/.test(port) && Number(port) > 0) {
      endpoint = `http://127.0.0.1:${port}`;
      break;
    }
    if (child.exitCode !== null)
      throw new Error(`Chrome exited before CDP was ready: ${child.exitCode}; ${output}`);
    await delay(500);
  }
  if (!endpoint) throw new Error(`Native Chrome CDP startup timed out: ${output}`);
  browser = await chromium.connectOverCDP(endpoint, {
    noDefaults: true,
    isLocal: true,
    timeout: 30000,
  });
  result.chromeVersion = browser.version();
  browserSession = await browser.newBrowserCDPSession();
  const context = browser.contexts()[0];
  if (!context) throw new Error("Native default context unavailable.");
  context.setDefaultTimeout(15000);
  const page = context.pages()[0] ?? (await context.newPage());
  for (const [name, url] of [
    ["chrome-version", "chrome://version"],
    ["chrome-policy", "chrome://policy"],
    ["chrome-security", "chrome://settings/security"],
  ]) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await delay(1000);
    await capturePage(page, name);
  }
  const responses = [];
  page.on("response", (response) => {
    if (/github\.com|githubusercontent\.com/i.test(response.url())) {
      responses.push({ url: redactUrl(response.url()), status: response.status() });
    }
  });
  // A real click on GitHub's public asset list supplies the normal user gesture.
  // If GitHub or Chrome blocks navigation, preserve the error; do not use an HTTP fallback.
  await page.goto(RELEASE, { waitUntil: "domcontentloaded", timeout: 60000 });
  const link = page.locator(`a[href$="/${FILE}"]`).first();
  await link.waitFor({ state: "visible", timeout: 30000 });
  const href = await link.getAttribute("href");
  const resolved = new URL(href, page.url());
  if (resolved.href.toLowerCase() !== ASSET.toLowerCase())
    throw new Error(`Unexpected asset link: ${resolved.href}`);
  result.downloadTriggeredAt = new Date().toISOString();
  await link.click({ noWaitAfter: true });
  const downloadsPage = await context.newPage();
  await downloadsPage.goto("chrome://downloads/", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  result.inventorySamples = [];
  // Up to 150 seconds for native scanning/reputation UI. No CDP setDownloadBehavior,
  // Download.saveAs/path or warning-acceptance API participates in the download.
  let stableSince = null,
    previous = "";
  for (let attempt = 0; attempt < 50; attempt++) {
    await delay(3000);
    const files = await fileInventory(downloads);
    result.inventorySamples.push({ at: new Date().toISOString(), files });
    const current = JSON.stringify(files);
    stableSince = current === previous ? (stableSince ?? Date.now()) : null;
    previous = current;
    if (
      files.some((file) => file.name === FILE) &&
      stableSince !== null &&
      Date.now() - stableSince >= 15000
    )
      break;
  }
  await capturePage(downloadsPage, "downloads-before-close");
  await capturePage(page, "initiator-after-download");
  await json("network-responses.json", responses);
  result.filesBeforeClose = await fileInventory(downloads);
  result.preCloseHashes = await hashDownloadFiles(downloads);
  await json("download-files-before-close.json", result.preCloseHashes);
  result.probeCompleted = true;
} catch (error) {
  result.error = String(error?.stack ?? error);
  process.exitCode = 1;
} finally {
  if (root && !result.preCloseHashes) {
    try {
      result.preCloseHashes = await hashDownloadFiles(path.join(root, "downloads"));
      await json("download-files-before-close.json", result.preCloseHashes);
    } catch (error) {
      result.preCloseHashError = String(error);
    }
  }
  if (browserSession) {
    try {
      await browserSession.send("Browser.close");
      result.closeRequested = true;
    } catch (error) {
      result.closeError = String(error);
    }
  }
  if (browser) await browser.close().catch(() => {});
  if (child) {
    for (let attempt = 0; child.exitCode === null && attempt < 20; attempt++) await delay(500);
    result.chromeExitCode = child.exitCode;
    // Never kill by image name: only this probe's fresh-profile process tree.
    if (child.exitCode === null && child.pid) {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      });
      result.forcedCleanup = await new Promise((resolve) => {
        killer.once("error", (error) => resolve(String(error)));
        killer.once("exit", (code) => resolve(code));
      });
    }
  }
  if (root) {
    const profile = path.join(root, "profile");
    try {
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(path.join(profile, "Default", "History"), { readOnly: true });
      try {
        const present = new Set(
          db
            .prepare("PRAGMA table_info(downloads)")
            .all()
            .map((row) => row.name),
        );
        const wanted = [
          "id",
          "guid",
          "current_path",
          "target_path",
          "received_bytes",
          "total_bytes",
          "state",
          "danger_type",
          "interrupt_reason",
          "opened",
          "mime_type",
          "tab_url",
          "referrer",
        ];
        const fields = wanted.filter((field) => present.has(field));
        result.downloadHistory = db.prepare(`SELECT ${fields.join(", ")} FROM downloads`).all();
        result.historyStateLabels = {
          0: "in-progress",
          1: "complete",
          2: "cancelled",
          3: "interrupted",
        };
        result.selectedInterruptReasonLabels = {
          7: "FILE_VIRUS_INFECTED",
          11: "FILE_BLOCKED",
          12: "FILE_SECURITY_CHECK_FAILED",
          40: "USER_CANCELED",
          41: "USER_SHUTDOWN",
          50: "CRASH",
        };
        // Keep raw codes and live UI. Reason 7 does not name the antivirus vendor.
      } finally {
        db.close();
      }
    } catch (error) {
      result.historyError = String(error);
    }
    try {
      const prefs = JSON.parse(
        await readFile(path.join(profile, "Default", "Preferences"), "utf8"),
      );
      result.persistedProtectionPreferences = {
        download: prefs.download,
        safebrowsing: prefs.safebrowsing,
      };
    } catch (error) {
      result.preferencesError = String(error);
    }
    const file = path.join(root, "downloads", FILE);
    try {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(file)) hash.update(chunk);
      result.actualSha256 = hash.digest("hex");
      result.fileBytes = (await stat(file)).size;
      result.fileMatchesExpected = result.actualSha256 === EXPECTED;
      result.zoneIdentifier = await readFile(`${file}:Zone.Identifier`, "utf8").catch(
        (error) => `Unavailable: ${error.code}`,
      );
      if (!result.fileMatchesExpected) process.exitCode = 1;
    } catch (error) {
      result.finalFileError = String(error);
      result.fileMatchesExpected = false;
    }
    result.matchingPreCloseFile =
      result.preCloseHashes?.some((file) => file.matchesExpected) ?? false;
    result.observation = result.fileMatchesExpected
      ? "matching-file-retained"
      : "no-matching-final-file";
  }
  result.finishedAt = new Date().toISOString();
  await json("browser-result.json", result);
  console.log(
    JSON.stringify(
      {
        probeCompleted: result.probeCompleted ?? false,
        observation: result.observation,
        actualSha256: result.actualSha256,
        error: result.error,
        evidence,
      },
      null,
      2,
    ),
  );
}
