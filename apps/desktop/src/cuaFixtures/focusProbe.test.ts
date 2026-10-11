import { describe, expect, it } from "vitest";
import { analyzeFocusSamples, parseFocusProbeLine, type FocusProbeSample } from "./focusProbe";

const sample = (t: number, overrides: Partial<FocusProbeSample> = {}): FocusProbeSample => ({
  t,
  pid: 100,
  app: "Human App",
  keyWin: 5001,
  keyTitle: "human.txt",
  topWin: 5001,
  topTitle: "human.txt",
  space: 7,
  focusedPid: 100,
  focused: "100:AXTextArea:human.txt",
  ...overrides,
});

const span = (start: number, count: number, step = 20, overrides = {}): FocusProbeSample[] =>
  Array.from({ length: count }, (_, index) => sample(start + index * step, overrides));

describe("parseFocusProbeLine", () => {
  it("parses meta, sample and done lines", () => {
    expect(
      parseFocusProbeLine(
        '{"kind":"meta","pid":9,"hz":50,"axTrusted":true,"axWindowSymbol":true,' +
          '"slsSpace":true,"stdinWatch":true,"label":"x","startedAt":1.5}',
      ),
    ).toEqual({
      kind: "meta",
      meta: {
        pid: 9,
        hz: 50,
        axTrusted: true,
        axWindowSymbol: true,
        slsSpace: true,
        stdinWatch: true,
        label: "x",
        startedAt: 1.5,
      },
    });
    expect(
      parseFocusProbeLine(
        '{"t":12.5,"pid":100,"app":"A","keyWin":1,"keyTitle":"k","topWin":2,' +
          '"topTitle":"t","space":3,"focused":"100:AXTextArea:f"}',
      ),
    ).toEqual({
      kind: "sample",
      sample: {
        t: 12.5,
        pid: 100,
        app: "A",
        keyWin: 1,
        keyTitle: "k",
        topWin: 2,
        topTitle: "t",
        space: 3,
        focusedPid: null,
        focused: "100:AXTextArea:f",
      },
    });
    expect(
      parseFocusProbeLine(
        '{"kind":"done","samples":4,"elapsedMs":80.2,"overruns":0,"stoppedBy":"stdin"}',
      ),
    ).toEqual({
      kind: "done",
      done: { samples: 4, elapsedMs: 80.2, overruns: 0, stoppedBy: "stdin" },
    });
  });

  it("tolerates null fields, blank lines and foreign output", () => {
    const parsed = parseFocusProbeLine('{"t":0,"pid":null,"app":null,"keyWin":null}');
    expect(parsed?.kind).toBe("sample");
    expect(parseFocusProbeLine("")).toBeNull();
    expect(parseFocusProbeLine("   ")).toBeNull();
    expect(parseFocusProbeLine("not json")).toBeNull();
    expect(parseFocusProbeLine('{"unrelated":true}')).toBeNull();
    expect(parseFocusProbeLine("[1,2,3]")).toBeNull();
  });
});

