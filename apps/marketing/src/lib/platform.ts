export type OS = "mac" | "windows" | "linux" | "unknown";
export type MacArch = "arm64" | "x64";

// kept pure so it can run on the server for an initial guess and on the client for real detection
export function detectOS(userAgent: string, platform: string): OS {
  const fingerprint = `${userAgent} ${platform}`.toLowerCase();

  // Phones/tablets can't run a desktop installer — don't pretend to recommend one.
  if (/iphone|ipad|ipod|android/.test(fingerprint)) return "unknown";

  if (fingerprint.includes("mac")) return "mac";
  if (fingerprint.includes("win")) return "windows";
  if (fingerprint.includes("linux") || fingerprint.includes("x11")) return "linux";

  return "unknown";
}

export function detectCurrentOS(): OS {
  if (typeof navigator === "undefined") return "unknown";
  const withUaData = navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  return detectOS(navigator.userAgent, withUaData.userAgentData?.platform ?? navigator.platform);
}

// browsers don't expose CPU arch — sniff the WebGL renderer string (Apple GPU = Silicon, Intel/AMD/Radeon = Intel); default to Silicon since it's most new Macs and the UI offers Intel anyway
export function detectMacArch(): MacArch {
  if (typeof document === "undefined") return "arm64";

  try {
    const canvas = document.createElement("canvas");
    const gl = (canvas.getContext("webgl") ||
      canvas.getContext("experimental-webgl")) as WebGLRenderingContext | null;
    if (!gl) return "arm64";

    const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = debugInfo
      ? String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) ?? "")
      : "";

    if (/intel|amd|radeon/i.test(renderer)) return "x64";
    return "arm64";
  } catch {
    return "arm64";
  }
}
