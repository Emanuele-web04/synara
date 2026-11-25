// Drives the app window through the DevTools protocol: real mouse, wheel and key
// events enter Chromium's input pipeline, the same path as hardware input.
import { sleep, waitFor } from "./cdp.mjs";

export const SELECTORS = {
  composer: '[data-testid="composer-editor"]',
  scroller: '[data-chat-scroll-container="true"]',
  messageRow: "[data-message-id]",
  threadRow: (threadId) =>
    `li[data-thread-item="true"][data-thread-hover-anchor$=":${threadId}"] [role="button"]`,
};

export async function elementCenter(session, selector) {
  return session.call((selector) => {
    const element = document.querySelector(selector);
    if (!element) return null;
    element.scrollIntoView({ block: "center", inline: "nearest" });
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }, selector);
}

export async function clickAt(session, { x, y }) {
  await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await session.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await session.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
}

export async function clickSelector(session, selector, { timeoutMs = 15_000 } = {}) {
  const point = await waitFor(() => elementCenter(session, selector), {
    timeoutMs,
    label: `element ${selector}`,
  });
  await sleep(50);
  const settled = (await elementCenter(session, selector)) ?? point;
  await clickAt(session, settled);
  return settled;
}

/** Clicks the first button-like element whose label starts with one of `labels`. */
export async function clickLabel(session, labels) {
  const point = await session.call((labels) => {
    const candidates = [
      ...document.querySelectorAll('button,[role="button"],[role="menuitem"],[role="option"],a'),
    ];
    for (const label of labels) {
      const element = candidates.find((candidate) => {
        const text = (candidate.innerText || "").trim();
        return (
          (text.startsWith(label) || candidate.getAttribute("aria-label") === label) &&
          candidate.getBoundingClientRect().width > 0
        );
      });
      if (element) {
        const rect = element.getBoundingClientRect();
        return { label, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      }
    }
    return null;
  }, labels);
  if (!point) return null;
  await clickAt(session, point);
  return point.label;
}

/** Dismisses first-run and announcement dialogs until none appears for `quietMs`. */
export async function dismissAnnouncements(
  session,
  {
    quietMs = 2_000,
    labels = [
      "Skip intro",
      "Not now",
      "Skip tour",
      "Skip",
      "Maybe later",
      "Got it",
      "Done",
      "Close",
      "Dismiss sponsor banner",
    ],
  } = {},
) {
  const dismissed = [];
  let quietSince = Date.now();
  while (Date.now() - quietSince < quietMs) {
    const label = await clickLabel(session, labels).catch(() => null);
    if (label) {
      dismissed.push(label);
      quietSince = Date.now();
      await sleep(600);
    } else {
      await sleep(200);
    }
  }
  return dismissed;
}

export async function focusEmulation(session, enabled = true) {
  await session.send("Emulation.setFocusEmulationEnabled", { enabled });
}

const KEY_CODES = { Enter: 13, Escape: 27, Backspace: 8, Tab: 9 };

export async function pressKey(session, key, modifiers = 0) {
  const code = KEY_CODES[key];
  const base = {
    key,
    code: key,
    windowsVirtualKeyCode: code,
    nativeVirtualKeyCode: code,
    modifiers,
  };
  await session.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  if (key === "Enter")
    await session.send("Input.dispatchKeyEvent", { type: "char", ...base, text: "\r" });
  await session.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

/** One printable character as a full keydown/char/keyup sequence. */
export async function typeCharacter(session, character) {
  const upper = character.toUpperCase();
  const code = upper.charCodeAt(0);
  const base = { key: character, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
  await session.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  await session.send("Input.dispatchKeyEvent", {
    type: "char",
    ...base,
    text: character,
    unmodifiedText: character,
  });
  await session.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

export async function wheel(session, { x, y, deltaY }) {
  await session.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY });
}

export async function composerText(session) {
  return session.call(
    (selector) => document.querySelector(selector)?.innerText ?? null,
    SELECTORS.composer,
  );
}

export async function screenshot(session, path) {
  const { writeFileSync } = await import("node:fs");
  const shot = await session.send("Page.captureScreenshot", { format: "jpeg", quality: 45 });
  writeFileSync(path, Buffer.from(shot.data, "base64"));
}

/** Opens a thread from its sidebar row with a real click and waits for the route to change. */
export async function openThreadFromSidebar(session, threadId, { attempts = 4 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await clickSelector(session, SELECTORS.threadRow(threadId), { timeoutMs: 30_000 });
    try {
      await waitFor(() => session.evaluate(`location.href.includes(${JSON.stringify(threadId)})`), {
        timeoutMs: 3_000,
        intervalMs: 50,
        label: "thread route",
      });
      return attempt;
    } catch {
      await sleep(500);
    }
  }
  throw new Error(`Could not open thread ${threadId} from the sidebar`);
}