describe("analyzeFocusSamples", () => {
  it("reports theft-free on a stable stream", () => {
    const report = analyzeFocusSamples(span(0, 60));
    expect(report.theftFree).toBe(true);
    expect(report.ok).toBe(true);
    expect(report.offBaseline).toEqual([]);
    expect(report.baseline).toEqual({
      pid: 100,
      keyWin: 5001,
      topWin: 5001,
      space: 7,
      focusedPid: 100,
      focused: "100:AXTextArea:human.txt",
    });
    expect(report.issues).toEqual([]);
  });

  it("flags a frontmost-pid change with its interval and observed state", () => {
    const samples = [
      ...span(0, 30),
      ...span(600, 5, 20, { pid: 200, app: "Agent App", keyWin: 9001, topWin: 9001 }),
      ...span(700, 25),
    ];
    const report = analyzeFocusSamples(samples);
    expect(report.theftFree).toBe(false);
    expect(report.offBaseline).toHaveLength(1);
    const theft = report.offBaseline[0]!;
    expect(theft.index).toBe(30);
    expect(theft.tMs).toBe(600);
    expect(theft.sampleCount).toBe(5);
    expect(theft.durationMs).toBe(80);
    expect(theft.changedFields).toEqual(expect.arrayContaining(["pid", "keyWin", "topWin"]));
    expect(theft.observed[0]).toMatchObject({ pid: 200, app: "Agent App", keyWin: 9001 });
  });

  it("flags typing-focus theft when the focused element's owner moves", () => {
    // The Codex case: kCPSNotifyTypingFocusChanged semantics — key focus can
    // move to the desktop/menubar/agent app while frontmostApplication still
    // reports the human's app. focusedPid catches what pid+keyWin miss.
    const samples = [
      ...span(0, 30),
      ...span(600, 5, 20, { focusedPid: 573, focused: "573:AXGroup:desktop" }),
      ...span(700, 25),
    ];
    const report = analyzeFocusSamples(samples);
    expect(report.theftFree).toBe(false);
    expect(report.offBaseline[0]!.changedFields).toEqual(["focusedPid"]);
    expect(report.offBaseline[0]!.observed[0]).toMatchObject({ focusedPid: 573 });
  });

  it("flags separate theft intervals around a return to baseline", () => {
    const samples = [
      ...span(0, 20),
      ...span(400, 3, 20, { pid: 200, app: "Agent" }),
      ...span(460, 10),
      ...span(660, 2, 20, { space: 8 }),
      ...span(700, 20),
    ];
    const report = analyzeFocusSamples(samples);
    expect(report.offBaseline).toHaveLength(2);
    expect(report.offBaseline[0]!.changedFields).toEqual(["pid"]);
    expect(report.offBaseline[1]!.changedFields).toEqual(["space"]);
    expect(report.offBaselineSamples).toBe(5);
  });

  it("excludes the settle window from violations and derives a modal baseline", () => {
    const samples = [
      // Warm-up: still settling from the launcher's activation.
      sample(0, { pid: 50, app: "Launcher", keyWin: 1, topWin: 1 }),
      ...span(20, 5, 20),
      // Measured section is clean.
      ...span(200, 40),
    ];
    const report = analyzeFocusSamples(samples, { settleMs: 150 });
    expect(report.warmupCount).toBe(6);
    expect(report.theftFree).toBe(true);
    expect(report.baseline?.pid).toBe(100);
  });

  it("honours an explicit expectation over the observed settle state", () => {
    const samples = span(0, 30, 20, { pid: 50, app: "Launcher" });
    const report = analyzeFocusSamples(samples, {
      settleMs: 100,
      expect: { pid: 100 },
    });
    expect(report.baseline?.pid).toBe(100);
    expect(report.theftFree).toBe(false);
    expect(report.offBaselineSamples).toBe(25);
    expect(report.offBaseline[0]!.changedFields).toEqual(["pid"]);
  });

  it("treats null sample fields as observation gaps, not theft", () => {
    const samples = [
      ...span(0, 20),
      // AX read hiccup: keyWin/focused go null for a few ticks.
      ...span(400, 4, 20, { keyWin: null, keyTitle: null, focusedPid: null, focused: null }),
      ...span(500, 30),
    ];
    const report = analyzeFocusSamples(samples);
    expect(report.theftFree).toBe(true);
    expect(report.uncertainSamples).toBe(4);
  });

  it("skips theft fields whose baseline was never measured", () => {
    const samples = span(0, 30, 20, {
      keyWin: null,
      topWin: null,
      space: null,
      focusedPid: null,
      focused: null,
    });
    samples[20] = { ...samples[20]!, keyWin: 4242 };
    const report = analyzeFocusSamples(samples);
    expect(report.baseline?.keyWin).toBeNull();
    expect(report.baseline?.space).toBeNull();
    expect(report.theftFree).toBe(true);
    expect(report.issues).toContain(
      "key/top window and focused element unmeasured (accessibility grant missing or no windows)",
    );
    expect(report.issues).toContain("active space unmeasured (SkyLight symbol)");
  });

  it("reports focused-element changes as drift, not theft, by default", () => {
    const samples = [
      ...span(0, 20),
      ...span(400, 10, 20, { focused: "100:AXButton:Send" }),
      ...span(600, 20),
    ];
    const report = analyzeFocusSamples(samples);
    expect(report.theftFree).toBe(true);
    expect(report.driftSamples).toBe(2);
    expect(report.drift[0]).toMatchObject({
      index: 20,
      from: "100:AXTextArea:human.txt",
      to: "100:AXButton:Send",
    });
  });

  it("counts focused-element changes as theft under strictFocus", () => {
    const samples = [...span(0, 20), ...span(400, 5, 20, { focused: "100:AXButton:Send" })];
    const report = analyzeFocusSamples(samples, { strictFocus: true });
    expect(report.theftFree).toBe(false);
    expect(report.offBaseline[0]!.changedFields).toContain("focused");
  });

  it("flags insufficient coverage as not-ok", () => {
    const report = analyzeFocusSamples(span(0, 3), { minSamples: 10 });
    expect(report.ok).toBe(false);
    expect(report.theftFree).toBe(true);
    expect(report.issues.some((issue) => issue.includes("thin coverage"))).toBe(true);
  });

  it("reports an empty stream as not-ok with no baseline", () => {
    const report = analyzeFocusSamples([]);
    expect(report.ok).toBe(false);
    expect(report.baseline).toBeNull();
    expect(report.issues).toContain("no post-settle samples");
  });
});
