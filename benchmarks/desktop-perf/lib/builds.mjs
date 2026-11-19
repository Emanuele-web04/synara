// Resolves a build name to a built checkout under the bench root and creates the
// two data-home templates. Nothing here writes inside the repository being measured.
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sleep } from "./cdp.mjs";
import { dismissAnnouncements, openThreadFromSidebar } from "./drive.mjs";
import {
  BENCH_ROOT,
  assertIsolatedHome,
  attachMainPage,
  freePort,
  launchDesktop,
  quitDesktop,
} from "./launch.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "../../..");
export const BUILDS_DIR = join(BENCH_ROOT, "builds");
// A template set is one pair of data homes created by one build. Builds with a different
// database schema need their own set: an older build cannot open a newer database, and a
// newer build would spend each sample's first launch migrating an older one.
let templateSet = "default";
export const useTemplateSet = (name) => (templateSet = name);
export const currentTemplateSet = () => templateSet;
const templatesDir = () => join(BENCH_ROOT, "templates", templateSet);
export const WORKSPACES_DIR = join(BENCH_ROOT, "workspaces");
export const HOMES_DIR = join(BENCH_ROOT, "homes");
export const LAST_ROUTE_THREAD = "seed-thread-small-001";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status})\n${(result.stderr || result.stdout || "").slice(-3000)}`,
    );
  }
  return result.stdout.trim();
}

export function buildName(ref) {
  return ref.replace(/^origin\//, "").replace(/[^A-Za-z0-9._-]+/g, "-");
}

export function buildInfo(name) {
  const dir = join(BUILDS_DIR, name);
  if (!existsSync(join(dir, "apps/desktop/dist-electron/main.js"))) {
    throw new Error(
      `Build "${name}" is not prepared. Run: node benchmarks/desktop-perf/prepare.mjs --ref <git ref> [--name ${name}]`,
    );
  }
  const meta = JSON.parse(readFileSync(join(dir, ".bench-build.json"), "utf8"));
  return { name, dir, ...meta };
}

/** Checks out `ref` into the bench root, installs, and builds the source desktop app. */
export function prepareBuild(ref, name = buildName(ref), { log = console.log } = {}) {
  mkdirSync(BUILDS_DIR, { recursive: true });
  const dir = join(BUILDS_DIR, name);
  const commit = run("git", ["-C", REPO_ROOT, "rev-parse", ref]);
  if (!existsSync(dir)) {
    log(`[prepare] checking out ${ref} (${commit.slice(0, 12)}) into ${dir}`);
    run("git", ["-C", REPO_ROOT, "worktree", "add", "--detach", dir, commit]);
  } else {
    const current = run("git", ["-C", dir, "rev-parse", "HEAD"]);
    if (current !== commit) {
      log(`[prepare] moving ${name} from ${current.slice(0, 12)} to ${commit.slice(0, 12)}`);
      run("git", ["-C", dir, "checkout", "--detach", commit]);
      rmSync(join(dir, ".bench-build.json"), { force: true });
    }
  }
  const metaPath = join(dir, ".bench-build.json");
  if (existsSync(metaPath) && JSON.parse(readFileSync(metaPath, "utf8")).commit === commit) {
    log(`[prepare] ${name} already built at ${commit.slice(0, 12)}`);
    return buildInfo(name);
  }
  const env = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    USER: process.env.USER,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG ?? "en_US.UTF-8",
  };
  log("[prepare] bun install");
  run("bun", ["install", "--frozen-lockfile"], { cwd: dir, env });
  log("[prepare] bun run build:desktop");
  run("bun", ["run", "build:desktop"], { cwd: dir, env });
  if (process.platform === "darwin") {
    // `bun run start` builds these two native helpers before launching; do the same so
    // the measured app has the same window material and AppSnap helper as a real launch.
    log("[prepare] building macOS helpers");
    run(
      "bun",
      [
        "-e",
        `const a = await import("./scripts/build-appsnap-helper.mjs"); const b = await import("./scripts/build-window-material-addon.mjs"); a.buildAppSnapHelper({ arch: process.arch }); b.buildWindowMaterialAddon({ arch: process.arch });`,
      ],
      { cwd: join(dir, "apps/desktop"), env },
    );
  }
  const version = JSON.parse(readFileSync(join(dir, "apps/desktop/package.json"), "utf8")).version;
  writeFileSync(
    metaPath,
    `${JSON.stringify({ ref, commit, version, buildType: "source build (bun run build:desktop, unpackaged Electron)", builtAt: new Date().toISOString() }, null, 2)}\n`,
  );
  return buildInfo(name);
}

export function templatePaths(kind) {
  const root = join(templatesDir(), kind);
  return {
    root,
    home: join(root, "home"),
    profile: join(root, "profile"),
    meta: join(root, "template.json"),
  };
}

export function templateInfo(kind) {
  const paths = templatePaths(kind);
  if (!existsSync(paths.meta))
    throw new Error(
      `Template "${kind}" of set "${templateSet}" is missing. Run prepare.mjs with --templates [--template-set ${templateSet}].`,
    );
  return { ...paths, ...JSON.parse(readFileSync(paths.meta, "utf8")) };
}

/**
 * Every launch, including the ones that create the templates, runs from this one path.
 * The app keys some first-run state by the data home's absolute path, so a template
 * restored to a different path would show announcements again.
 */
export const ACTIVE_ROOT = join(HOMES_DIR, "active");
const activeHome = (template) => ({
  root: ACTIVE_ROOT,
  home: join(ACTIVE_ROOT, "home"),
  profile: join(ACTIVE_ROOT, "profile"),
  template,
});

/** Restores a template into the active path for one sample; the template itself is never launched. */
export function freshHomeFromTemplate(kind) {
  const template = templateInfo(kind);
  assertIsolatedHome(ACTIVE_ROOT);
  rmSync(ACTIVE_ROOT, { recursive: true, force: true });
  mkdirSync(ACTIVE_ROOT, { recursive: true });
  cpSync(template.home, join(ACTIVE_ROOT, "home"), { recursive: true });
  cpSync(template.profile, join(ACTIVE_ROOT, "profile"), { recursive: true });
  writeWindowState(join(ACTIVE_ROOT, "home"));
  return activeHome(kind);
}

export function removeHome(home = { root: ACTIVE_ROOT }) {
  assertIsolatedHome(home.root);
  rmSync(home.root, { recursive: true, force: true });
}

/** Deletes Chromium's on-disk caches from an Electron profile; settings and storage stay. */
export function clearChromiumCaches(profile) {
  assertIsolatedHome(profile);
  const removed = [];
  const visit = (directory, depth) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(directory, entry.name);
      if (/cache/i.test(entry.name)) {
        rmSync(path, { recursive: true, force: true });
        removed.push(entry.name);
      } else if (depth < 2) {
        visit(path, depth + 1);
      }
    }
  };
  visit(profile, 0);
  return removed;
}

function ensureWorkspaces(count) {
  mkdirSync(WORKSPACES_DIR, { recursive: true });
  for (let index = 1; index <= count; index += 1) {
    const name = `proj-${String(index).padStart(2, "0")}`;
    const dir = join(WORKSPACES_DIR, name);
    if (existsSync(join(dir, ".git"))) continue;
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "README.md"), `# ${name}\n\nBenchmark workspace.\n`);
    writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name, version: "1.0.0" })}\n`);
    writeFileSync(
      join(dir, "src/math.ts"),
      "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
    );
    run("git", ["-C", dir, "init", "-q"]);
    run("git", ["-C", dir, "add", "-A"]);
    run("git", [
      "-C",
      dir,
      "-c",
      "user.name=bench",
      "-c",
      "user.email=bench@example.invalid",
      "commit",
      "-qm",
      "init",
    ]);
  }
}

/**
 * A fixed, non-maximized window for every launch: the same pixel count on any display,
 * and the Mac stays usable around it while a run is in progress.
 */
export const BENCH_WINDOW = { x: 40, y: 60, width: 1440, height: 900 };
function writeWindowState(home) {
  mkdirSync(join(home, "userdata"), { recursive: true });
  writeFileSync(
    join(home, "userdata/desktop-window-state.json"),
    `${JSON.stringify({ version: 1, bounds: BENCH_WINDOW, isMaximized: false }, null, 2)}\n`,
  );
}

async function launchOnce(build, home, profile, drive) {
  writeWindowState(home);
  const app = launchDesktop({ buildDir: build.dir, home, profile, debugPort: await freePort() });
  try {
    const { session } = await attachMainPage(app);
    await sleep(6000);
    const dismissed = await dismissAnnouncements(session, { quietMs: 6000 });
    const result = drive ? await drive(session) : undefined;
    await sleep(1500);
    const openDialogs = await session.evaluate(
      `[...document.querySelectorAll('[role="dialog"]')].map((element) => element.innerText.replace(/\\s+/g, " ").slice(0, 60))`,
    );
    session.close();
    return { dismissed, result, openDialogs };
  } finally {
    const quit = await quitDesktop(app);
    if (quit.forced) throw new Error("Template launch did not quit cleanly");
  }
}

/**
 * Writes threads into `home` with the server code of `build`. `mode: "append-realistic"`
 * only adds the long threads of seed-realistic-threads.ts to an already seeded home.
 */
export function seed(build, home, shape, { mode } = {}) {
  const benchDir = join(build.dir, "apps/server/.bench");
  mkdirSync(benchDir, { recursive: true });
  for (const file of ["seed-home.ts", "seed-realistic-threads.ts"]) {
    cpSync(join(HERE, "..", file), join(benchDir, file));
  }
  const output = run("bun", [".bench/seed-home.ts"], {
    cwd: join(build.dir, "apps/server"),
    env: {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      BENCH_SEED_HOME: home,
      BENCH_SEED_WORKSPACES: WORKSPACES_DIR,
      ...(shape ? { BENCH_SEED_SHAPE: JSON.stringify(shape) } : {}),
      ...(mode ? { BENCH_SEED_MODE: mode } : {}),
    },
  });
  return JSON.parse(output.split("\n").at(-1));
}

/**
 * Builds both templates with one build so every measured build starts from the same data:
 *   empty  - onboarding finished, no projects, no threads, last route is a draft chat;
 *   seeded - 12 projects, 300 threads, ~14,000 messages, last route is a 38-message thread.
 */
export async function createTemplates(build, { log = console.log, shape } = {}) {
  ensureWorkspaces(12);
  rmSync(templatesDir(), { recursive: true, force: true });
  rmSync(ACTIVE_ROOT, { recursive: true, force: true });
  const active = activeHome("building");
  const store = (kind) => {
    const paths = templatePaths(kind);
    mkdirSync(paths.root, { recursive: true });
    cpSync(active.home, paths.home, { recursive: true });
    cpSync(active.profile, paths.profile, { recursive: true });
    return paths;
  };
  // Announcements can appear one per launch; relaunch until a launch shows none, so no
  // dialog holds focus during a measured start.
  const settle = async (name, drive) => {
    let last;
    for (let launch = 1; launch <= 8; launch += 1) {
      last = await launchOnce(build, active.home, active.profile, drive);
      if (last.dismissed.length === 0 && last.openDialogs.length === 0) return last;
      log(
        `[templates] ${name} launch ${launch}: dismissed ${last.dismissed.join(", ") || "nothing"}; still open: ${last.openDialogs.join(" | ") || "none"}`,
      );
    }
    throw new Error(
      `Announcements keep appearing on the ${name} template: ${last.openDialogs.join(" | ")}`,
    );
  };

  log("[templates] empty: launching until onboarding and announcements are finished");
  await settle("empty");
  const stamp = {
    templateSet,
    createdAt: new Date().toISOString(),
    createdWith: { ref: build.ref, commit: build.commit, version: build.version },
    launchedFrom: ACTIVE_ROOT,
  };
  const empty = store("empty");
  writeFileSync(
    empty.meta,
    `${JSON.stringify({ kind: "empty", ...stamp, contents: { projects: 0, threads: 0, messages: 0 }, lastRoute: "draft chat" }, null, 2)}\n`,
  );

  log("[templates] seeded: writing threads through the orchestration engine");
  const summary = seed(build, active.home, shape);
  log(
    `[templates] seeded ${summary.projects} projects, ${summary.threads} threads, ${summary.messages} messages, ${summary.activities} activities in ${summary.seconds}s`,
  );
  await launchOnce(build, active.home, active.profile, async (session) => {
    await openThreadFromSidebar(session, LAST_ROUTE_THREAD);
    await sleep(4000);
  });
  // Further launches confirm the app restores that thread on its own with no dialog open.
  const restored = await settle("seeded", (session) => session.evaluate("location.href"));
  if (!String(restored.result).includes(LAST_ROUTE_THREAD)) {
    throw new Error(`Seeded template does not restore the last thread: ${restored.result}`);
  }
  const seeded = store("seeded");
  const { manifest, ...contents } = summary;
  writeFileSync(
    seeded.meta,
    `${JSON.stringify({ kind: "seeded", ...stamp, contents, lastRoute: LAST_ROUTE_THREAD, threads: manifest }, null, 2)}\n`,
  );
  const size = (path) => run("du", ["-sh", path]).split("\t")[0];
  log(`[templates] sizes: empty ${size(empty.root)}, seeded ${size(seeded.root)}`);
}
