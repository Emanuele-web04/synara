import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ComputerCallTiming,
  createComputerCallContext,
  cuaActionSettleMsOverride,
  cuaCaptureReuseEnabled,
  cuaConditionalSettleEnabled,
  cuaPreviewStillMsOverride,
  cuaTimingLogEnabled,
  currentComputerCall,
  markComputerCall,
  timedComputerLeg,
  withComputerCallContext,
} from "./computerCallContext.ts";

const FLAGS = [
  "SYNARA_CUA_TIMING_LOG",
  "SYNARA_CUA_CONDITIONAL_SETTLE",
  "SYNARA_CUA_ACTION_SETTLE_MS",
  "SYNARA_CUA_CAPTURE_REUSE",
  "SYNARA_CUA_PREVIEW_STILL_MS",
] as const;

const saved = new Map<string, string | undefined>();
for (const flag of FLAGS) saved.set(flag, process.env[flag]);

afterEach(() => {
  for (const flag of FLAGS) {
    const value = saved.get(flag);
    if (value === undefined) delete process.env[flag];
    else process.env[flag] = value;
  }
  vi.restoreAllMocks();
});

describe("computer call env flags", () => {
  it.each(FLAGS)("defaults %s to its shipped state", (flag) => {
    delete process.env[flag];
    expect(cuaTimingLogEnabled()).toBe(false);
    // Graduated flags ship on; the env var is now only a kill switch.
    expect(cuaConditionalSettleEnabled()).toBe(true);
    expect(cuaCaptureReuseEnabled()).toBe(true);
    expect(cuaActionSettleMsOverride()).toBeUndefined();
    expect(cuaPreviewStillMsOverride()).toBeUndefined();
  });

  it.each(["1", "true", "on", "yes", " TRUE ", "On"])(
    "treats %s as enabled for the boolean flags",
    (value) => {
      process.env.SYNARA_CUA_TIMING_LOG = value;
      process.env.SYNARA_CUA_CONDITIONAL_SETTLE = value;
      process.env.SYNARA_CUA_CAPTURE_REUSE = value;
      expect(cuaTimingLogEnabled()).toBe(true);
      expect(cuaConditionalSettleEnabled()).toBe(true);
      expect(cuaCaptureReuseEnabled()).toBe(true);
    },
  );

  it.each(["0", "false", "off", "no"])(
    "treats %s as disabled for the graduated flags' kill switch",
    (value) => {
      process.env.SYNARA_CUA_CONDITIONAL_SETTLE = value;
      process.env.SYNARA_CUA_CAPTURE_REUSE = value;
      expect(cuaConditionalSettleEnabled()).toBe(false);
      expect(cuaCaptureReuseEnabled()).toBe(false);
    },
  );

  it.each(["0", "false", "off", "no", "2", "enabled"])(
    "treats %s as disabled for the opt-in boolean flags",
    (value) => {
      process.env.SYNARA_CUA_TIMING_LOG = value;
      expect(cuaTimingLogEnabled()).toBe(false);
    },
  );

  it.each(["2", "enabled", "anything"])(
    "keeps the graduated flags on for a non-off value like %s",
    (value) => {
      process.env.SYNARA_CUA_CONDITIONAL_SETTLE = value;
      process.env.SYNARA_CUA_CAPTURE_REUSE = value;
      expect(cuaConditionalSettleEnabled()).toBe(true);
      expect(cuaCaptureReuseEnabled()).toBe(true);
    },
  );

  it("parses SYNARA_CUA_ACTION_SETTLE_MS as a non-negative number", () => {
    process.env.SYNARA_CUA_ACTION_SETTLE_MS = "0";
    expect(cuaActionSettleMsOverride()).toBe(0);
    process.env.SYNARA_CUA_ACTION_SETTLE_MS = "175";
    expect(cuaActionSettleMsOverride()).toBe(175);
    process.env.SYNARA_CUA_ACTION_SETTLE_MS = " 80 ";
    expect(cuaActionSettleMsOverride()).toBe(80);
  });

  it.each(["", "   ", "abc", "-5", "NaN"])(
    "ignores the unparsable SYNARA_CUA_ACTION_SETTLE_MS value %s",
    (value) => {
      process.env.SYNARA_CUA_ACTION_SETTLE_MS = value;
      expect(cuaActionSettleMsOverride()).toBeUndefined();
    },
  );

  it("parses SYNARA_CUA_PREVIEW_STILL_MS as a positive number", () => {
    process.env.SYNARA_CUA_PREVIEW_STILL_MS = "4000";
    expect(cuaPreviewStillMsOverride()).toBe(4000);
    process.env.SYNARA_CUA_PREVIEW_STILL_MS = " 250 ";
    expect(cuaPreviewStillMsOverride()).toBe(250);
  });

  it.each(["", "abc", "0", "-100", "NaN"])(
    "ignores the unparsable SYNARA_CUA_PREVIEW_STILL_MS value %s",
    (value) => {
      process.env.SYNARA_CUA_PREVIEW_STILL_MS = value;
      expect(cuaPreviewStillMsOverride()).toBeUndefined();
    },
  );
});

