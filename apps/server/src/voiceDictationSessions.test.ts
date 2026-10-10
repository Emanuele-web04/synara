// FILE: voiceDictationSessions.test.ts
// Purpose: Verifies live dictation session routing, capacity, and audio validation.
// Layer: Server test
// Exports: Vitest cases
// Depends on: voiceDictationSessions registry.

import { describe, expect, it, vi } from "vitest";

import type { VoiceDictationSession } from "./provider/Services/ProviderAdapter.ts";
import {
  VOICE_DICTATION_CAPACITY_ERROR_MESSAGE,
  VOICE_DICTATION_SESSION_GONE_MESSAGE,
  VoiceDictationSessionRegistry,
} from "./voiceDictationSessions";

function makeSession() {
  return {
    appendAudio: vi.fn<VoiceDictationSession["appendAudio"]>(),
    finish: vi.fn<VoiceDictationSession["finish"]>(),
    close: vi.fn<VoiceDictationSession["close"]>(),
  };
}

describe("VoiceDictationSessionRegistry", () => {
  it("routes audio and finish calls to the registered session", () => {
    const registry = new VoiceDictationSessionRegistry(2);
    const session = makeSession();
    const sessionId = registry.register(session);

    registry.appendAudio(sessionId, Buffer.from([1, 0, 2, 0]).toString("base64"));
    registry.finish(sessionId);

    expect(Array.from(session.appendAudio.mock.calls[0]?.[0] ?? [])).toEqual([1, 0, 2, 0]);
    expect(session.finish).toHaveBeenCalledOnce();
  });

  it("closes released sessions and refuses later calls", () => {
    const registry = new VoiceDictationSessionRegistry(2);
    const session = makeSession();
    const sessionId = registry.register(session);

    registry.release(sessionId);

    expect(session.close).toHaveBeenCalledOnce();
    expect(() => registry.finish(sessionId)).toThrow(VOICE_DICTATION_SESSION_GONE_MESSAGE);
    expect(() => registry.appendAudio("unknown", "AAAA")).toThrow(
      VOICE_DICTATION_SESSION_GONE_MESSAGE,
    );
  });

  it("bounds concurrent sessions", () => {
    const registry = new VoiceDictationSessionRegistry(1);
    const first = registry.register(makeSession());

    expect(registry.hasCapacity()).toBe(false);
    expect(() => registry.register(makeSession())).toThrow(VOICE_DICTATION_CAPACITY_ERROR_MESSAGE);

    registry.release(first);
    expect(registry.hasCapacity()).toBe(true);
  });

  it("rejects audio that is not whole 16-bit samples or not base64", () => {
    const registry = new VoiceDictationSessionRegistry(1);
    const session = makeSession();
    const sessionId = registry.register(session);

    expect(() =>
      registry.appendAudio(sessionId, Buffer.from([1, 2, 3]).toString("base64")),
    ).toThrow("16-bit PCM");
    expect(() => registry.appendAudio(sessionId, "not base64!")).toThrow("could not be decoded");
    expect(session.appendAudio).not.toHaveBeenCalled();
  });
});
