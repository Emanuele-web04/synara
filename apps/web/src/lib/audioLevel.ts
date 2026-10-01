// FILE: audioLevel.ts
// Purpose: Shared, ref-counted subscription to the desktop's audio level
//   (the Mac's audio output, the microphone, or both).
// Layer: Web runtime helper (desktop bridge consumer)
// Exports: AUDIO_LEVEL_SUBSCRIBERS, isAudioLevelAvailable

import type { DesktopAudioLevelSource } from "@synara/contracts";
import { AUDIO_TRAIL_BETA_FEATURE } from "@synara/shared/betaFeatures";
import { isBetaFeatureOn } from "~/betaFeatures";
import { isMacNavigatorPlatform } from "./utils";

type LevelListener = (level: number) => void;

const listeners = new Map<LevelListener, DesktopAudioLevelSource>();
let stopBridgeListener: (() => void) | null = null;
let sourceOnDesktop: DesktopAudioLevelSource | null = null;
let releaseTimer: ReturnType<typeof setTimeout> | null = null;

// Remounts (thread switches, layout changes) drop and re-add the only listener
// within a frame; waiting before release keeps the native reader from restarting.
const RELEASE_DELAY_MS = 1_000;

/**
 * Whether this host can stream audio levels at all. The desktop main process
 * re-checks platform and flavor, so this only hides entry points.
 */
export function isAudioLevelAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    isMacNavigatorPlatform() &&
    window.desktopBridge?.audioLevel !== undefined &&
    isBetaFeatureOn(AUDIO_TRAIL_BETA_FEATURE)
  );
}

// The newest subscriber's source wins; every subscriber reads the same setting.
function wantedSource(): DesktopAudioLevelSource | null {
  if (document.visibilityState !== "visible") return null;
  let source: DesktopAudioLevelSource | null = null;
  for (const current of listeners.values()) source = current;
  return source;
}

// The desktop only reads audio while a visible window wants it, so a hidden or
// minimized Synara releases the audio tap and microphone (and their indicators).
function syncDesktopSubscription(): void {
  if (!window.desktopBridge?.audioLevel) return;
  const wanted = wantedSource();
  if (releaseTimer) {
    clearTimeout(releaseTimer);
    releaseTimer = null;
  }
  if (wanted === sourceOnDesktop) return;
  if (wanted) {
    setDesktopSource(wanted);
    return;
  }
  for (const listener of listeners.keys()) listener(0);
  // Hiding the window releases at once; losing the last listener waits a beat.
  if (document.visibilityState !== "visible") setDesktopSource(null);
  else releaseTimer = setTimeout(() => setDesktopSource(null), RELEASE_DELAY_MS);
}

function setDesktopSource(source: DesktopAudioLevelSource | null): void {
  releaseTimer = null;
  sourceOnDesktop = source;
  void window.desktopBridge?.audioLevel?.setSource(source).catch(() => {
    sourceOnDesktop = null;
  });
}

/** Streams levels (0..1) from `source` to `listener` until the returned function is called. */
function subscribeAudioLevel(source: DesktopAudioLevelSource, listener: LevelListener): () => void {
  const bridge = window.desktopBridge?.audioLevel;
  if (!bridge || !isAudioLevelAvailable()) return () => undefined;

  listeners.set(listener, source);
  if (!stopBridgeListener) {
    const stopLevels = bridge.onLevel((level) => {
      for (const current of listeners.keys()) current(level);
    });
    document.addEventListener("visibilitychange", syncDesktopSubscription);
    stopBridgeListener = () => {
      stopLevels();
      document.removeEventListener("visibilitychange", syncDesktopSubscription);
    };
  }
  syncDesktopSubscription();

  return () => {
    if (!listeners.delete(listener)) return;
    syncDesktopSubscription();
    if (listeners.size === 0) {
      stopBridgeListener?.();
      stopBridgeListener = null;
    }
  };
}

/**
 * One stable subscribe function per source, so a component can pass it as a
 * prop without re-subscribing (and restarting the native reader) every render.
 */
export const AUDIO_LEVEL_SUBSCRIBERS: Record<
  DesktopAudioLevelSource,
  (listener: LevelListener) => () => void
> = {
  system: (listener) => subscribeAudioLevel("system", listener),
  microphone: (listener) => subscribeAudioLevel("microphone", listener),
  both: (listener) => subscribeAudioLevel("both", listener),
};
