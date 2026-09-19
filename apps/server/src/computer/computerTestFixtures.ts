import type { ComputerWindow } from "@synara/contracts";

/**
 * The desktop the fake backend starts with, and the arrangements the core
 * tests put it in. Declared once: the same terminal, calculator and browser
 * used to be spelled out in every test file that needed them, and the copies
 * had already drifted in which fields they carried.
 *
 * @module computer/computerTestFixtures
 */

export const FAKE_TERMINAL_WINDOW: ComputerWindow = {
  id: "fake-terminal",
  title: "Terminal",
  appName: "org.kde.konsole",
  bounds: { x: 40, y: 40, width: 960, height: 720 },
  focused: true,
  minimized: false,
  visible: true,
};

export const FAKE_CALCULATOR_WINDOW: ComputerWindow = {
  id: "fake-calculator",
  title: "Calculator",
  appName: "org.kde.kcalc",
  bounds: { x: 1_050, y: 120, width: 420, height: 620 },
  focused: false,
  minimized: false,
  visible: true,
};

/** A full-screen browser, the window that buries everything under it. */
export const FAKE_BROWSER_WINDOW: ComputerWindow = {
  id: "fake-browser",
  title: "Browser",
  bounds: { x: 0, y: 0, width: 1_920, height: 1_080 },
  focused: true,
  minimized: false,
  visible: true,
  stackingIndex: 0,
};

/** What the fake enumerates until a test rearranges it: the terminal holds focus. */
export function fakeDefaultWindows(): ComputerWindow[] {
  return [{ ...FAKE_TERMINAL_WINDOW }, { ...FAKE_CALCULATOR_WINDOW }];
}

/**
 * A calculator buried under a full-screen browser: the live failure window
 * scoping exists for, where a bare coordinate click lands on the browser.
 */
export function coveredCalculatorWindows(): readonly ComputerWindow[] {
  return [
    { ...FAKE_BROWSER_WINDOW, occludedBy: [] },
    { ...FAKE_CALCULATOR_WINDOW, stackingIndex: 1, occludedBy: ["fake-browser"] },
  ];
}

/** Two windows sharing a region, with or without a stacking order to settle it. */
export function overlappingWindows(stacked: boolean): ComputerWindow[] {
  return [
    {
      id: "under",
      title: "Under",
      bounds: { x: 100, y: 100, width: 800, height: 600 },
      focused: false,
      minimized: false,
      visible: true,
      ...(stacked ? { stackingIndex: 1 } : {}),
    },
    {
      id: "over",
      title: "Over",
      bounds: { x: 300, y: 200, width: 400, height: 300 },
      focused: false,
      minimized: false,
      visible: true,
      ...(stacked ? { stackingIndex: 0 } : {}),
    },
  ];
}
