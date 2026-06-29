import { describe, expect, it } from "vitest";

import {
  composerActionDisabled,
  composerActionLabel,
  composerModeForScenario,
  composerPlaceholderForState,
} from "./TranscriptStateComposer.logic";
import { buildTranscriptScenarioState } from "./transcriptStateFixtures";

describe("TranscriptStateComposer logic", () => {
  it("renders completed turns as ready instead of waiting", () => {
    const state = buildTranscriptScenarioState("completed", 22);
    const mode = composerModeForScenario(state);

    expect(mode).toBe("ready");
    expect(composerPlaceholderForState(mode, state)).toBe("Ask the next question");
    expect(composerActionLabel(mode, state)).toBe("Send");
    expect(composerActionDisabled(mode)).toBe(false);
  });

  it("renders stopped turns as ready recovery instead of provider failure", () => {
    const state = buildTranscriptScenarioState("cancelled", 7);
    const mode = composerModeForScenario(state);

    expect(mode).toBe("ready");
    expect(composerPlaceholderForState(mode, state)).toBe(
      "Turn stopped. Ask again or edit the previous prompt.",
    );
    expect(composerActionLabel(mode, state)).toBe("Ask again");
    expect(composerActionDisabled(mode)).toBe(false);
  });

  it("names provider waits before the first token", () => {
    const reconnect = buildTranscriptScenarioState("reconnect", 16);
    const reconnectMode = composerModeForScenario(reconnect);
    const rateLimit = buildTranscriptScenarioState("rate-limit", 24);
    const rateLimitMode = composerModeForScenario(rateLimit);

    expect(reconnectMode).toBe("reconnecting");
    expect(composerPlaceholderForState(reconnectMode, reconnect)).toBe(
      "Reconnecting to the provider session",
    );
    expect(composerActionLabel(reconnectMode, reconnect)).toBe("Reconnecting");
    expect(composerActionDisabled(reconnectMode)).toBe(true);
    expect(rateLimitMode).toBe("rate-limited");
    expect(composerPlaceholderForState(rateLimitMode, rateLimit)).toBe(
      "Waiting on provider capacity",
    );
    expect(composerActionLabel(rateLimitMode, rateLimit)).toBe("Waiting on capacity");
    expect(composerActionDisabled(rateLimitMode)).toBe(true);
  });

  it("does not show the rate-limit composer state before capacity wait is visible", () => {
    const state = buildTranscriptScenarioState("rate-limit", 1);

    expect(composerModeForScenario(state)).toBe("busy");
    expect(composerPlaceholderForState("busy", state)).toBe(
      "Waiting for first visible agent output",
    );
  });
});
