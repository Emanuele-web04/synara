import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "vitest-browser-react";

import { isVoiceRecordingCancelledError, useVoiceRecorder } from "./voiceRecorder";

describe("useVoiceRecorder", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not activate recording after cancellation during AudioContext resume", async () => {
    let resolveResume!: () => void;
    const resume = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveResume = resolve;
        }),
    );
    const close = vi.fn(async () => undefined);

    class DeferredAudioContext {
      readonly resume = resume;
      readonly close = close;
    }

    const stopTrack = vi.fn();
    const stream = {
      getTracks: () => [{ stop: stopTrack }],
    } as unknown as MediaStream;
    vi.spyOn(navigator.mediaDevices, "getUserMedia").mockResolvedValue(stream);
    vi.stubGlobal("AudioContext", DeferredAudioContext);

    const hook = await renderHook(() => useVoiceRecorder());
    const starting = hook.result.current.startRecording();
    await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1));

    await hook.result.current.cancelRecording();
    resolveResume();

    await expect(starting).rejects.toSatisfy(isVoiceRecordingCancelledError);
    expect(hook.result.current.isRecording).toBe(false);
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);

    await hook.unmount();
  });

  it("waits for real signal before going live and drops warm-up silence", async () => {
    let processor!: { onaudioprocess: ((event: unknown) => void) | null };
    const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });

    class FakeAudioContext {
      readonly sampleRate = 24_000;
      readonly destination = {};
      readonly resume = vi.fn(async () => undefined);
      readonly close = vi.fn(async () => undefined);
      createMediaStreamSource() {
        return node();
      }
      createScriptProcessor() {
        processor = { ...node(), onaudioprocess: null };
        return processor;
      }
      createGain() {
        return { ...node(), gain: { value: 1 } };
      }
    }

    const stream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
    vi.spyOn(navigator.mediaDevices, "getUserMedia").mockResolvedValue(stream);
    vi.stubGlobal("AudioContext", FakeAudioContext);
    const frame = (value: number) => {
      const samples = new Float32Array(2_048).fill(value);
      processor.onaudioprocess?.({
        inputBuffer: { numberOfChannels: 1, length: samples.length, getChannelData: () => samples },
      });
    };

    const hook = await renderHook(() => useVoiceRecorder());
    await hook.result.current.startRecording();
    await vi.waitFor(() => expect(hook.result.current.isRecording).toBe(true));
    expect(hook.result.current.isStarting).toBe(false);

    frame(0);
    frame(0);
    await hook.rerender();
    expect(hook.result.current.hasAudioSignal).toBe(false);
    expect(hook.result.current.waveformLevels).toEqual([]);

    frame(0.25);
    await vi.waitFor(() => expect(hook.result.current.hasAudioSignal).toBe(true));
    frame(0);

    const payload = await hook.result.current.stopRecording();
    // Only the signal frame and the silence after it are kept: 2 x 2048 samples.
    expect(payload?.durationMs).toBeCloseTo((2 * 2_048 * 1_000) / 24_000, 0);
    expect(hook.result.current.hasAudioSignal).toBe(false);

    await hook.unmount();
  });

  it("returns no clip when the device never delivers audio", async () => {
    let processor!: { onaudioprocess: ((event: unknown) => void) | null };
    const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });

    class SilentAudioContext {
      readonly sampleRate = 24_000;
      readonly destination = {};
      readonly resume = vi.fn(async () => undefined);
      readonly close = vi.fn(async () => undefined);
      createMediaStreamSource() {
        return node();
      }
      createScriptProcessor() {
        processor = { ...node(), onaudioprocess: null };
        return processor;
      }
      createGain() {
        return { ...node(), gain: { value: 1 } };
      }
    }

    const stream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
    vi.spyOn(navigator.mediaDevices, "getUserMedia").mockResolvedValue(stream);
    vi.stubGlobal("AudioContext", SilentAudioContext);

    const hook = await renderHook(() => useVoiceRecorder());
    await hook.result.current.startRecording();
    const silence = new Float32Array(2_048);
    processor.onaudioprocess?.({
      inputBuffer: { numberOfChannels: 1, length: silence.length, getChannelData: () => silence },
    });

    await expect(hook.result.current.stopRecording()).resolves.toBeNull();

    await hook.unmount();
  });
});