describe("createComputerCallContext", () => {
  it("creates no context at all when both consumers are off", () => {
    delete process.env.SYNARA_CUA_TIMING_LOG;
    process.env.SYNARA_CUA_CONDITIONAL_SETTLE = "0";
    expect(createComputerCallContext()).toBeUndefined();
  });

  it("creates a context with a timing record under SYNARA_CUA_TIMING_LOG", () => {
    process.env.SYNARA_CUA_TIMING_LOG = "1";
    expect(createComputerCallContext()?.timing).toBeInstanceOf(ComputerCallTiming);
  });

  it("creates a context without a timing record under SYNARA_CUA_CONDITIONAL_SETTLE alone", () => {
    process.env.SYNARA_CUA_CONDITIONAL_SETTLE = "1";
    const context = createComputerCallContext();
    expect(context).toBeDefined();
    expect(context?.timing).toBeUndefined();
  });
});

describe("ComputerCallContext", () => {
  it("hands the action proof to the post-action observer exactly once", () => {
    process.env.SYNARA_CUA_CONDITIONAL_SETTLE = "1";
    const context = createComputerCallContext()!;
    context.recordActionProof({ effect: "verified", verified: "confirmed" });
    expect(context.takeActionProof()).toEqual({
      effect: "verified",
      verified: "confirmed",
    });
    expect(context.takeActionProof()).toBeUndefined();
  });

  it("keeps only the latest action's verdict", () => {
    process.env.SYNARA_CUA_CONDITIONAL_SETTLE = "1";
    const context = createComputerCallContext()!;
    context.recordActionProof({ effect: "verified" });
    context.recordActionProof({ effect: "dispatched-unknown" });
    expect(context.takeActionProof()).toEqual({ effect: "dispatched-unknown" });
  });

  it("shares one context across a whole wrapped call and finishes it once", async () => {
    process.env.SYNARA_CUA_TIMING_LOG = "1";
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const context = createComputerCallContext()!;
    let inside: unknown;
    await withComputerCallContext(context, async () => {
      inside = currentComputerCall();
      markComputerCall("computer_click");
      await timedComputerLeg("dispatch", async () => {});
      await timedComputerLeg("settle", async () => {});
      context.timing?.count("settle_skipped");
      context.timing?.finish();
      context.timing?.finish();
    });
    expect(inside).toBe(context);
    expect(currentComputerCall()).toBeUndefined();
    const lines = info.mock.calls.map((call) => String(call[0]));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[computer-timing]");
    expect(lines[0]).toContain("op=computer_click");
    expect(lines[0]).toContain("dispatch_ms=");
    expect(lines[0]).toContain("settle_ms=");
    expect(lines[0]).toContain("settle_skipped=1");
    expect(lines[0]).toContain("total_ms=");
    expect(lines[0]).not.toContain("failed=1");
  });

  it("timedComputerLeg is a passthrough outside a call context", async () => {
    expect(currentComputerCall()).toBeUndefined();
    await expect(timedComputerLeg("dispatch", async () => 7)).resolves.toBe(7);
  });

  it("marks failures on the call's timing line", async () => {
    process.env.SYNARA_CUA_TIMING_LOG = "1";
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const context = createComputerCallContext()!;
    await expect(
      withComputerCallContext(context, async () => {
        context.timing?.markFailed();
        context.timing?.finish();
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(String(info.mock.calls[0]?.[0])).toContain("failed=1");
  });
});
