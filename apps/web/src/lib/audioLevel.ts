// FILE: audioLevel.ts
// Purpose: Shared, ref-counted subscription to the desktop's audio level
//   (the Mac's audio output, the microphone, or both).
// Layer: Web runtime helper (desktop bridge consumer)
// Exports: getAudioLevelSubscriber, isAudioLevelAvailable

import type { DesktopAudioLevelSource } from "@synara/contracts";
import { AUDIO_TRAIL_BETA_FEATURE } from "@synara/shared/betaFeatures";
import { isBetaFeatureOn } from "~/betaFeatures";
import { isMacNavigatorPlatform } from "./utils";

type LevelListener = (level: number) => void;
type LevelSubscriber = (listener: LevelListener) => () => void;

/** A source plus, for the microphone, the Core Audio UID ("" = Mac default input). */
interface AudioLevelRequest {
  source: DesktopAudioLevelSource;
  microphoneId: string;
}

const listeners = new Map<LevelListener, AudioLevelRequest>();
let stopBridgeListener: (() => void) | null = null;
let requestOnDesktop: AudioLevelRequest | null = null;
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

// The newest subscriber's request wins; every subscriber reads the same settings.
function wantedRequest(): AudioLevelRequest | null {
  if (document.visibilityState !== "visible") return null;
  let request: AudioLevelRequest | null = null;
  for (const current of listeners.values()) request = current;
  return request;
}

function sameRequest(left: AudioLevelRequest | null, right: AudioLevelRequest | null): boolean {
  return left?.source === right?.source && left?.microphoneId === right?.microphoneId;
}

// The desktop only reads audio while a visible window wants it, so a hidden or
// minimized Synara releases the audio tap and microphone (and their indicators).
function syncDesktopSubscription(): void {
  if (!window.desktopBridge?.audioLevel) return;
  const wanted = wantedRequest();
  if (releaseTimer) {
    clearTimeout(releaseTimer);
    releaseTimer = null;
  }
  if (sameRequest(wanted, requestOnDesktop)) return;
  if (wanted) {
    setDesktopRequest(wanted);
    return;
  }
  for (const listener of listeners.keys()) listener(0);
  // Hiding the window releases at once; losing the last listener waits a beat.
  if (document.visibilityState !== "visible") setDesktopRequest(null);
  else releaseTimer = setTimeout(() => setDesktopRequest(null), RELEASE_DELAY_MS);
}

function setDesktopRequest(request: AudioLevelRequest | null): void {
  releaseTimer = null;
  requestOnDesktop = request;
  const audioLevel = window.desktopBridge?.audioLevel;
  const pending = request
    ? request.source === "system" || !request.microphoneId
      ? audioLevel?.setSource(request.source)
      : audioLevel?.setSource(request.source, request.microphoneId)
    : audioLevel?.setSource(null);
  void pending?.catch(() => {
    requestOnDesktop = null;
  });
}

/** Streams levels (0..1) for `request` to `listener` until the returned function is called. */
function subscribeAudioLevel(request: AudioLevelRequest, listener: LevelListener): () => void {
  const bridge = window.desktopBridge?.audioLevel;
  if (!bridge || !isAudioLevelAvailable()) return () => undefined;

  listeners.set(listener, request);
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

const subscriberCache = new Map<string, LevelSubscriber>();

/**
 * One stable subscribe function per source and microphone, so a component can
 * pass it as a prop without re-subscribing (and restarting the native reader)
 * every render. `microphoneId` is a Core Audio UID; "" follows the Mac default.
 */
export function getAudioLevelSubscriber(
  source: DesktopAudioLevelSource,
  microphoneId = "",
): LevelSubscriber {
  // The Mac's audio output ignores the microphone choice.
  const request: AudioLevelRequest = {
    source,
    microphoneId: source === "system" ? "" : microphoneId,
  };
  const key = `${request.source}\u0000${request.microphoneId}`;
  let subscriber = subscriberCache.get(key);
  if (!subscriber) {
    subscriber = (listener) => subscribeAudioLevel(request, listener);
    subscriberCache.set(key, subscriber);
  }
  return subscriber;
}
