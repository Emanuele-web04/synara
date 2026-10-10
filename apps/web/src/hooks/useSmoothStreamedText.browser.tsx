// FILE: useSmoothStreamedText.browser.tsx
// Purpose: Hook-level regressions for the smooth streamed-text reveal — completion
//          snap, reduced-motion bypass, non-append reset, and mount-text passthrough.
// Layer: Web browser tests
// Depends on: useSmoothStreamedText and a real React/browser rAF loop. The pure
//             stepper math is pinned separately in useSmoothStreamedText.test.ts;
//             these tests cover the wiring the stepper tests cannot see.

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "vitest-browser-react";

import { useSmoothStreamedText } from "~/hooks/useSmoothStreamedText";

interface SmoothTextProps {
  readonly text: string;
  readonly isStreaming: boolean;
}

// Large enough that the rAF loop (≤2000 chars/s, ≤100 chars per clamped frame)
// needs many quantized commits to drain it, so partially-revealed states are
// reliably observable between polls and a handful of stray frames cannot
// accidentally finish the reveal before an assertion runs.
// Space-bearing words, not one whitespaceless blob: the reveal emits on
// whole-word boundaries now, and a 1.2k-char single word would dribble raw
// through the REVEAL_WORD_HOLD_CHARS guard instead of exercising them.
const LONG_DELTA = "lorem ipsum dolor ".repeat(67);

function renderSmoothText(initialProps: SmoothTextProps) {
  return renderHook(
    (props?: SmoothTextProps) =>
      useSmoothStreamedText(
        props?.text ?? initialProps.text,
        props?.isStreaming ?? initialProps.isStreaming,
      ),
    { initialProps },
  );
}

describe("useSmoothStreamedText", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows mount text immediately and reveals appended deltas gradually", async () => {
    const mountText = "Hello ";
    const hook = await renderSmoothText({ text: mountText, isStreaming: true });
    expect(hook.result.current).toBe(mountText);

    const full = mountText + LONG_DELTA;
    await hook.rerender({ text: full, isStreaming: true });
    // The append only wakes the rAF loop — the backlog must not snap in at once.
    expect(hook.result.current.length).toBeLessThan(full.length);
    expect(full.startsWith(hook.result.current)).toBe(true);

    // The reveal passes through intermediate prefixes on its way to the target.
    let intermediate = "";
    await expect
      .poll(
        () => {
          const value = hook.result.current;
          if (value.length > mountText.length && value.length < full.length) {
            intermediate = value;
          }
          return intermediate.length > 0;
        },
        { timeout: 10_000 },
      )
      .toBe(true);
    expect(full.startsWith(intermediate)).toBe(true);

    await expect.poll(() => hook.result.current, { timeout: 10_000 }).toBe(full);

    await hook.unmount();
  });

  it("snaps to the full text the instant streaming ends", async () => {
    const mountText = "Partial ";
    const hook = await renderSmoothText({ text: mountText, isStreaming: true });

    const full = mountText + LONG_DELTA;
    await hook.rerender({ text: full, isStreaming: true });
    expect(hook.result.current.length).toBeLessThan(full.length);

    // No trailing typewriter once the agent is done: the flip to settled must
    // return the complete text synchronously, mid-animation backlog and all.
    await hook.rerender({ text: full, isStreaming: false });
    expect(hook.result.current).toBe(full);

    await hook.unmount();
  });

  it("resets instantly on a non-append replacement while streaming", async () => {
    const hook = await renderSmoothText({ text: "Original draft", isStreaming: true });
    expect(hook.result.current).toBe("Original draft");

    // A projection repair can rewrite the text in place; a non-append target
    // must not be typewriter-animated from a stale prefix.
    await hook.rerender({ text: "Rewritten from scratch", isStreaming: true });
    expect(hook.result.current).toBe("Rewritten from scratch");

    await hook.unmount();
  });

  it("never commits a mid-word prefix while streaming", async () => {
    const mountText = "Hello ";
    const hook = await renderSmoothText({ text: mountText, isStreaming: true });

    const full = mountText + LONG_DELTA;
    await hook.rerender({ text: full, isStreaming: true });

    // Sample every observed emitted prefix: each must stop at a word boundary —
    // the char after the prefix is a space, or the prefix is the whole target.
    let midWordSeen = "";
    await expect
      .poll(
        () => {
          const value = hook.result.current;
          if (
            value !== full &&
            value.length > 0 &&
            full[value.length] !== " " &&
            full[value.length - 1] !== " "
          ) {
            midWordSeen = value;
          }
          return value === full;
        },
        { timeout: 10_000 },
      )
      .toBe(true);
    expect(midWordSeen).toBe("");

    await hook.unmount();
  });

  it("releases a stalled trailing word after the hold window", async () => {
    const hook = await renderSmoothText({ text: "Hello ", isStreaming: true });

    // "wor" is a still-growing word: the reveal holds it back once caught up.
    await hook.rerender({ text: "Hello brave new wor", isStreaming: true });
    await expect.poll(() => hook.result.current, { timeout: 5_000 }).toBe("Hello brave new ");

    // A genuine stall keeps the partial word hidden past ordinary flush jitter;
    // the hold timer then emits the arrived text in full.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(hook.result.current).toBe("Hello brave new ");
    await expect.poll(() => hook.result.current, { timeout: 5_000 }).toBe("Hello brave new wor");

    await hook.unmount();
  });

  it("returns the raw text under prefers-reduced-motion even while streaming", async () => {
    const originalMatchMedia = window.matchMedia.bind(window);
    vi.spyOn(window, "matchMedia").mockImplementation((query: string) =>
      query === "(prefers-reduced-motion: reduce)"
        ? ({
            matches: true,
            media: query,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
          } as unknown as MediaQueryList)
        : originalMatchMedia(query),
    );

    const mountText = "Hello ";
    const hook = await renderSmoothText({ text: mountText, isStreaming: true });
    expect(hook.result.current).toBe(mountText);

    const full = mountText + LONG_DELTA;
    await hook.rerender({ text: full, isStreaming: true });
    expect(hook.result.current).toBe(full);

    await hook.unmount();
  });
});
