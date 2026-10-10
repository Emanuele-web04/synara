// FILE: ComposerVoiceRecorderBar.browser.tsx
// Purpose: Verifies recorder controls and responsive waveform coverage.
// Layer: Browser UI test
// Depends on: vitest browser rendering and ComposerVoiceRecorderBar.

import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ComposerVoiceRecorderBar } from "./ComposerVoiceRecorderBar";

describe("ComposerVoiceRecorderBar", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it.each([500, 1000, 2400])("fills a %ipx recorder with a full waveform buffer", async (width) => {
    const screen = await renderWaveform(width);
    const { track } = getWaveformElements();

    await expect.poll(() => waveformLeftInset(track)).toBeLessThan(4);
    expect(track.querySelectorAll("span").length).toBeLessThanOrEqual(160);
    expect(waveformRightInset(track)).toBeLessThan(1);

    await screen.unmount();
  });

  it("keeps filling the track when the recorder grows and shrinks", async () => {
    const screen = await renderWaveform(500);
    const { fixture, track } = getWaveformElements();

    for (const width of [500, 1600, 400]) {
      fixture.style.width = `${width}px`;
      await expect
        .poll(() => Math.max(waveformLeftInset(track), waveformRightInset(track)))
        .toBeLessThan(4);
      expect(waveformRightInset(track)).toBeLessThan(1);
    }

    await screen.unmount();
  });

  it("fills fractional-width tracks without reserving a trailing gap or clipping bars", async () => {
    const screen = await renderWaveform(500);
    const { track } = getWaveformElements();
    track.style.flex = "none";

    for (const width of [318.25, 318.75, 319.25, 319.75, 320.25, 320.75, 321.25, 321.75]) {
      track.style.width = `${width}px`;
      await expect
        .poll(() => ({
          fillsTrack: waveformLeftInset(track) < 4,
          keepsNewestBarVisible: waveformRightInset(track) < 0.1,
        }))
        .toEqual({ fillsTrack: true, keepsNewestBarVisible: true });
    }

    await screen.unmount();
  });

  it("grows short recordings from the right without filling missing history", async () => {
    const screen = await renderWaveform(1600, [0.2, 0.6, 0.4]);
    const { track } = getWaveformElements();

    await expect.poll(() => track.querySelectorAll("span").length).toBe(3);
    expect(waveformLeftInset(track)).toBeGreaterThan(track.clientWidth * 0.9);
    expect(waveformRightInset(track)).toBeLessThan(1);

    await screen.unmount();
  });

  it("uses the send treatment for stop while keeping cancel separate", async () => {
    const onDiscard = vi.fn();
    const onStop = vi.fn();
    const screen = await render(
      <ComposerVoiceRecorderBar
        durationLabel="0:03"
        isRecording
        isTranscribing={false}
        waveformLevels={[0.2, 0.6, 0.4]}
        onDiscard={onDiscard}
        onStop={onStop}
      />,
    );

    const stopButton = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Stop voice recording"]',
    );
    expect(stopButton).not.toBeNull();
    expect(stopButton?.className).toContain("bg-[var(--color-text-foreground)]");
    expect(stopButton?.className).toContain("text-[var(--color-background-surface)]");
    expect(document.querySelector('button[aria-label="Send voice note"]')).toBeNull();

    await page.getByRole("button", { name: "Stop voice recording" }).click();
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onDiscard).not.toHaveBeenCalled();

    await page.getByRole("button", { name: "Cancel voice recording" }).click();
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledTimes(1);

    await screen.unmount();
  });
});

function renderWaveform(
  width: number,
  levels = Array.from({ length: 160 }, (_, i) => (i % 11) / 10),
) {
  return render(
    <div data-testid="waveform-fixture" style={{ width }}>
      <ComposerVoiceRecorderBar
        durationLabel="0:23"
        isRecording
        isTranscribing={false}
        waveformLevels={levels}
        onDiscard={vi.fn()}
        onStop={vi.fn()}
      />
    </div>,
  );
}

function getWaveformElements() {
  const fixture = document.querySelector<HTMLDivElement>('[data-testid="waveform-fixture"]')!;
  const track = fixture.firstElementChild!.firstElementChild as HTMLDivElement;
  return { fixture, track };
}

function waveformLeftInset(track: HTMLDivElement) {
  return Math.abs(
    track.querySelector("span")!.getBoundingClientRect().left - track.getBoundingClientRect().left,
  );
}

function waveformRightInset(track: HTMLDivElement) {
  const bars = track.querySelectorAll("span");
  return Math.abs(
    track.getBoundingClientRect().right - bars[bars.length - 1]!.getBoundingClientRect().right,
  );
}
