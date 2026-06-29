// @vitest-environment happy-dom

import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSmoothStreamedText } from "./useSmoothStreamedText";

function SmoothTextProbe(props: { text: string; streaming: boolean }) {
  return <div data-testid="smooth-text">{useSmoothStreamedText(props.text, props.streaming)}</div>;
}

describe("useSmoothStreamedText", () => {
  beforeEach(() => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns exact full text without scheduling animation under reduced motion", () => {
    const requestAnimationFrameSpy = vi.spyOn(window, "requestAnimationFrame");

    render(<SmoothTextProbe text="Streaming 👩‍💻 text" streaming />);

    expect(screen.getByTestId("smooth-text").textContent).toBe("Streaming 👩‍💻 text");
    expect(requestAnimationFrameSpy).not.toHaveBeenCalled();
  });
});
