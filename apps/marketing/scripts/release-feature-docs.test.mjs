import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { extractInternalLinks, parseFrontmatter } from "./check-docs.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relative) {
  return readFileSync(path.join(ROOT, relative), "utf8");
}

test("v0.7.2 feature guides are public navigation entries with complete frontmatter", () => {
  const meta = JSON.parse(read("content/docs/features/meta.json"));

  for (const slug of ["thread-goals", "ios-simulator"]) {
    assert.ok(meta.pages.includes(slug), `${slug} is missing from feature navigation`);
    const frontmatter = parseFrontmatter(read(`content/docs/features/${slug}.mdx`));
    assert.equal(frontmatter.error, undefined, `${slug} has invalid frontmatter`);
    assert.ok(frontmatter.values.title?.trim());
    assert.ok(frontmatter.values.description?.trim());
  }
});

test("goals and Debug mode are documented in the canonical command reference", () => {
  const commands = read("content/docs/reference/slash-commands.mdx");

  for (const command of [
    "/debug",
    "/goal",
    "/goal edit",
    "/goal pause",
    "/goal resume",
    "/goal clear",
  ]) {
    assert.ok(commands.includes(command), `slash-command reference is missing ${command}`);
  }
});

test("workspace search shortcuts and destination behavior are documented", () => {
  const shortcuts = read("content/docs/reference/keyboard-shortcuts.mdx");
  const organize = read("content/docs/features/organize.mdx");

  assert.ok(shortcuts.includes("`mod+p`"));
  assert.ok(shortcuts.includes("`mod+shift+f`"));
  assert.ok(organize.includes("## Search files and source"));
  assert.ok(organize.includes("right-dock file pane"));
});

test("the feature map links to the durable v0.7.2 guides", () => {
  const links = extractInternalLinks(read("content/docs/features/overview.mdx"));

  for (const route of [
    "/docs/features/thread-goals",
    "/docs/features/ios-simulator",
    "/docs/workflows/forks",
    "/docs/workflows/debugging",
  ]) {
    assert.ok(links.includes(route), `feature map does not link to ${route}`);
  }
});

test("stacked PR and automation failure policy updates remain explicit", () => {
  const pullRequests = read("content/docs/workflows/pull-requests.mdx");
  const automations = read("content/docs/workflows/automations.mdx");

  assert.ok(pullRequests.includes("## Work with stacked pull requests"));
  assert.ok(pullRequests.includes("stack prefix through the selected PR"));
  assert.ok(automations.includes("## Choose a failure policy"));
  assert.ok(automations.includes("Stop after 3 failures"));
  assert.ok(automations.includes("A successful run resets the consecutive-failure count"));
});

test("v0.7.3 durable workflows are documented and connected", () => {
  const workflowMeta = JSON.parse(read("content/docs/workflows/meta.json"));
  const workflowIndex = read("content/docs/workflows/index.mdx");
  const headless = read("content/docs/workflows/headless-server.mdx");
  const browser = read("content/docs/workflows/browser-verification.mdx");
  const commands = read("content/docs/reference/slash-commands.mdx");
  const desktop = read("content/docs/troubleshooting/desktop-and-updates.mdx");
  const worktrees = read("content/docs/troubleshooting/git-and-worktrees.mdx");

  assert.ok(workflowMeta.pages.includes("headless-server"));
  assert.ok(workflowIndex.includes("/docs/workflows/headless-server"));
  assert.ok(headless.includes("synara-server-<version>.tar.gz"));
  assert.ok(headless.includes("server status"));
  assert.ok(headless.includes("SYNARA_AUTH_TOKEN"));
  assert.ok(browser.includes("Floating over the conversation"));
  assert.ok(browser.includes("two presentations of one task-scoped browser session"));
  assert.ok(commands.includes("`/side [provider] [prompt]`"));
  assert.ok(desktop.includes("Resume chats automatically"));
  assert.ok(desktop.includes("Use custom title bar"));
  assert.ok(worktrees.includes("wsl.exe"));
  assert.ok(worktrees.includes("\\\\wsl.localhost"));
});

test("v0.8.2 documents rename, simulator opt-out, and Claude automatic compaction", () => {
  const commands = read("content/docs/reference/slash-commands.mdx");
  const simulator = read("content/docs/features/ios-simulator.mdx");
  const claude = read("content/docs/providers/claude-code.mdx");
  assert.ok(commands.includes("/rename <title>"));
  assert.ok(commands.includes("keeps the newer title"));
  assert.ok(simulator.includes("Automatically open simulator"));
  assert.ok(simulator.includes("open the pane manually"));
  assert.ok(claude.includes("Auto (Claude Code)"));
  assert.ok(claude.includes("returning to Auto clears that override"));
});

