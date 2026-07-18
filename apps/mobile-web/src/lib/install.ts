import { useCallback, useEffect, useState } from "react";

export interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

interface PlatformDescription {
  readonly userAgent: string;
  readonly platform: string;
  readonly maxTouchPoints: number;
}

interface DisplayDescription {
  readonly displayModeStandalone: boolean;
  readonly navigatorStandalone?: boolean | undefined;
}

let capturedInstallPrompt: InstallPromptEvent | null = null;
const promptListeners = new Set<(prompt: InstallPromptEvent | null) => void>();

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    capturedInstallPrompt = event as InstallPromptEvent;
    for (const listener of promptListeners) listener(capturedInstallPrompt);
  });
}

export function useInstallPrompt() {
  const [installPrompt, setInstallPrompt] = useState(capturedInstallPrompt);

  useEffect(() => {
    promptListeners.add(setInstallPrompt);
    return () => {
      promptListeners.delete(setInstallPrompt);
    };
  }, []);

  const clearInstallPrompt = useCallback(() => {
    capturedInstallPrompt = null;
    for (const listener of promptListeners) listener(null);
  }, []);

  return { installPrompt, clearInstallPrompt } as const;
}

export function isIosPlatform(input: PlatformDescription): boolean {
  return (
    /iPad|iPhone|iPod/i.test(input.userAgent) ||
    (input.platform === "MacIntel" && input.maxTouchPoints > 1)
  );
}

export function isStandaloneDisplay(input: DisplayDescription): boolean {
  return input.displayModeStandalone || input.navigatorStandalone === true;
}

export function isCurrentDeviceIos(): boolean {
  return isIosPlatform({
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
  });
}

export function isCurrentDisplayStandalone(): boolean {
  return isStandaloneDisplay({
    displayModeStandalone: window.matchMedia("(display-mode: standalone)").matches,
    navigatorStandalone: (navigator as Navigator & { readonly standalone?: boolean }).standalone,
  });
}
