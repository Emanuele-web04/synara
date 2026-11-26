import { EventEmitter } from "node:events";

import type { WebContents } from "electron";
import { describe, expect, it } from "vitest";

import { attachAppSubframeNavigationGuard } from "./subframeNavigationGuard";

function navigate(
  emitter: EventEmitter,
  url: string,
  isMainFrame: boolean,
  details: Record<string, unknown> = {},
): boolean {
  let prevented = false;
  emitter.emit("will-frame-navigate", {
    url,
    isMainFrame,
    ...details,
    preventDefault: () => {
      prevented = true;
    },
  });
  return prevented;
}

describe("attachAppSubframeNavigationGuard", () => {
  const mainFrame = { url: "synara-remote://app/index.html#/remote", parent: null };
  const emitter = Object.assign(new EventEmitter(), { mainFrame });
  attachAppSubframeNavigationGuard(emitter as unknown as Pick<WebContents, "on" | "mainFrame">);

  it.each([
    "https://attacker.example/collect?data=secret",
    "http://127.0.0.1:3773/api/auth/session",
    "data:text/html,<script>1</script>",
    "synara://app/settings",
    "javascript:alert(1)",
  ])("keeps an embedded document from navigating its frame to %s", (url) => {
    expect(navigate(emitter, url, false)).toBe(true);
  });

  it("lets a frame load its own inline document", () => {
    expect(navigate(emitter, "about:srcdoc", false)).toBe(false);
    expect(navigate(emitter, "about:blank", false)).toBe(false);
  });

  it.each(["", "about:blank"])("loads an app-owned workspace from a fresh %j frame", (url) => {
    expect(
      navigate(emitter, "synara-remote://app/index.html", false, {
        frame: { url, parent: mainFrame },
        initiator: mainFrame,
      }),
    ).toBe(false);
  });

  it("lets an initialized workspace retry its own shell document", () => {
    const frame = { url: "synara-remote://app/index.html", parent: mainFrame };
    expect(navigate(emitter, frame.url, false, { frame, initiator: frame })).toBe(false);
  });

  it.each([
    { frame: { url: "about:srcdoc", parent: mainFrame }, initiator: mainFrame },
    { frame: { url: "about:blank", parent: mainFrame }, initiator: null },
    { frame: { url: "about:blank", parent: mainFrame }, initiator: {} },
    { frame: { url: "about:blank", parent: null }, initiator: mainFrame },
  ])("does not let embedded documents claim the app workspace exception: %j", (details) => {
    expect(navigate(emitter, "synara-remote://app/index.html", false, details)).toBe(true);
  });

  it.each([
    "synara-remote://app/settings",
    "synara-remote://app/index.html?data=secret",
    "synara-remote://app/index.html#data=secret",
    "synara-beta://app/index.html",
    "https://attacker.example/collect?data=secret",
  ])("limits app-owned workspace frames to the shell document, refusing %s", (url) => {
    expect(
      navigate(emitter, url, false, {
        frame: { url: "about:blank", parent: mainFrame },
        initiator: mainFrame,
      }),
    ).toBe(true);
  });

  it("leaves the app window's own navigation to its existing handling", () => {
    expect(navigate(emitter, "https://example.com", true)).toBe(false);
  });
});