test("v0.8.3 documents packaged dependency recovery and persistent diff layout", () => {
  const providers = read("content/docs/troubleshooting/providers.mdx");
  const organize = read("content/docs/features/organize.mdx");
  assert.ok(providers.includes("Cannot find package 'zod'"));
  assert.ok(providers.includes("0.8.3 or later"));
  assert.ok(providers.includes("does not repair the app bundle"));
  assert.ok(organize.includes("**Split diff** or **Stacked diff**"));
  assert.ok(organize.includes("after an app restart"));
});

test("v0.8.4 editor and browser guides are connected and preserve safety boundaries", () => {
  const meta = JSON.parse(read("content/docs/features/meta.json"));
  const overview = extractInternalLinks(read("content/docs/features/overview.mdx"));
  const home = extractInternalLinks(read("content/docs/index.mdx"));
  for (const slug of ["workspace-editor", "browser-sessions"]) {
    const guide = read(`content/docs/features/${slug}.mdx`);
    const frontmatter = parseFrontmatter(guide);
    assert.equal(frontmatter.error, undefined);
    assert.ok(frontmatter.values.title?.trim());
    assert.ok(frontmatter.values.description?.trim());
    assert.ok(meta.pages.includes(slug));
    assert.ok(overview.includes(`/docs/features/${slug}`));
    assert.ok(home.includes(`/docs/features/${slug}`));
  }
  const editor = read("content/docs/features/workspace-editor.mdx");
  assert.ok(editor.includes("400 ms"));
  assert.ok(editor.includes("does not repeatedly retry a failed write"));
  assert.ok(editor.includes("**Partial diff**"));
  assert.ok(editor.includes("Some files or changes may be missing"));
  const browser = read("content/docs/features/browser-sessions.mdx");
  assert.ok(browser.includes("shared across Synara browser tabs and agent workflows"));
  assert.ok(browser.includes("Agent password filling and password generation are unavailable"));
  assert.ok(browser.includes("Nothing is copied merely by opening or completing"));
  assert.ok(browser.includes("clean app shutdown"));
});

test("v0.8.4 removes saved transcript marker promises and documents recovery", () => {
  const organize = read("content/docs/features/organize.mdx");
  const overview = read("content/docs/features/overview.mdx");
  assert.ok(!organize.includes("## Mark transcript moments"));
  assert.ok(!overview.includes("**Pins, markers & notes**"));
  assert.ok(organize.includes("pinned messages and thread notes remain available"));
  const runtime = read("content/docs/troubleshooting/tasks-and-runtime.mdx");
  assert.ok(runtime.includes("**Restore answers**"));
  assert.ok(runtime.includes("Restoring alone does not send anything"));
  const claude = read("content/docs/providers/claude-code.mdx");
  assert.ok(claude.includes("Historical recovery is partial"));
  assert.ok(claude.includes("not evidence that your subscription usage or bill decreased"));
});

test("v0.8.4 documents selection actions and exact automation target limitations", () => {
  const composer = read("content/docs/features/composer.mdx");
  assert.ok(composer.includes("**Add to new Chat**"));
  assert.ok(composer.includes("**Open in chat**"));
  assert.ok(composer.includes("**Choose another window**"));
  const automations = read("content/docs/workflows/automations.mdx");
  assert.ok(automations.includes("enabled: false"));
  assert.ok(automations.includes("Heartbeat automations continue an existing task session"));
  assert.ok(automations.includes("its provider is fixed"));
  assert.ok(automations.includes("omitting the target preserves the saved selection"));
});

test("v0.9.0 guides keep platform, source preservation and interruption boundaries explicit", () => {
  const meta = JSON.parse(read("content/docs/features/meta.json"));
  const overview = extractInternalLinks(read("content/docs/features/overview.mdx"));
  for (const slug of ["computer-use", "project-import"]) {
    assert.ok(meta.pages.includes(slug));
    assert.ok(overview.includes(`/docs/features/${slug}`));
    assert.equal(parseFrontmatter(read(`content/docs/features/${slug}.mdx`)).error, undefined);
  }
  const computer = read("content/docs/features/computer-use.mdx");
  for (const text of [
    "in beta",
    "macOS only",
    "Linux is coming soon",
    "/computer-use",
    "Input Monitoring",
    "Closing the preview only hides it",
    "Escape interrupts the current action",
  ]) {
    assert.ok(computer.includes(text), `missing Computer boundary: ${text}`);
  }
  assert.ok(
    read("content/docs/features/project-import.mdx").includes("Source history is preserved"),
  );
  assert.ok(read("content/docs/providers/codex.mdx").includes("10% or less remaining"));
  assert.ok(read("content/docs/providers/claude-code.mdx").includes("Compact, then send"));
});
