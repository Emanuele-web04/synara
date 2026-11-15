// Startup: spawn of the Electron process -> first paint, sidebar, transcript, typing.
import { sleep } from "./cdp.mjs";
import { SELECTORS, focusEmulation, typeCharacter } from "./drive.mjs";
import {
  attachMainPage,
  launchDesktop,
  freePort,
  frontmostProblem,
  quitDesktop,
  processTree,
} from "./launch.mjs";

const PROBE = `(() => {
  const composer = document.querySelector(${JSON.stringify(SELECTORS.composer)});
  const paint = performance.getEntriesByType("paint").find((entry) => entry.name === "first-contentful-paint");
  return {
    composer: Boolean(composer),
    composerFocused: Boolean(composer) && (document.activeElement === composer || composer.contains(document.activeElement)),
    composerText: composer ? composer.innerText : "",
    sidebarRows: document.querySelectorAll('li[data-thread-item="true"]').length,
    messageRows: document.querySelectorAll(${JSON.stringify(SELECTORS.messageRow)}).length,
    firstContentfulPaintEpochMs: paint ? performance.timeOrigin + paint.startTime : null,
    url: location.href,
  };
})()`;

const now = () => performance.timeOrigin + performance.now();

/**
 * One launch. The clock starts when the Electron process is spawned and stops when two
 * typed characters are in the composer. Keys go through the DevTools protocol with
 * window focus emulated; the harness never focuses the composer itself.
 */
export async function measureLaunch({ build, home, expectTranscript, timeoutMs = 90_000 }) {
  const app = launchDesktop({
    buildDir: build.dir,
    home: home.home,
    profile: home.profile,
    debugPort: await freePort(),
  });
  const marks = {};
  const since = (epoch) => Math.round(epoch - app.spawnedAtEpochMs);
  let failure = null;
  let session = null;
  try {
    const attached = await attachMainPage(app, { timeoutMs });
    session = attached.session;
    marks.windowTargetMs = since(now());
    await focusEmulation(session, true);
    const deadline = app.spawnedAtEpochMs + timeoutMs;
    // The seeded relaunch restores the draft the previous launch typed, so a fixed
    // marker could already be in the composer. Each launch types its own two letters
    // and they must appear after whatever text was there before.
    const letters = "cdefghijklmnopqrstuvwxyz";
    const sentinel = `${letters[Math.floor(Math.random() * letters.length)]}${letters[Math.floor(Math.random() * letters.length)]}`;
    let typed = false;
    let textBeforeTyping = "";
    while (now() < deadline) {
      let state;
      try {
        state = await session.evaluate(PROBE);
      } catch {
        // The page can navigate once during startup; the next poll sees the new document.
        await sleep(20);
        continue;
      }
      const at = since(now());
      if (state.firstContentfulPaintEpochMs !== null)
        marks.firstPaintMs ??= since(state.firstContentfulPaintEpochMs);
      if (state.sidebarRows > 0) marks.sidebarRowsMs ??= at;
      if (state.messageRows > 0) marks.transcriptMs ??= at;
      if (state.composer) marks.composerVisibleMs ??= at;
      if (state.composerFocused) marks.composerFocusedMs ??= at;
      if (state.composerFocused && !typed) {
        typed = true;
        textBeforeTyping = state.composerText.replace(/\n/g, "");
        await typeCharacter(session, sentinel[0]);
        await typeCharacter(session, sentinel[1]);
        continue;
      }
      const text = state.composerText.replace(/\n/g, "");
      if (typed && text.length >= textBeforeTyping.length + 2 && text.includes(sentinel)) {
        marks.typingMs = at;
        if (!expectTranscript || marks.transcriptMs !== undefined) break;
      }
      await sleep(15);
    }
    if (marks.typingMs === undefined)
      failure = `no typed text in the composer within ${timeoutMs} ms (composer visible: ${marks.composerVisibleMs ?? "never"}, focused: ${marks.composerFocusedMs ?? "never"})`;
    else if (expectTranscript && marks.transcriptMs === undefined)
      failure = "the restored thread's transcript never rendered";
  } catch (error) {
    failure = error.message.split("\n")[0];
  }
  // A window covered by another app's window is throttled, which delays the paint marks.
  if (failure === null) failure = frontmostProblem(app, "at the end of startup");
  const processesBeforeQuit = processTree(app.pid).length;
  session?.close();
  const quit = await quitDesktop(app);
  return {
    at: new Date(app.spawnedAtEpochMs).toISOString(),
    ...marks,
    quitMs: quit.quitMs,
    processesBeforeQuit,
    survivorsAfterQuit: quit.survivors.length,
    failed: failure,
  };
}
