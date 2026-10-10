// FILE: appSnapSound.ts
// Purpose: Synthesized camera-shutter cue for AppSnap captures (Web Audio, no bundled asset).
// Layer: Web UI support
// Exports: playAppSnapCaptureSound

const NOISE_BUFFER_SECONDS = 0.2;

let sharedContext: AudioContext | null = null;
let sharedNoiseBuffer: AudioBuffer | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof AudioContext === "undefined") return null;
  if (!sharedContext || sharedContext.state === "closed") {
    sharedContext = new AudioContext();
    sharedNoiseBuffer = null;
  }
  return sharedContext;
}

function getNoiseBuffer(context: AudioContext): AudioBuffer {
  if (!sharedNoiseBuffer || sharedNoiseBuffer.sampleRate !== context.sampleRate) {
    const frameCount = Math.ceil(context.sampleRate * NOISE_BUFFER_SECONDS);
    sharedNoiseBuffer = context.createBuffer(1, frameCount, context.sampleRate);
    const samples = sharedNoiseBuffer.getChannelData(0);
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = Math.random() * 2 - 1;
    }
  }
  return sharedNoiseBuffer;
}

// One mechanical "click": a band-passed noise burst with a fast exponential decay.
function scheduleClick(
  context: AudioContext,
  at: number,
  options: { frequencyHz: number; peakGain: number; durationSeconds: number },
): void {
  const noise = context.createBufferSource();
  noise.buffer = getNoiseBuffer(context);

  const filter = context.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = options.frequencyHz;
  filter.Q.value = 1.4;

  const envelope = context.createGain();
  envelope.gain.setValueAtTime(options.peakGain, at);
  envelope.gain.exponentialRampToValueAtTime(0.0001, at + options.durationSeconds);

  noise.connect(filter);
  filter.connect(envelope);
  envelope.connect(context.destination);
  noise.start(at);
  noise.stop(at + options.durationSeconds);
}

/**
 * Play the AppSnap shutter cue: two short clicks (curtain open, curtain close),
 * quiet enough to sit under system alert sounds. Resolves once playback is
 * scheduled; failures resolve silently so a muted or missing audio device can
 * never break capture delivery.
 */
export async function playAppSnapCaptureSound(): Promise<void> {
  try {
    const context = getAudioContext();
    if (!context) return;
    if (context.state === "suspended") {
      await context.resume();
    }
    const at = context.currentTime + 0.02;
    scheduleClick(context, at, { frequencyHz: 4200, peakGain: 0.16, durationSeconds: 0.04 });
    scheduleClick(context, at + 0.07, { frequencyHz: 1700, peakGain: 0.24, durationSeconds: 0.07 });
  } catch (error) {
    console.warn("[appsnap] Could not play the capture sound", error);
  }
}
